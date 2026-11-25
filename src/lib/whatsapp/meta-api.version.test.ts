import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

import { META_API_BASE, META_API_VERSION } from './meta-api'

// ---------------------------------------------------------------------------
// One Graph API version, declared once.
//
// Meta retires Graph versions on a published schedule, so upgrading is a
// routine, deliberate change. That is only safe if it really is a one-line
// change: this guard fails when any module outside meta-api.ts declares its own
// version or builds a graph.facebook.com URL itself (the templates sync route
// used to do exactly that, so a bump would have silently left it behind).
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src')
const ALLOWED = 'src/lib/whatsapp/meta-api.ts'

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

describe('Graph API version is declared in exactly one place', () => {
  it('exports a well-formed version and base URL', () => {
    expect(META_API_VERSION).toMatch(/^v\d+\.\d+$/)
    expect(META_API_BASE).toBe(`https://graph.facebook.com/${META_API_VERSION}`)
  })

  it('no module other than meta-api.ts builds a graph.facebook.com/<path> URL', () => {
    const offenders = FILES.filter(
      (f) => f.path !== ALLOWED && /graph\.facebook\.com\//.test(f.text),
    ).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('no module other than meta-api.ts declares a Graph version literal', () => {
    // Matches e.g. `const META_API_VERSION = 'v21.0'` / `apiVersion: "v22.0"`.
    const declaration = /(?:version|VERSION)\w*\s*[:=]\s*['"]v\d+\.\d+['"]/
    const offenders = FILES.filter(
      (f) => f.path !== ALLOWED && declaration.test(f.text),
    ).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('meta-api.ts itself declares the version exactly once', () => {
    const own = FILES.find((f) => f.path === ALLOWED)
    expect(own).toBeDefined()
    const matches = own!.text.match(/export const META_API_VERSION = ['"]v\d+\.\d+['"]/g)
    expect(matches).toHaveLength(1)
  })
})
