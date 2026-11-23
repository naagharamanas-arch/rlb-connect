import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ROUTE_REGISTRY, type RouteRole } from './route-registry'

// ---------------------------------------------------------------------------
// Static authorization coverage for every HTTP route and every service-role
// code path. Source-level on purpose: it needs no database and runs in the
// normal unit-test job, so a route cannot be added without declaring how it is
// authenticated, and a handler cannot lose its guard unnoticed.
// Behavioural coverage (real sessions against a running stack) is the
// full-stack authorization job.
// ---------------------------------------------------------------------------

const APP = join(process.cwd(), 'src', 'app')
const SRC = join(process.cwd(), 'src')
const ROLE_ORDER: RouteRole[] = ['viewer', 'agent', 'admin', 'owner']

function walk(dir: string, match: (name: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, match, out)
    else if (match(name)) out.push(p)
  }
  return out
}
const posix = (base: string, p: string) => relative(base, p).split(sep).join('/')

const ROUTES = walk(APP, (n) => n === 'route.ts').map((p) => ({
  path: posix(APP, p),
  text: readFileSync(p, 'utf8'),
}))

/** Calls that establish who the caller is. */
const GUARD =
  /requireRole\(|requireApiKey\(|getCurrentAccount\(|CRON_SECRET|auth\.getUser\(|requireUser\(|requireOwnership\(|hub\.verify_token|x-hub-signature|verifySignature|HUB_SIGNATURE/i
const SERVICE_ROLE =
  /supabaseAdmin|credentialsDb|fetchWhatsAppConfig|fetchAiConfig|SUPABASE_SERVICE_ROLE_KEY|admin-client|media-server/

function detect(text: string) {
  const roles = [...new Set([...text.matchAll(/requireRole\(\s*['"](\w+)['"]/g)].map((m) => m[1]))] as RouteRole[]
  const auth = new Set<string>()
  if (roles.length) auth.add('role')
  if (/requireApiKey\(/.test(text)) auth.add('apikey')
  if (/getCurrentAccount\(/.test(text)) auth.add('member')
  if (/CRON_SECRET/.test(text)) auth.add('cron')
  if (/x-hub-signature|verifySignature|HUB_SIGNATURE/i.test(text)) auth.add('meta-signature')
  if (/auth\.getUser\(/.test(text) && auth.size === 0) auth.add('session')
  return { roles: roles.sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b)), auth }
}

/** Source of each exported HTTP handler (preamble helpers excluded). */
function handlers(text: string): { method: string; body: string }[] {
  const re = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g
  const hits = [...text.matchAll(re)]
  return hits.map((m, i) => ({
    method: m[1],
    body: text.slice(m.index!, i + 1 < hits.length ? hits[i + 1].index! : text.length),
  }))
}

describe('route registry', () => {
  it('sees the route tree (guards against a vacuous pass)', () => {
    expect(ROUTES.length).toBeGreaterThan(40)
  })

  it('every route file is registered — a new endpoint must declare its authentication', () => {
    const missing = ROUTES.map((r) => r.path).filter((p) => !(p in ROUTE_REGISTRY))
    expect(missing).toEqual([])
  })

  it('no registry entry is stale', () => {
    const present = new Set(ROUTES.map((r) => r.path))
    expect(Object.keys(ROUTE_REGISTRY).filter((p) => !present.has(p))).toEqual([])
  })

  it('every declaration matches the source (guard kinds, minimum roles, service-role use)', () => {
    const mismatches: string[] = []
    for (const r of ROUTES) {
      const rule = ROUTE_REGISTRY[r.path]
      if (!rule || rule.auth.includes('public')) continue
      const d = detect(r.text)
      const declared = [...rule.auth].sort().join(',')
      const found = [...d.auth].sort().join(',')
      if (declared !== found) mismatches.push(`${r.path}: auth declared [${declared}] but source has [${found}]`)
      const declaredRoles = (rule.roles ?? []).join(',')
      if (declaredRoles !== d.roles.join(',')) {
        mismatches.push(`${r.path}: roles declared [${declaredRoles}] but source has [${d.roles.join(',')}]`)
      }
      if (Boolean(rule.serviceRole) !== SERVICE_ROLE.test(r.text)) {
        mismatches.push(`${r.path}: serviceRole declared ${Boolean(rule.serviceRole)} but source says otherwise`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it('every exported handler of a non-public route authenticates the caller itself', () => {
    const unguarded: string[] = []
    for (const r of ROUTES) {
      const rule = ROUTE_REGISTRY[r.path]
      if (!rule || rule.auth.includes('public')) continue
      for (const h of handlers(r.text)) {
        if (!GUARD.test(h.body)) unguarded.push(`${r.path} ${h.method}`)
      }
    }
    expect(unguarded).toEqual([])
  })

  it('public routes are explicit, justified and never use the service role', () => {
    const publics = Object.entries(ROUTE_REGISTRY).filter(([, v]) => v.auth.includes('public'))
    expect(publics.map(([p]) => p).sort()).toEqual([
      'api/health/live/route.ts',
      'api/health/ready/route.ts',
      'api/invitations/[token]/peek/route.ts',
      'auth/callback/route.ts',
    ])
    for (const [p, rule] of publics) {
      expect(rule.reason, p).toBeTruthy()
      expect(rule.auth, p).toEqual(['public'])
      expect(rule.serviceRole, p).toBeFalsy()
    }
  })

  it('the detector flags an unguarded handler (guards against a broken regex)', () => {
    const bad = 'export async function POST(req: Request) { return Response.json({}) }'
    expect(handlers(bad).every((h) => !GUARD.test(h.body))).toBe(true)
    const good = "export async function POST() { await requireRole('agent') }"
    expect(handlers(good).every((h) => GUARD.test(h.body))).toBe(true)
    expect(detect("await requireRole('admin'); await requireRole('agent')").roles).toEqual(['agent', 'admin'])
  })
})

// ---------------------------------------------------------------------------
// Service-role allowlist: the only modules that may construct a service-role
// client. Anything else must go through one of them, so every bypass of RLS is
// listed here and reviewed. Adding a module means adding a line + a reason.
// ---------------------------------------------------------------------------
const SERVICE_ROLE_MODULES: Record<string, string> = {
  'src/lib/credentials/server.ts': 'credential reads for server code after authorization (F1)',
  'src/lib/storage/media-server.ts': 'signing/downloading private media after an account check',
  'src/lib/ai/admin-client.ts': 'AI auto-reply path (no auth.uid on the webhook)',
  'src/lib/automations/admin-client.ts': 'automation engine / cron',
  'src/lib/flows/admin-client.ts': 'flow engine / cron / public API key context',
  'src/app/api/whatsapp/webhook/route.ts': 'Meta webhook (signature-verified, no user session)',
  'src/app/api/whatsapp/config/route.ts': 'admin-only save: cross-account phone-number uniqueness check that RLS would hide',
}

describe('service-role client construction', () => {
  // src/lib/test-utils holds test-only helpers (e.g. the import-graph scanner, which
  // names the key in a regex); they are never bundled or run in production.
  const FILES = walk(SRC, (n) => /\.(ts|tsx)$/.test(n) && !/\.test\.(ts|tsx)$/.test(n))
    .map((p) => ({ path: posix(process.cwd(), p), text: readFileSync(p, 'utf8') }))
    .filter((f) => !f.path.startsWith('src/lib/test-utils/'))

  it('only allowlisted modules read SUPABASE_SERVICE_ROLE_KEY', () => {
    const offenders = FILES.filter((f) => /SUPABASE_SERVICE_ROLE_KEY/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !(p in SERVICE_ROLE_MODULES))
    expect(offenders).toEqual([])
  })

  it('every allowlisted module still exists and still constructs a service-role client', () => {
    const byPath = new Map(FILES.map((f) => [f.path, f.text]))
    const stale = Object.keys(SERVICE_ROLE_MODULES).filter(
      (p) => !byPath.has(p) || !/SUPABASE_SERVICE_ROLE_KEY/.test(byPath.get(p)!),
    )
    expect(stale).toEqual([])
  })

  it('no browser module can reach a service-role module', () => {
    const isClient = (f: { path: string; text: string }) =>
      /^\s*['"]use client['"]/m.test(f.text) || f.path.startsWith('src/components/') || f.path.startsWith('src/hooks/')
    const serviceImports = /@\/lib\/(ai|automations|flows)\/admin-client|@\/lib\/credentials\/server|@\/lib\/storage\/media-server/
    const offenders = FILES.filter(isClient).filter((f) => serviceImports.test(f.text)).map((f) => f.path)
    expect(offenders).toEqual([])
  })
})
