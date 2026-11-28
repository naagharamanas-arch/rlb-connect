import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let signedIn = true

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () =>
        signedIn
          ? { data: { user: { id: 'user-1' } }, error: null }
          : { data: { user: null }, error: { message: 'no session' } },
      ),
    },
    from: vi.fn(() => {
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.eq = vi.fn(() => b)
      b.maybeSingle = vi.fn(async () => ({ data: { account_id: 'acct-1' }, error: null }))
      return b
    }),
  })),
}))

let storedConfig: Record<string, unknown> | null = null
vi.mock('@/lib/credentials/server', () => ({
  fetchWhatsAppConfig: vi.fn(async () => ({ data: storedConfig, error: null })),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
}))

const meta = vi.hoisted(() => ({
  verifyPhoneNumber: vi.fn(async () => ({ id: '1' })),
  getSubscribedApps: vi.fn(async () => [{}] as unknown[]),
  getPhoneConnectionKind: vi.fn(async () => ({}) as Record<string, unknown>),
}))
vi.mock('@/lib/whatsapp/meta-api', () => meta)

import { GET } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const CONFIG = {
  id: 'cfg-1',
  phone_number_id: '111222333',
  waba_id: '444555666',
  access_token: 'enc-token',
  registered_at: null as string | null,
  subscribed_apps_at: null,
  last_registration_error: null,
}

beforeEach(() => {
  __resetRateLimitForTests()
  signedIn = true
  storedConfig = { ...CONFIG }
  meta.verifyPhoneNumber.mockClear()
  meta.getSubscribedApps.mockReset()
  meta.getSubscribedApps.mockResolvedValue([{}])
  meta.getPhoneConnectionKind.mockReset()
  meta.getPhoneConnectionKind.mockResolvedValue({})
})
afterEach(() => vi.unstubAllEnvs())

describe('GET /api/whatsapp/config/verify-registration', () => {
  it('flag OFF: a coexistence-style row (registered_at NULL) is NOT live, exactly as before, and the response is unchanged', async () => {
    meta.getPhoneConnectionKind.mockResolvedValue({ isOnBizApp: true })
    const body = await (await GET()).json()
    expect(body.live).toBe(false)
    expect(body.checks.locally_marked_registered).toBe(false)
    expect('connection_kind' in body).toBe(false)
    expect(Object.keys(body).sort()).toEqual([
      'checks',
      'errors',
      'last_registration_error',
      'live',
      'registered_at',
      'subscribed_apps_at',
    ])
    expect(meta.getPhoneConnectionKind).not.toHaveBeenCalled()
  })

  it('flag ON, coexistence: live without registered_at, and the registration check is not reported', async () => {
    vi.stubEnv('WA_STATUS_V2', '1')
    meta.getPhoneConnectionKind.mockResolvedValue({ isOnBizApp: true })
    const body = await (await GET()).json()
    expect(body.live).toBe(true)
    expect(body.connection_kind).toBe('coexistence')
    expect('locally_marked_registered' in body.checks).toBe(false)
    expect(body.checks.phone_metadata_ok).toBe(true)
    expect(body.checks.waba_subscribed_to_app).toBe(true)
  })

  it('flag ON, coexistence but WABA not subscribed: NOT live', async () => {
    vi.stubEnv('WA_STATUS_V2', '1')
    meta.getPhoneConnectionKind.mockResolvedValue({ isOnBizApp: true })
    meta.getSubscribedApps.mockResolvedValue([])
    const body = await (await GET()).json()
    expect(body.live).toBe(false)
    expect(body.checks.waba_subscribed_to_app).toBe(false)
  })

  it('flag ON, coexistence but metadata check fails: NOT live', async () => {
    vi.stubEnv('WA_STATUS_V2', '1')
    meta.getPhoneConnectionKind.mockResolvedValue({ isOnBizApp: true })
    meta.verifyPhoneNumber.mockRejectedValueOnce(new Error('bad token'))
    const body = await (await GET()).json()
    expect(body.live).toBe(false)
    expect(body.checks.phone_metadata_ok).toBe(false)
  })

  it('flag ON, Meta test number: live without registered_at', async () => {
    vi.stubEnv('WA_STATUS_V2', '1')
    meta.getPhoneConnectionKind.mockResolvedValue({ accountMode: 'SANDBOX' })
    const body = await (await GET()).json()
    expect(body.live).toBe(true)
    expect(body.connection_kind).toBe('test_number')
  })

  it('flag ON, Cloud API number not registered locally: still NOT live (production numbers keep needing /register)', async () => {
    vi.stubEnv('WA_STATUS_V2', '1')
    meta.getPhoneConnectionKind.mockResolvedValue({ isOnBizApp: false, platformType: 'CLOUD_API' })
    const body = await (await GET()).json()
    expect(body.live).toBe(false)
    expect(body.checks.locally_marked_registered).toBe(false)
    expect(body.connection_kind).toBe('cloud_api')
  })

  it('flag ON, kind unknown (Graph fields unavailable): behaves like before — not live without registered_at', async () => {
    vi.stubEnv('WA_STATUS_V2', '1')
    const body = await (await GET()).json()
    expect(body.live).toBe(false)
    expect(body.connection_kind).toBe('unknown')
  })

  it('flag ON, Cloud API number registered: live', async () => {
    vi.stubEnv('WA_STATUS_V2', '1')
    storedConfig = { ...CONFIG, registered_at: '2026-11-01T00:00:00Z' }
    meta.getPhoneConnectionKind.mockResolvedValue({ isOnBizApp: false, platformType: 'CLOUD_API' })
    expect((await (await GET()).json()).live).toBe(true)
  })

  it('never returns the token', async () => {
    vi.stubEnv('WA_STATUS_V2', '1')
    meta.getPhoneConnectionKind.mockResolvedValue({ isOnBizApp: true })
    const text = JSON.stringify(await (await GET()).json())
    expect(text).not.toContain('plaintext-token')
    expect(text).not.toContain('enc-token')
  })

  it('answers 401 without a session and calls Meta for nothing', async () => {
    signedIn = false
    const res = await GET()
    expect(res.status).toBe(401)
    expect(meta.verifyPhoneNumber).not.toHaveBeenCalled()
    expect(meta.getPhoneConnectionKind).not.toHaveBeenCalled()
  })
})
