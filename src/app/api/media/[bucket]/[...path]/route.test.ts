import { beforeEach, describe, expect, it, vi } from 'vitest'

const A = '11111111-2222-3333-4444-555555555555'
const B = '99999999-8888-7777-6666-555555555555'

const h = vi.hoisted(() => ({
  signedCalls: [] as { bucket: string; path: string; ttl: number }[],
  signResult: { data: { signedUrl: 'https://storage.test/signed?token=t' }, error: null } as {
    data: { signedUrl: string } | null
    error: unknown
  },
  authenticated: true,
}))

vi.mock('@/lib/auth/account', () => {
  class UnauthorizedError extends Error {
    readonly status = 401
  }
  return {
    getCurrentAccount: async () => {
      if (!h.authenticated) throw new UnauthorizedError('Unauthorized')
      return {
        accountId: 'ACCOUNT_A',
        supabase: {
          storage: {
            from: (bucket: string) => ({
              createSignedUrl: async (path: string, ttl: number) => {
                h.signedCalls.push({ bucket, path, ttl })
                return h.signResult
              },
            }),
          },
        },
      }
    },
    toErrorResponse: (err: unknown) =>
      Response.json({ error: err instanceof Error ? err.message : 'error' }, { status: 401 }),
  }
})

import { GET } from './route'

function call(bucket: string, ...path: string[]) {
  return GET(new Request('http://localhost/api/media/x'), {
    params: Promise.resolve({ bucket, path }),
  })
}

beforeEach(() => {
  h.signedCalls = []
  h.authenticated = true
  h.signResult = { data: { signedUrl: 'https://storage.test/signed?token=t' }, error: null }
})

// The mocked session belongs to ACCOUNT_A; build folder names from it.
const own = 'account-ACCOUNT_A'

describe('GET /api/media/<bucket>/...', () => {
  it('redirects a member to a short-lived signed URL for their own account object', async () => {
    const res = await call('chat-media', own, 'tok-photo.png')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://storage.test/signed?token=t')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(h.signedCalls).toEqual([{ bucket: 'chat-media', path: `${own}/tok-photo.png`, ttl: 120 }])
  })

  it('serves flow-media and nested inbound paths', async () => {
    expect((await call('flow-media', own, 'x.png')).status).toBe(302)
    expect((await call('chat-media', own, 'inbound', 'tok-a.jpg')).status).toBe(302)
  })

  it('answers 404 (not 403) for another tenant object and never signs it', async () => {
    const res = await call('chat-media', `account-${B}`, 'tok-b.png')
    expect(res.status).toBe(404)
    expect(h.signedCalls).toEqual([])
  })

  it('answers 404 for traversal, unknown buckets and the public avatars bucket', async () => {
    expect((await call('chat-media', own, '..', `account-${B}`, 'x.png')).status).toBe(404)
    expect((await call('chat-media', own, '%2e%2e', 'x.png')).status).toBe(404)
    expect((await call('avatars', own, 'x.png')).status).toBe(404)
    expect((await call('nope', own, 'x.png')).status).toBe(404)
    expect((await call('chat-media', own)).status).toBe(404)
    expect(h.signedCalls).toEqual([])
  })

  it('answers 404 when Storage refuses to sign (RLS second gate, missing object)', async () => {
    h.signResult = { data: null, error: { message: 'Object not found' } }
    expect((await call('chat-media', own, 'gone.png')).status).toBe(404)
  })

  it('rejects an unauthenticated caller without signing anything', async () => {
    h.authenticated = false
    const res = await call('chat-media', own, 'tok-photo.png')
    expect(res.status).toBe(401)
    expect(h.signedCalls).toEqual([])
  })
})
