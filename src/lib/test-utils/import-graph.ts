import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

/**
 * Test-only static import graph of src/ (no bundler needed). Used by the
 * server-boundary guard tests to prove that no browser module can reach a
 * server-only module, directly OR transitively.
 *
 * Conservative by design: a runtime import, a re-export (`export … from`) and a
 * dynamic `import('…')` all count as edges; only `import type` / `export type`
 * (erased at compile time) are ignored.
 */

export interface SourceFile {
  /** Repo-relative POSIX path, e.g. `src/lib/storage/media-server.ts`. */
  path: string
  text: string
}

const SRC_EXT = /\.(ts|tsx)$/

export function loadSources(root = process.cwd()): SourceFile[] {
  const out: SourceFile[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      // test-utils are test-only helpers, never bundled for any runtime.
      if (statSync(p).isDirectory()) {
        if (!(dir.endsWith(`${sep}lib`) && name === 'test-utils')) walk(p)
      } else if (SRC_EXT.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
        out.push({ path: relative(root, p).split(sep).join('/'), text: readFileSync(p, 'utf8') })
      }
    }
  }
  walk(join(root, 'src'))
  return out
}

/** Remove block and line comments so prose like "import x from 'y'" is not an edge. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const STATIC_IMPORT = /\bimport\s+(?!type\b)(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g
const REEXPORT = /\bexport\s+(?!type\b)[^'";]*?\sfrom\s*['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

export function importSpecifiers(text: string): string[] {
  const code = stripComments(text)
  const specs = new Set<string>()
  for (const re of [STATIC_IMPORT, REEXPORT, DYNAMIC_IMPORT]) {
    for (const m of code.matchAll(re)) specs.add(m[1])
  }
  return [...specs]
}

/** Resolve `@/…` and relative specifiers to a known source path; bare packages → null. */
export function resolveSpecifier(from: string, spec: string, known: Set<string>): string | null {
  let base: string
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`
  else if (spec.startsWith('.')) base = posix.join(posix.dirname(from), spec)
  else return null
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base]) {
    if (known.has(candidate)) return candidate
  }
  return null
}

export function buildGraph(files: SourceFile[]): Map<string, string[]> {
  const known = new Set(files.map((f) => f.path))
  const graph = new Map<string, string[]>()
  for (const f of files) {
    const edges = importSpecifiers(f.text)
      .map((s) => resolveSpecifier(f.path, s, known))
      .filter((p): p is string => p !== null)
    graph.set(f.path, edges)
  }
  return graph
}

/** Modules that are bundled for the browser: `"use client"` entries and hooks. */
export function isClientEntry(f: SourceFile): boolean {
  return /^\s*['"]use client['"]/m.test(f.text) || f.path.startsWith('src/hooks/')
}

/** Marked server-only, or holds the service-role key. Either must never reach a browser. */
export function isServerOnly(f: SourceFile): boolean {
  const code = stripComments(f.text)
  return /^\s*import\s+['"]server-only['"]/m.test(code) || /SUPABASE_SERVICE_ROLE_KEY/.test(code)
}

/**
 * Every import chain from a client entry to a target, as readable strings
 * (`a.tsx -> b.ts -> target.ts`). Empty = the browser cannot reach any target.
 */
export function clientPathsTo(
  files: SourceFile[],
  isTarget: (f: SourceFile) => boolean,
  isEntry: (f: SourceFile) => boolean = isClientEntry,
): string[] {
  const graph = buildGraph(files)
  const byPath = new Map(files.map((f) => [f.path, f]))
  const hits: string[] = []
  for (const entry of files.filter(isEntry)) {
    const seen = new Set<string>([entry.path])
    const stack: string[][] = [[entry.path]]
    while (stack.length) {
      const chain = stack.pop()!
      for (const next of graph.get(chain[chain.length - 1]) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        const nextChain = [...chain, next]
        if (isTarget(byPath.get(next)!)) hits.push(nextChain.join(' -> '))
        else stack.push(nextChain)
      }
    }
  }
  return hits
}
