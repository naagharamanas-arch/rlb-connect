import { describe, expect, it } from 'vitest'

import {
  buildGraph,
  clientPathsTo,
  importSpecifiers,
  isClientEntry,
  isServerOnly,
  loadSources,
  type SourceFile,
} from './test-utils/import-graph'

// ---------------------------------------------------------------------------
// Server/browser boundary. A module that holds the service-role key, signs
// private media or reads credentials must never be bundled for the browser —
// not by a direct import and not through a chain of innocent-looking helpers
// (the review finding M1: a client component imported `meta-api.ts` for one
// constant, which imported the media-signing module). Two layers:
//   1. these static tests (every client entry, transitively, on every PR);
//   2. `import 'server-only'` in the modules themselves, which makes the Next
//      build FAIL if a client bundle ever reaches them.
// ---------------------------------------------------------------------------

const FILES = loadSources()
const byPath = new Map(FILES.map((f) => [f.path, f]))
const file = (p: string) => {
  const f = byPath.get(p)
  if (!f) throw new Error(`missing ${p}`)
  return f
}

const synthetic = (entries: Record<string, string>): SourceFile[] =>
  Object.entries(entries).map(([path, text]) => ({ path, text }))

describe('server/browser boundary (real source tree)', () => {
  it('sees the source tree and some client entries (guards against a vacuous pass)', () => {
    expect(FILES.length).toBeGreaterThan(200)
    expect(FILES.filter(isClientEntry).length).toBeGreaterThan(50)
    expect(FILES.filter(isServerOnly).length).toBeGreaterThanOrEqual(5)
  })

  it('no client module reaches a server-only module, directly or transitively', () => {
    expect(clientPathsTo(FILES, isServerOnly)).toEqual([])
  })

  it('the server-only modules carry the build-time marker', () => {
    const required = [
      'src/lib/storage/media-server.ts',
      'src/lib/credentials/server.ts',
      'src/lib/ai/admin-client.ts',
      'src/lib/automations/admin-client.ts',
      'src/lib/flows/admin-client.ts',
    ]
    for (const p of required) {
      expect(importSpecifiers(file(p).text), p).toContain('server-only')
    }
  })

  it('every non-route module that references the service-role key carries the marker', () => {
    const missing = FILES.filter(
      (f) => /SUPABASE_SERVICE_ROLE_KEY/.test(f.text) && !f.path.endsWith('/route.ts'),
    ).filter((f) => !importSpecifiers(f.text).includes('server-only'))
    expect(missing.map((f) => f.path)).toEqual([])
  })

  it('regression M1: the interactive limits live in a client-safe module', () => {
    const limits = file('src/lib/whatsapp/interactive-limits.ts')
    expect(importSpecifiers(limits.text)).toEqual([])
    for (const p of [
      'src/components/interactive/interactive-builder.tsx',
      'src/lib/whatsapp/interactive.ts',
      'src/lib/flows/validate.ts',
    ]) {
      expect(importSpecifiers(file(p).text), p).toContain(
        p.endsWith('interactive.ts') ? './interactive-limits' : '@/lib/whatsapp/interactive-limits',
      )
      expect(importSpecifiers(file(p).text), p).not.toContain('@/lib/whatsapp/meta-api')
      expect(importSpecifiers(file(p).text), p).not.toContain('./meta-api')
    }
  })

  it('regression M1: the dashboard client components from the review cannot reach server-only code', () => {
    const entries = [
      'src/components/interactive/interactive-builder.tsx',
      'src/components/inbox/message-composer.tsx',
      'src/components/inbox/message-thread.tsx',
      'src/components/flows/flow-editor-state.tsx',
      'src/components/automations/automation-builder.tsx',
      'src/components/settings/quick-replies-manager.tsx',
    ]
    const graph = buildGraph(FILES)
    for (const entry of entries) {
      const seen = new Set([entry])
      const stack = [entry]
      while (stack.length) {
        for (const next of graph.get(stack.pop()!) ?? []) {
          if (seen.has(next)) continue
          seen.add(next)
          stack.push(next)
        }
      }
      expect([...seen].filter((p) => isServerOnly(file(p))), entry).toEqual([])
      expect(seen.has('src/lib/whatsapp/meta-api.ts'), `${entry} still imports meta-api.ts`).toBe(false)
    }
  })

  it('meta-api.ts stays server-only by reaching the media signer, and no client imports it', () => {
    const graph = buildGraph(FILES)
    expect(graph.get('src/lib/whatsapp/meta-api.ts')).toContain('src/lib/storage/media-server.ts')
    const importers = FILES.filter((f) => isClientEntry(f))
      .filter((f) => (graph.get(f.path) ?? []).includes('src/lib/whatsapp/meta-api.ts'))
      .map((f) => f.path)
    expect(importers).toEqual([])
  })
})

describe('the import-graph detector (guards against a broken regex)', () => {
  const SERVER = "import 'server-only'\nexport const secret = 1\n"

  it('flags a direct client → server-only import', () => {
    const files = synthetic({
      'src/components/a.tsx': '"use client"\nimport { secret } from "@/lib/s"\n',
      'src/lib/s.ts': SERVER,
    })
    expect(clientPathsTo(files, isServerOnly)).toEqual(['src/components/a.tsx -> src/lib/s.ts'])
  })

  it('flags a transitive chain through innocent helpers', () => {
    const files = synthetic({
      'src/components/a.tsx': '"use client"\nimport { x } from "@/lib/helper"\n',
      'src/lib/helper.ts': "import { y } from './deeper'\nexport const x = y\n",
      'src/lib/deeper.ts': "import { secret } from '@/lib/s'\nexport const y = secret\n",
      'src/lib/s.ts': SERVER,
    })
    expect(clientPathsTo(files, isServerOnly)).toEqual([
      'src/components/a.tsx -> src/lib/helper.ts -> src/lib/deeper.ts -> src/lib/s.ts',
    ])
  })

  it('flags re-exports, dynamic imports and multi-line imports', () => {
    const files = synthetic({
      'src/components/a.tsx': '"use client"\nexport { secret } from "@/lib/s"\n',
      'src/components/b.tsx': '"use client"\nconst m = () => import("@/lib/s")\n',
      'src/components/c.tsx': '"use client"\nimport {\n  secret,\n  other,\n} from "@/lib/s"\n',
      'src/lib/s.ts': SERVER,
    })
    expect(clientPathsTo(files, isServerOnly)).toHaveLength(3)
  })

  it('treats a service-role reference as server-only even without the marker', () => {
    const files = synthetic({
      'src/hooks/use-x.ts': "import { c } from '@/lib/c'\n",
      'src/lib/c.ts': 'export const k = process.env.SUPABASE_SERVICE_ROLE_KEY\n',
    })
    expect(clientPathsTo(files, isServerOnly)).toEqual(['src/hooks/use-x.ts -> src/lib/c.ts'])
  })

  it('ignores type-only imports and comments, and server entries that no client reaches', () => {
    const files = synthetic({
      'src/components/a.tsx':
        '"use client"\nimport type { T } from "@/lib/s"\n// import { secret } from "@/lib/s"\n/* import "@/lib/s" */\n',
      'src/lib/s.ts': SERVER,
      'src/app/api/x/route.ts': "import { secret } from '@/lib/s'\n",
    })
    expect(clientPathsTo(files, isServerOnly)).toEqual([])
  })
})
