import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { setMediaAdminForTests } from '@/lib/storage/media-server'
import { buildMediaRef } from '@/lib/storage/media-url'
import type { MessageTemplate } from '@/types'

import { sendMediaMessage, sendTemplateMessage } from './meta-api'

// ---------------------------------------------------------------------------
// Private-bucket media references must be turned into short-lived signed URLs
// BEFORE they reach Meta, only for the sending account, and must fail closed.
// ---------------------------------------------------------------------------

const A = '11111111-2222-3333-4444-555555555555'
const B = '99999999-8888-7777-6666-555555555555'

let sent: Record<string, unknown>[] = []
const sign = vi.fn()

beforeEach(() => {
  sent = []
  sign.mockReset()
  sign.mockResolvedValue({ data: { signedUrl: 'https://storage.test/signed?token=t' }, error: null })
  setMediaAdminForTests({
    storage: { from: (bucket: string) => ({ createSignedUrl: (p: string, ttl: number) => sign(bucket, p, ttl) }) },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.OK' }] }), { status: 200 })
    }),
  )
})
afterEach(() => vi.unstubAllGlobals())

const BASE = { phoneNumberId: 'pn-1', accessToken: 'tok', to: '+15551234567' } as const
const ownRef = buildMediaRef('chat-media', `account-${A}/tok-photo.png`)
const foreignRef = buildMediaRef('chat-media', `account-${B}/tok-secret.png`)

describe('sendMediaMessage with a private-bucket reference', () => {
  it('sends Meta a signed URL, never the stored reference', async () => {
    await sendMediaMessage({ ...BASE, kind: 'image', link: ownRef, mediaAccountId: A })
    expect((sent[0].image as { link: string }).link).toBe('https://storage.test/signed?token=t')
  })

  it('does not call Meta at all for another tenant object', async () => {
    await expect(
      sendMediaMessage({ ...BASE, kind: 'image', link: foreignRef, mediaAccountId: A }),
    ).rejects.toThrow()
    expect(sent).toEqual([])
    expect(sign).not.toHaveBeenCalled()
  })

  it('fails closed when the caller forgot the account id', async () => {
    await expect(sendMediaMessage({ ...BASE, kind: 'image', link: ownRef })).rejects.toThrow()
    expect(sent).toEqual([])
  })

  it('leaves an external URL exactly as given (no account needed)', async () => {
    await sendMediaMessage({ ...BASE, kind: 'image', link: 'https://example.com/a.png' })
    expect((sent[0].image as { link: string }).link).toBe('https://example.com/a.png')
    expect(sign).not.toHaveBeenCalled()
  })
})

const TEMPLATE = {
  id: 't1',
  name: 'promo',
  language: 'en_US',
  status: 'APPROVED',
  category: 'Marketing',
  body_text: 'Hello',
  header_type: 'image',
  header_media_url: ownRef,
} as unknown as MessageTemplate

function headerLink(): string | undefined {
  const comps = ((sent[0].template as { components?: { type: string; parameters: { image?: { link?: string } }[] }[] }).components ?? [])
  return comps.find((c) => c.type === 'header')?.parameters[0]?.image?.link
}

describe('sendTemplateMessage with a private-bucket header', () => {
  it('signs the stored header reference for the sending account', async () => {
    await sendTemplateMessage({
      ...BASE,
      templateName: 'promo',
      template: TEMPLATE,
      mediaAccountId: A,
    })
    expect(headerLink()).toBe('https://storage.test/signed?token=t')
  })

  it('signs a per-send header override too', async () => {
    await sendTemplateMessage({
      ...BASE,
      templateName: 'promo',
      template: { ...TEMPLATE, header_media_url: undefined } as unknown as MessageTemplate,
      messageParams: { headerMediaUrl: ownRef },
      mediaAccountId: A,
    })
    expect(headerLink()).toBe('https://storage.test/signed?token=t')
  })

  it('refuses a foreign header reference and sends nothing', async () => {
    await expect(
      sendTemplateMessage({
        ...BASE,
        templateName: 'promo',
        template: { ...TEMPLATE, header_media_url: foreignRef } as unknown as MessageTemplate,
        mediaAccountId: A,
      }),
    ).rejects.toThrow()
    expect(sent).toEqual([])
  })

  it('fails closed without an account id', async () => {
    await expect(
      sendTemplateMessage({ ...BASE, templateName: 'promo', template: TEMPLATE }),
    ).rejects.toThrow()
    expect(sent).toEqual([])
  })
})
