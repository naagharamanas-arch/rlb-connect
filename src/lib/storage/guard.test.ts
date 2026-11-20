import { clientPathsTo, isClientEntry, type SourceFile } from '@/lib/test-utils/import-graph'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Storage source guards. chat-media and flow-media are PRIVATE buckets
// (migration 064): a public URL for them does not exist, so nothing may build
// one, and the only code that may sign or download an object is the server
// media module (which checks account ownership). Avatars stay public.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
const FILES = walk(SRC).map((p) => ({
  path: relative(process.cwd(), p).split(sep).join('/'),
  text: readFileSync(p, 'utf8'),
}))

/** Where signing / public-URL APIs are allowed, and why. */
const SIGNERS = new Set([
  'src/lib/storage/media-server.ts', // service-role signing with an account check
  'src/app/api/media/[bucket]/[...path]/route.ts', // caller-scoped signing for the browser
])
const PUBLIC_URL_ALLOWED = new Set([
  'src/components/settings/profile-form.tsx', // avatars: the one public bucket
])

describe('private media buckets', () => {
  it('sees the source tree', () => {
    expect(FILES.length).toBeGreaterThan(100)
    expect(FILES.some((f) => f.path === 'src/lib/storage/media-server.ts')).toBe(true)
  })

  it('getPublicUrl is used only for the public avatars bucket', () => {
    const offenders = FILES.filter((f) => /\bgetPublicUrl\s*\(/.test(f.text))
      .filter((f) => !PUBLIC_URL_ALLOWED.has(f.path))
      .map((f) => f.path)
    expect(offenders).toEqual([])
    const avatarFile = FILES.find((f) => f.path === 'src/components/settings/profile-form.tsx')!
    expect(avatarFile.text).toMatch(/from\('avatars'\)\.getPublicUrl/)
  })

  it('no module builds a public object URL by hand', () => {
    const offenders = FILES.filter((f) => /storage\/v1\/object\/public/.test(f.text)).map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('createSignedUrl / storage download live only in the approved server modules', () => {
    const offenders = FILES.filter((f) => /\bcreateSignedUrls?\s*\(/.test(f.text))
      .filter((f) => !SIGNERS.has(f.path))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  it('browser upload helper targets only private buckets and returns a reference, not a bucket URL', () => {
    const f = FILES.find((x) => x.path === 'src/lib/storage/upload-media.ts')!
    expect(f.text).toMatch(/PRIVATE_MEDIA_BUCKETS/)
    expect(f.text).not.toMatch(/getPublicUrl/)
    expect(f.text).toMatch(/crypto\.randomUUID\(\)/)
  })

  it('no browser module reaches the server media module, directly or transitively', () => {
    // Entries: every "use client" module, hook, and anything under src/components.
    const isEntry = (f: SourceFile) => isClientEntry(f) || f.path.startsWith('src/components/')
    expect(clientPathsTo(FILES, (f) => f.path === 'src/lib/storage/media-server.ts', isEntry)).toEqual([])
  })
})
