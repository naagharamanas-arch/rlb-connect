import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  META_API_BASE,
  MetaApiError,
  debugToken,
  exchangeCodeForToken,
  getWabaPhoneNumberDetails,
  unsubscribeWabaFromApp,
} from './meta-api'

const SECRET = 'es-secret-VALUE-123'
const APP_ID = '1234567890'
const CODE = 'single-use-code-XYZ'
const TOKEN = 'EAAB-business-token-ABC'

function res(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}
function badJson(status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: async () => {
      throw new Error('not json')
    },
  } as unknown as Response
}
const errEnvelope = (message: string, code = 190) => ({
  error: { message, code, type: 'OAuthException', fbtrace_id: 'trace1' },
})

let calls: Array<{ url: string; init?: RequestInit }>
function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return handler(url, init)
    }),
  )
}

beforeEach(() => {
  vi.stubEnv('META_APP_ID', APP_ID)
  vi.stubEnv('META_ES_APP_SECRET', SECRET)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('exchangeCodeForToken', () => {
  it('exchanges the code using the ES secret read at call time', async () => {
    stubFetch(() => res({ access_token: TOKEN, token_type: 'bearer', expires_in: 5000 }))
    const out = await exchangeCodeForToken({ code: CODE })
    expect(out).toEqual({ accessToken: TOKEN, tokenType: 'bearer', expiresInSeconds: 5000 })
    expect(calls[0].url.startsWith(`${META_API_BASE}/oauth/access_token?`)).toBe(true)
    expect(calls[0].url).toContain(`client_id=${APP_ID}`)
    expect(calls[0].url).toContain(`client_secret=${SECRET}`)
    expect(calls[0].url).toContain(`code=${CODE}`)
  })

  it('reads the secret at call time, not import time', async () => {
    stubFetch(() => res({ access_token: TOKEN }))
    vi.stubEnv('META_ES_APP_SECRET', 'rotated-secret')
    await exchangeCodeForToken({ code: CODE })
    expect(calls[0].url).toContain('client_secret=rotated-secret')
  })

  it('does not fall back to META_APP_SECRET (a comma list of other apps)', async () => {
    vi.stubEnv('META_ES_APP_SECRET', '')
    vi.stubEnv('META_APP_SECRET', 'other-app-secret')
    stubFetch(() => res({ access_token: TOKEN }))
    await expect(exchangeCodeForToken({ code: CODE })).rejects.toThrow(
      'META_ES_APP_SECRET is not set',
    )
    expect(calls).toHaveLength(0)
  })

  it('fails without META_APP_ID, naming only the variable', async () => {
    vi.stubEnv('META_APP_ID', '')
    stubFetch(() => res({}))
    await expect(exchangeCodeForToken({ code: CODE })).rejects.toThrow('META_APP_ID is not set')
  })

  it('surfaces the Meta error envelope without code, secret or token in the message', async () => {
    stubFetch(() => res(errEnvelope('Invalid verification code format.'), 400))
    const e = await exchangeCodeForToken({ code: CODE }).catch((x) => x)
    expect(e).toBeInstanceOf(MetaApiError)
    expect(e.code).toBe(190)
    expect(e.fbtraceId).toBe('trace1')
    const dump = JSON.stringify({ m: e.message, c: e.code, d: e.details, t: e.type })
    for (const s of [CODE, SECRET, TOKEN]) expect(dump).not.toContain(s)
  })

  it('rejects malformed JSON and a missing access_token', async () => {
    stubFetch(() => badJson())
    await expect(exchangeCodeForToken({ code: CODE })).rejects.toThrow(/no access token/)
    stubFetch(() => res({ token_type: 'bearer' }))
    await expect(exchangeCodeForToken({ code: CODE })).rejects.toThrow(/no access token/)
    stubFetch(() => res({ access_token: '' }))
    await expect(exchangeCodeForToken({ code: CODE })).rejects.toThrow(/no access token/)
  })

  it('failure messages never contain the secret or the code', async () => {
    stubFetch(() => badJson(500))
    const e = await exchangeCodeForToken({ code: CODE }).catch((x) => x)
    expect(String(e.message)).not.toContain(SECRET)
    expect(String(e.message)).not.toContain(CODE)
  })
})

describe('debugToken', () => {
  it('parses app id, validity, scopes and granular scopes', async () => {
    stubFetch(() =>
      res({
        data: {
          app_id: APP_ID,
          is_valid: true,
          type: 'USER',
          scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
          granular_scopes: [
            { scope: 'whatsapp_business_management', target_ids: ['111', '222'] },
            { scope: 'whatsapp_business_messaging', target_ids: ['111'] },
            { nonsense: true },
          ],
          expires_at: 0,
        },
      }),
    )
    const out = await debugToken({ inputToken: TOKEN })
    expect(out.appId).toBe(APP_ID)
    expect(out.isValid).toBe(true)
    expect(out.scopes).toHaveLength(2)
    expect(out.granularScopes).toEqual([
      { scope: 'whatsapp_business_management', targetIds: ['111', '222'] },
      { scope: 'whatsapp_business_messaging', targetIds: ['111'] },
    ])
    expect(out.expiresAt).toBe(0)
    expect(calls[0].url.startsWith(`${META_API_BASE}/debug_token?`)).toBe(true)
    // App access token is `id|secret` (URL-encoded) — never the user token.
    expect(decodeURIComponent(calls[0].url)).toContain(`access_token=${APP_ID}|${SECRET}`)
  })

  it('treats a missing or false is_valid as invalid and tolerates absent fields', async () => {
    stubFetch(() => res({ data: { app_id: APP_ID } }))
    const out = await debugToken({ inputToken: TOKEN })
    expect(out.isValid).toBe(false)
    expect(out.granularScopes).toEqual([])
    expect(out.scopes).toEqual([])
    expect(out.expiresAt).toBeNull()
  })

  it('throws on a Meta error and on malformed bodies', async () => {
    stubFetch(() => res(errEnvelope('Invalid OAuth access token.'), 400))
    await expect(debugToken({ inputToken: TOKEN })).rejects.toBeInstanceOf(MetaApiError)
    stubFetch(() => badJson())
    await expect(debugToken({ inputToken: TOKEN })).rejects.toThrow(/no data/)
    stubFetch(() => res({}))
    await expect(debugToken({ inputToken: TOKEN })).rejects.toThrow(/no data/)
  })

  it('requires the ES credentials', async () => {
    vi.stubEnv('META_ES_APP_SECRET', '')
    stubFetch(() => res({}))
    await expect(debugToken({ inputToken: TOKEN })).rejects.toThrow('META_ES_APP_SECRET is not set')
  })
})

describe('getWabaPhoneNumberDetails', () => {
  it('returns numbers with platformType from the extended request', async () => {
    stubFetch(() =>
      res({
        data: [
          { id: '1', display_phone_number: '+1 555', verified_name: 'A', platform_type: 'CLOUD_API' },
          { id: '2', platform_type: 7 },
        ],
      }),
    )
    const out = await getWabaPhoneNumberDetails({ wabaId: 'W', accessToken: TOKEN })
    expect(out).toEqual([
      { id: '1', display_phone_number: '+1 555', verified_name: 'A', platformType: 'CLOUD_API' },
      { id: '2', display_phone_number: undefined, verified_name: undefined, platformType: null },
    ])
    expect(calls[0].url).toContain('/W/phone_numbers?fields=')
    expect(calls[0].url).toContain('platform_type')
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    )
    expect(calls[0].url).not.toContain(TOKEN)
  })

  it('falls back to base fields (platformType null) when the extended field is rejected', async () => {
    stubFetch((url) =>
      url.includes('platform_type')
        ? res(errEnvelope('(#100) Tried accessing nonexisting field (platform_type)', 100), 400)
        : res({ data: [{ id: '1', display_phone_number: '+1 555' }] }),
    )
    const out = await getWabaPhoneNumberDetails({ wabaId: 'W', accessToken: TOKEN })
    expect(out).toEqual([{ id: '1', display_phone_number: '+1 555', platformType: null }])
    expect(calls).toHaveLength(2)
  })

  it('does not mask non-400 errors', async () => {
    stubFetch(() => res(errEnvelope('Server error', 2), 500))
    await expect(
      getWabaPhoneNumberDetails({ wabaId: 'W', accessToken: TOKEN }),
    ).rejects.toBeInstanceOf(MetaApiError)
    expect(calls).toHaveLength(1)
  })

  it('returns [] for an empty or malformed body', async () => {
    stubFetch(() => badJson())
    expect(await getWabaPhoneNumberDetails({ wabaId: 'W', accessToken: TOKEN })).toEqual([])
  })
})

describe('unsubscribeWabaFromApp', () => {
  it('DELETEs subscribed_apps with a bearer header', async () => {
    stubFetch(() => res({ success: true }))
    await unsubscribeWabaFromApp({ wabaId: 'W', accessToken: TOKEN })
    expect(calls[0].url).toBe(`${META_API_BASE}/W/subscribed_apps`)
    expect(calls[0].init?.method).toBe('DELETE')
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${TOKEN}`,
    )
  })

  it('throws the Meta error on failure', async () => {
    stubFetch(() => res(errEnvelope('nope', 100), 400))
    await expect(
      unsubscribeWabaFromApp({ wabaId: 'W', accessToken: TOKEN }),
    ).rejects.toBeInstanceOf(MetaApiError)
  })
})
