import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Realtime DELETE guard (migration 065). Supabase Realtime never applies row level
// security to DELETE events, so the `supabase_realtime` publication must not publish
// them, and the app must not subscribe to them (it uses deletion signals instead).
// These checks are static and run on every PR; the live behaviour (no DELETE event for
// anyone, signals scoped per tenant) is asserted by supabase/tests/database/100_realtime
// and the full-stack job.
// ---------------------------------------------------------------------------

const ROOT = process.cwd()

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
const SOURCES = walk(join(ROOT, 'src')).map((p) => ({
  path: relative(ROOT, p).split(sep).join('/'),
  text: readFileSync(p, 'utf8'),
}))

const MIGRATIONS = readdirSync(join(ROOT, 'supabase', 'migrations'))
  .filter((n) => n.endsWith('.sql'))
  .sort()
  .map((n) => ({ name: n, text: readFileSync(join(ROOT, 'supabase', 'migrations', n), 'utf8') }))

/** Tables the publication is reviewed to contain (also asserted in 100_realtime.test.sql). */
const REVIEWED_PUBLISHED = new Set([
  'messages',
  'conversations',
  'message_reactions',
  'notifications',
  'member_presence',
  'flow_runs',
  'realtime_deletions',
])

describe('Realtime: no DELETE events', () => {
  it('sees the source tree and migrations (guards against a vacuous pass)', () => {
    expect(SOURCES.length).toBeGreaterThan(200)
    expect(MIGRATIONS.length).toBeGreaterThan(60)
    expect(SOURCES.filter((f) => /postgres_changes/.test(f.text)).length).toBeGreaterThanOrEqual(6)
  })

  it('no module subscribes to postgres_changes DELETE events', () => {
    const offenders = SOURCES.filter((f) => /event:\s*['"]DELETE['"]/.test(f.text)).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('the last migration that sets the publication operations publishes INSERT and UPDATE only', () => {
    const sets = MIGRATIONS.flatMap((m) =>
      [...m.text.matchAll(/ALTER\s+PUBLICATION\s+supabase_realtime\s+SET\s*\(\s*publish\s*=\s*'([^']*)'\s*\)/gi)].map(
        (x) => ({ migration: m.name, ops: x[1].replace(/\s+/g, '').toLowerCase() }),
      ),
    )
    expect(sets.length).toBeGreaterThan(0)
    expect(sets[sets.length - 1]).toEqual({ migration: '065_realtime_deletion_signals.sql', ops: 'insert,update' })
  })

  it('every table added to the publication is in the reviewed set', () => {
    const added = new Set<string>()
    for (const m of MIGRATIONS) {
      for (const x of m.text.matchAll(/ALTER\s+PUBLICATION\s+supabase_realtime\s+ADD\s+TABLE\s+(?:public\.)?([a-z_]+)/gi)) {
        added.add(x[1].toLowerCase())
      }
    }
    expect([...added].filter((t) => !REVIEWED_PUBLISHED.has(t))).toEqual([])
    expect(added.has('realtime_deletions')).toBe(true)
  })

  it('every table the app subscribes to is a published, reviewed table', () => {
    const tables = new Set<string>()
    for (const f of SOURCES) {
      for (const m of f.text.matchAll(/table:\s*["'`]([a-z_]+)["'`]/g)) {
        // only tables used in postgres_changes configs (they sit next to `schema: "public"`)
        const around = f.text.slice(Math.max(0, m.index! - 120), m.index! + 120)
        if (/schema:\s*["']public["']/.test(around)) tables.add(m[1])
      }
    }
    expect(tables.size).toBeGreaterThanOrEqual(5)
    expect([...tables].filter((t) => !REVIEWED_PUBLISHED.has(t))).toEqual([])
  })

  it('the deletion-signal consumers subscribe through the shared INSERT-only config', () => {
    for (const p of [
      'src/hooks/use-realtime.ts',
      'src/hooks/use-total-unread.ts',
      'src/hooks/use-unread-notifications.ts',
      'src/hooks/use-presence.ts',
      'src/components/inbox/message-thread.tsx',
      'src/app/(dashboard)/notifications/page.tsx',
    ]) {
      const f = SOURCES.find((x) => x.path === p)
      expect(f, p).toBeDefined()
      expect(f!.text, p).toMatch(/DELETION_CHANGES/)
    }
  })

  it('the detector flags a DELETE subscription (guards against a broken regex)', () => {
    const bad = `.on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, cb)`
    expect(/event:\s*['"]DELETE['"]/.test(bad)).toBe(true)
    expect(/event:\s*['"]DELETE['"]/.test(`{ event: "INSERT", schema: "public" }`)).toBe(false)
  })
})
