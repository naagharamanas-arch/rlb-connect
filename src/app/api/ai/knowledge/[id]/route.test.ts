import { beforeEach, describe, expect, it, vi } from 'vitest'

// DELETE /api/ai/knowledge/[id]: a delete that removed nothing (unknown id, or a
// document of another account that the account filter / RLS hide) must be a 404,
// not a 200 claiming a deletion. Found by the full-stack authorization job: tenant
// B got {"success":true} for tenant A's document (A's row was NOT deleted).

const h = vi.hoisted(() => ({
  deleted: null as { id: string } | null,
  error: null as { message: string } | null,
  calls: [] as { op: string; args: unknown[] }[],
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}))

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => {
    throw new Error('not used')
  },
  requireRole: async () => {
    const chain: Record<string, unknown> = {}
    chain.delete = () => {
      h.calls.push({ op: 'delete', args: [] })
      return chain
    }
    chain.eq = (...args: unknown[]) => {
      h.calls.push({ op: 'eq', args })
      return chain
    }
    chain.select = (...args: unknown[]) => {
      h.calls.push({ op: 'select', args })
      return chain
    }
    chain.maybeSingle = async () => ({ data: h.deleted, error: h.error })
    return { accountId: 'acc-1', userId: 'user-1', role: 'admin', supabase: { from: () => chain } }
  },
  toErrorResponse: (err: unknown) => ({
    body: { error: err instanceof Error ? err.message : 'error' },
    status: 403,
  }),
}))

vi.mock('@/lib/ai/config', () => ({ loadEmbeddingsKey: async () => ({ key: null, corrupt: false }) }))
vi.mock('@/lib/ai/knowledge', () => ({ ingestDocument: vi.fn() }))
vi.mock('@/lib/credentials/server', () => ({ credentialsDb: () => ({}) }))

import { DELETE } from './route'

const call = (id = 'doc-1') =>
  DELETE(new Request('http://localhost/api/ai/knowledge/' + id, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  }) as unknown as Promise<{ status: number; body: Record<string, unknown> }>

beforeEach(() => {
  h.deleted = { id: 'doc-1' }
  h.error = null
  h.calls = []
})

describe('DELETE /api/ai/knowledge/[id]', () => {
  it('returns 200 when a document was deleted', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true })
  })

  it('scopes the delete to the caller account and the id, and selects the deleted row', async () => {
    await call('doc-9')
    expect(h.calls).toContainEqual({ op: 'eq', args: ['account_id', 'acc-1'] })
    expect(h.calls).toContainEqual({ op: 'eq', args: ['id', 'doc-9'] })
    expect(h.calls).toContainEqual({ op: 'select', args: ['id'] })
  })

  it('returns 404 — not a false success — when nothing was deleted', async () => {
    h.deleted = null
    const res = await call()
    expect(res.status).toBe(404)
    expect(res.body).not.toHaveProperty('success')
  })

  it('returns 500 on a database error', async () => {
    h.deleted = null
    h.error = { message: 'boom' }
    const res = await call()
    expect(res.status).toBe(500)
  })
})
