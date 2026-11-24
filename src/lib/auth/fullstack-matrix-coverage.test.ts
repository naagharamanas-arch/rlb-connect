import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import matrix from '../../../tests/fullstack/matrix.json'
import { ROUTE_REGISTRY } from './route-registry'

// ---------------------------------------------------------------------------
// The full-stack authorization job (tests/fullstack, run in CI against a real
// Supabase stack) is only as good as its matrix. This unit test — which runs on
// every PR without any stack — keeps the matrix COMPLETE and honest:
//   * every route in the registry is either in the matrix or explicitly listed
//     as covered by a dedicated test;
//   * every exported HTTP method of every route has a matrix case;
//   * the role each case expects matches the role the source actually requires;
//   * the tenancy cases only use known principals and real placeholders.
// ---------------------------------------------------------------------------

const APP = join(process.cwd(), 'src', 'app')
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (n === 'route.ts') out.push(p)
  }
  return out
}
const sources = new Map(
  walk(APP).map((p) => [p.slice(APP.length + 1).split('\\').join('/'), readFileSync(p, 'utf8')]),
)

function handlerSegments(text: string): { method: string; body: string }[] {
  const hits = [...text.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)]
  return hits.map((m, i) => ({
    method: m[1],
    body: text.slice(m.index!, i + 1 < hits.length ? hits[i + 1].index! : text.length),
  }))
}

const cases = matrix.cases as { route: string; method: string; kind: string; minRole?: string }[]
const special = matrix.special as { route: string; reason: string }[]

describe('full-stack authorization matrix coverage', () => {
  it('every registered route is in the matrix or has a documented dedicated test', () => {
    const covered = new Set([...cases.map((c) => c.route), ...special.map((s) => s.route)])
    expect(Object.keys(ROUTE_REGISTRY).filter((r) => !covered.has(r))).toEqual([])
  })

  it('every special route states why and which test covers it', () => {
    for (const s of special) {
      expect(s.reason.length, s.route).toBeGreaterThan(20)
      expect(ROUTE_REGISTRY[s.route], s.route).toBeDefined()
    }
  })

  it('every exported handler of every matrix route has a case', () => {
    const missing: string[] = []
    for (const [route, text] of sources) {
      if (special.some((s) => s.route === route)) continue
      for (const h of handlerSegments(text)) {
        if (!cases.some((c) => c.route === route && c.method === h.method)) missing.push(`${h.method} ${route}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('no matrix case refers to a route or method that no longer exists', () => {
    const stale = cases.filter((c) => {
      const text = sources.get(c.route)
      return !text || !handlerSegments(text).some((h) => h.method === c.method)
    })
    expect(stale).toEqual([])
  })

  it('the expected minimum role / guard of each case matches the source', () => {
    const wrong: string[] = []
    for (const c of cases) {
      const seg = handlerSegments(sources.get(c.route)!).find((h) => h.method === c.method)!
      const role = /requireRole\(\s*['"](\w+)['"]/.exec(seg.body)?.[1]
      if (c.kind === 'role' && role !== c.minRole) wrong.push(`${c.method} ${c.route}: matrix ${c.minRole}, source ${role}`)
      if (c.kind === 'apikey' && !/requireApiKey\(/.test(seg.body)) wrong.push(`${c.method} ${c.route}: not an API-key route`)
      if (c.kind === 'member' && !/getCurrentAccount\(/.test(seg.body)) wrong.push(`${c.method} ${c.route}: not a member route`)
      if (c.kind === 'session' && role) wrong.push(`${c.method} ${c.route}: source requires role ${role}`)
    }
    expect(wrong).toEqual([])
  })

  it('tenancy cases use known principals and placeholders', () => {
    const principals = new Set(matrix.principals)
    const known = new Set([
      'flow', 'auto', 'qr', 'doc', 'contact', 'tag', 'agentUser', 'inv', 'apiKeyRow', 'template',
      'bcast', 'conv', 'msg', 'webhook', 'phone',
    ])
    for (const t of matrix.tenancy as { id: string; foreign: string; positive?: { principal: string }; path: string; body?: unknown }[]) {
      expect(principals.has(t.foreign), t.id).toBe(true)
      if (t.positive) expect(principals.has(t.positive.principal), t.id).toBe(true)
      const text = t.path + JSON.stringify(t.body ?? '')
      for (const m of text.matchAll(/\{\{A\.(\w+)\}\}/g)) expect(known.has(m[1]), `${t.id}: ${m[1]}`).toBe(true)
    }
  })

  it('covers every principal the job promises', () => {
    expect(matrix.principals).toEqual([
      'anon', 'viewer', 'agent', 'admin', 'owner', 'otherOwner', 'apiKey', 'apiKeyNoScope', 'otherApiKey',
    ])
  })
})
