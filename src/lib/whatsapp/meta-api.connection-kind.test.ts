import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPhoneConnectionKind } from './meta-api'

afterEach(() => vi.unstubAllGlobals())

function fieldOf(url: string): string {
  return new URL(url).searchParams.get('fields') ?? ''
}

describe('getPhoneConnectionKind', () => {
  it('requests each field on its OWN request so one unknown field cannot break the others', async () => {
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        const f = fieldOf(url)
        if (f === 'is_on_biz_app') {
          // an unsupported field on this Graph version answers #100
          return new Response(JSON.stringify({ error: { message: '(#100) nonexisting field', code: 100 } }), {
            status: 400,
          })
        }
        return new Response(JSON.stringify({ id: '1', [f]: f === 'platform_type' ? 'CLOUD_API' : 'LIVE' }), {
          status: 200,
        })
      }),
    )

    const out = await getPhoneConnectionKind({ phoneNumberId: '111', accessToken: 'tok' })

    expect(urls.map(fieldOf).sort()).toEqual(['account_mode', 'is_on_biz_app', 'platform_type'])
    expect(out).toEqual({ platformType: 'CLOUD_API', isOnBizApp: null, accountMode: 'LIVE' })
  })

  it('never throws: network failures and bad JSON become absent facts', async () => {
    let n = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1
        if (n === 1) throw new Error('network down')
        return new Response('not json', { status: 200 })
      }),
    )
    await expect(getPhoneConnectionKind({ phoneNumberId: '111', accessToken: 'tok' })).resolves.toEqual({
      platformType: null,
      isOnBizApp: null,
      accountMode: null,
    })
  })

  it('only trusts correctly typed values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const f = fieldOf(url)
        return new Response(JSON.stringify({ [f]: f === 'is_on_biz_app' ? 'true' : 42 }), { status: 200 })
      }),
    )
    await expect(getPhoneConnectionKind({ phoneNumberId: '1', accessToken: 't' })).resolves.toEqual({
      platformType: null,
      isOnBizApp: null,
      accountMode: null,
    })
  })

  it('sends the token only as a Bearer header, never in the URL', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        return new Response('{}', { status: 200 })
      }),
    )
    await getPhoneConnectionKind({ phoneNumberId: '111', accessToken: 'secret-token' })
    for (const c of calls) {
      expect(c.url).not.toContain('secret-token')
      expect((c.init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token')
    }
  })
})
