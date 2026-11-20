import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

import { CREDENTIAL_COLUMNS } from './server'

// ---------------------------------------------------------------------------
// F1 source guards. Migration 063 makes the credential columns unreadable for
// the `authenticated` role, so any code that selects them through a user-scoped
// client would break at runtime. These static checks catch that at review time
// and keep a future refactor from re-introducing the exposure:
//   1. only an explicit allowlist of SERVER modules may select a credential
//      column (or `*`) from a credential table;
//   2. no browser module may import the server-only credentials module or name
//      a secret column in a query.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src')
const TABLES = Object.keys(CREDENTIAL_COLUMNS) as (keyof typeof CREDENTIAL_COLUMNS)[]

/**
 * Server modules that legitimately read secret columns. Each one runs with the
 * service-role client (never a user session) or IS the credentials reader.
 */
const SERVER_SECRET_READERS = new Map<string, string>([
  ['src/lib/credentials/server.ts', 'the server-only credentials reader'],
  ['src/app/api/whatsapp/webhook/route.ts', 'Meta webhook: service-role client, signature-verified'],
  ['src/lib/automations/meta-send.ts', 'automation engine: service-role client'],
  ['src/lib/flows/meta-send.ts', 'flow engine: service-role client'],
  ['src/lib/webhooks/deliver.ts', 'outbound webhook delivery: service-role client'],
  ['src/lib/api-keys/store.ts', 'API-key lookup by hash: service-role client'],
  ['src/lib/ai/config.ts', 'AI config loader: callers pass credentialsDb() or the engine admin client'],
])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const rel = (p: string) => relative(process.cwd(), p).split(sep).join('/')
const FILES = walk(SRC).map((p) => ({ path: rel(p), text: readFileSync(p, 'utf8') }))

interface Read {
  file: string
  table: string
  select: string
}

/** Every `.from('<credential table>')...select(<arg>)` in a file. */
function credentialSelects(file: { path: string; text: string }): Read[] {
  const out: Read[] = []
  for (const table of TABLES) {
    const re = new RegExp(String.raw`\.from\(\s*['"]${table}['"]\s*\)`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(file.text))) {
      // look only at the rest of this query chain (up to the next .from( or 600 chars)
      const rest = file.text.slice(m.index + m[0].length, m.index + m[0].length + 600)
      const cut = rest.search(/\.from\(/)
      const chain = cut === -1 ? rest : rest.slice(0, cut)
      const sel = /\.select\(\s*([^)]*?)\s*\)/.exec(chain)
      if (sel) out.push({ file: file.path, table, select: sel[1] })
    }
  }
  return out
}

function touchesSecret(table: keyof typeof CREDENTIAL_COLUMNS, select: string): boolean {
  if (/^['"`]\*['"`]$/.test(select) || select === '') return true
  return CREDENTIAL_COLUMNS[table].some((c) => new RegExp(String.raw`\b${c}\b`).test(select))
}

describe('F1: credential columns are read only on the server', () => {
  it('sees the source tree (guards against a vacuous pass)', () => {
    expect(FILES.length).toBeGreaterThan(100)
    expect(FILES.some((f) => f.path === 'src/lib/credentials/server.ts')).toBe(true)
  })

  it('the detector flags a violation (guards against a broken regex)', () => {
    const bad = {
      path: 'src/app/api/x/route.ts',
      text: [
        'const { data } = await supabase',
        "  .from('whatsapp_config')",
        "  .select('*')",
        "  .eq('account_id', a)",
      ].join('\n'),
    }
    const reads = credentialSelects(bad)
    expect(reads).toHaveLength(1)
    expect(touchesSecret('whatsapp_config', reads[0].select)).toBe(true)
    const named = credentialSelects({ ...bad, text: "supabase.from('ai_configs').select('provider, api_key')" })
    expect(touchesSecret('ai_configs', named[0].select)).toBe(true)
    const safe = credentialSelects({ ...bad, text: "supabase.from('ai_configs').select('provider, model')" })
    expect(touchesSecret('ai_configs', safe[0].select)).toBe(false)
  })

  it('no non-allowlisted module selects a credential column or * from a credential table', () => {
    const offenders = FILES.flatMap(credentialSelects)
      .filter((r) => touchesSecret(r.table as keyof typeof CREDENTIAL_COLUMNS, r.select))
      .filter((r) => !SERVER_SECRET_READERS.has(r.file))
      .map((r) => `${r.file}: ${r.table}.select(${r.select})`)
    expect(offenders).toEqual([])
  })

  it('every allowlisted reader is real and still needs its entry', () => {
    const present = new Set(FILES.map((f) => f.path))
    const stale = [...SERVER_SECRET_READERS.keys()].filter((p) => !present.has(p))
    expect(stale).toEqual([])
  })

  it('browser modules never import the server-only credentials module', () => {
    const isClient = (f: { path: string; text: string }) =>
      /^\s*['"]use client['"]/m.test(f.text) ||
      f.path.startsWith('src/components/') ||
      f.path.startsWith('src/hooks/')
    const offenders = FILES.filter(isClient)
      .filter((f) => /from\s+['"]@\/lib\/credentials\/server['"]/.test(f.text))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('browser modules never select a credential column or * from a credential table', () => {
    const isClient = (f: { path: string; text: string }) =>
      /^\s*['"]use client['"]/m.test(f.text) ||
      f.path.startsWith('src/components/') ||
      f.path.startsWith('src/hooks/')
    const offenders = FILES.filter(isClient)
      .flatMap(credentialSelects)
      .filter((r) => touchesSecret(r.table as keyof typeof CREDENTIAL_COLUMNS, r.select))
      .map((r) => `${r.file}: ${r.table}.select(${r.select})`)
    expect(offenders).toEqual([])
  })

  it('the client-safe column list contains no secret column', () => {
    const text = readFileSync(join(SRC, 'lib/credentials/public-columns.ts'), 'utf8')
    const list = /WHATSAPP_CONFIG_PUBLIC_COLUMNS =\s*['"`]([^'"`]*)['"`]/.exec(text)?.[1] ?? ''
    expect(list.length).toBeGreaterThan(10)
    for (const c of CREDENTIAL_COLUMNS.whatsapp_config) expect(list).not.toMatch(new RegExp(String.raw`\b${c}\b`))
  })
})
