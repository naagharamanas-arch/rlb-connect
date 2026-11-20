// Self-test of the harness helpers: needs no Supabase stack, so it runs locally and
// in CI before anything else. The cookie test is the important one: it feeds the
// cookie our harness builds into the REAL @supabase/ssr reader the app uses.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createServerClient } from '@supabase/ssr'

process.env.FS_API_URL ??= 'http://127.0.0.1:54321'
process.env.FS_ANON_KEY ??= 'anon'
const { fill, isDenied, sessionCookie, RANK } = await import('./lib.mjs')

function session(tokenLen) {
  const now = Math.floor(Date.now() / 1000)
  return {
    access_token: 'a'.repeat(tokenLen),
    refresh_token: 'r'.repeat(12),
    expires_in: 3600,
    expires_at: now + 3600,
    token_type: 'bearer',
    user: { id: '11111111-2222-3333-4444-555555555555', aud: 'authenticated', role: 'authenticated', email: 'x@test.invalid', app_metadata: {}, user_metadata: {}, created_at: '2020-01-01T00:00:00Z' },
  }
}

async function readBack(header) {
  const jar = header.split('; ').map((kv) => {
    const i = kv.indexOf('=')
    return { name: kv.slice(0, i), value: kv.slice(i + 1) }
  })
  const client = createServerClient(process.env.FS_API_URL, process.env.FS_ANON_KEY, {
    cookies: { getAll: () => jar, setAll: () => {} },
  })
  const { data } = await client.auth.getSession()
  return data.session
}

describe('sessionCookie', () => {
  it('a small session round-trips through the real @supabase/ssr reader', async () => {
    const s = session(300)
    const header = sessionCookie(s)
    assert.ok(!header.includes('.0='), 'a small session must not be chunked')
    assert.equal((await readBack(header))?.access_token, s.access_token)
  })

  it('a large session is chunked and still round-trips', async () => {
    const s = session(5000)
    const header = sessionCookie(s)
    assert.ok(header.includes('.0=') && header.includes('.1='), 'a large session must be chunked')
    assert.equal((await readBack(header))?.access_token, s.access_token)
  })

  it('uses the cookie name the app derives from the API host', () => {
    assert.match(sessionCookie(session(10)), /^sb-127-auth-token=base64-/)
  })
})

describe('helpers', () => {
  it('isDenied is true only for 401/403 or a redirect to /login', () => {
    assert.equal(isDenied({ status: 401 }), true)
    assert.equal(isDenied({ status: 403 }), true)
    assert.equal(isDenied({ status: 302, location: 'http://x/login' }), true)
    for (const status of [200, 201, 400, 404, 429, 500]) assert.equal(isDenied({ status }), false, String(status))
    assert.equal(isDenied({ status: 302, location: 'https://storage/sign' }), false)
  })

  it('fill resolves placeholders recursively and rejects unknown ones', () => {
    const w = { A: { flow: 'f1', tag: 't1' } }
    assert.equal(fill('/api/flows/{{A.flow}}', w), '/api/flows/f1')
    assert.deepEqual(fill({ x: ['{{A.tag}}'], n: 1 }, w), { x: ['t1'], n: 1 })
    assert.throws(() => fill('{{A.nope}}', w))
  })

  it('role ranks put the other-tenant owner on the owner rung of ITS OWN account', () => {
    assert.deepEqual(RANK, { viewer: 1, agent: 2, admin: 3, owner: 4, otherOwner: 4 })
  })
})
