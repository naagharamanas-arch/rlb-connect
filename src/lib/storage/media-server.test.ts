import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  API_SIGNED_URL_TTL_SECONDS,
  deriveObjectToken,
  downloadStoredMedia,
  MediaReferenceError,
  META_SIGNED_URL_TTL_SECONDS,
  resolveMediaLinkForMeta,
  setMediaAdminForTests,
  signMediaForApi,
} from './media-server'
import { buildMediaRef } from './media-url'

const A = '11111111-2222-3333-4444-555555555555'
const B = '99999999-8888-7777-6666-555555555555'

const signed = vi.fn()
const download = vi.fn()

beforeEach(() => {
  signed.mockReset()
  download.mockReset()
  signed.mockResolvedValue({ data: { signedUrl: 'https://storage.test/signed?token=t' }, error: null })
  download.mockResolvedValue({
    data: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    error: null,
  })
  setMediaAdminForTests({
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: (p: string, ttl: number) => signed(bucket, p, ttl),
        download: (p: string) => download(bucket, p),
      }),
    },
  })
})

describe('deriveObjectToken', () => {
  it('is 128-bit hex, deterministic, and differs per account and per id', () => {
    const t = deriveObjectToken(A, 'media-1')
    expect(t).toMatch(/^[0-9a-f]{32}$/)
    expect(deriveObjectToken(A, 'media-1')).toBe(t)
    expect(deriveObjectToken(A, 'media-2')).not.toBe(t)
    expect(deriveObjectToken(B, 'media-1')).not.toBe(t)
  })

  it('does not contain the id it was derived from', () => {
    expect(deriveObjectToken(A, '1234567890123456')).not.toContain('1234567890')
  })
})

describe('resolveMediaLinkForMeta', () => {
  it('passes external URLs through untouched, with or without an account', async () => {
    expect(await resolveMediaLinkForMeta('https://example.com/a.png', A)).toBe('https://example.com/a.png')
    expect(await resolveMediaLinkForMeta('https://example.com/a.png', undefined)).toBe('https://example.com/a.png')
    expect(signed).not.toHaveBeenCalled()
  })

  it('signs the callers own object with a short lifetime', async () => {
    const ref = buildMediaRef('chat-media', `account-${A}/tok-a.png`)
    expect(await resolveMediaLinkForMeta(ref, A)).toBe('https://storage.test/signed?token=t')
    expect(signed).toHaveBeenCalledWith('chat-media', `account-${A}/tok-a.png`, META_SIGNED_URL_TTL_SECONDS)
    expect(META_SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(15 * 60)
  })

  it('REFUSES another tenant object and never signs it', async () => {
    const foreign = buildMediaRef('chat-media', `account-${B}/tok-b.png`)
    await expect(resolveMediaLinkForMeta(foreign, A)).rejects.toBeInstanceOf(MediaReferenceError)
    expect(signed).not.toHaveBeenCalled()
  })

  it('fails closed when a reference arrives with no account id', async () => {
    const ref = buildMediaRef('chat-media', `account-${A}/tok-a.png`)
    await expect(resolveMediaLinkForMeta(ref, undefined)).rejects.toBeInstanceOf(MediaReferenceError)
    expect(signed).not.toHaveBeenCalled()
  })

  it('refuses a malformed or traversal reference', async () => {
    await expect(
      resolveMediaLinkForMeta(`/api/media/chat-media/account-${A}/../account-${B}/x.png`, A),
    ).rejects.toBeInstanceOf(MediaReferenceError)
    expect(signed).not.toHaveBeenCalled()
  })

  it('surfaces a signing failure as a MediaReferenceError', async () => {
    signed.mockResolvedValue({ data: null, error: { message: 'nope' } })
    await expect(
      resolveMediaLinkForMeta(buildMediaRef('chat-media', `account-${A}/x.png`), A),
    ).rejects.toBeInstanceOf(MediaReferenceError)
  })
})

describe('signMediaForApi', () => {
  it('passes null and external URLs through', async () => {
    expect(await signMediaForApi(null, A)).toBeNull()
    expect(await signMediaForApi('https://example.com/a.png', A)).toBe('https://example.com/a.png')
  })

  it('signs own objects and hides foreign ones', async () => {
    expect(await signMediaForApi(buildMediaRef('chat-media', `account-${A}/x.png`), A)).toBe(
      'https://storage.test/signed?token=t',
    )
    expect(signed).toHaveBeenCalledWith('chat-media', `account-${A}/x.png`, API_SIGNED_URL_TTL_SECONDS)
    signed.mockClear()
    expect(await signMediaForApi(buildMediaRef('chat-media', `account-${B}/x.png`), A)).toBeNull()
    expect(signed).not.toHaveBeenCalled()
  })
})

describe('downloadStoredMedia', () => {
  it('reads the callers own object', async () => {
    const out = await downloadStoredMedia(buildMediaRef('chat-media', `account-${A}/x.png`), A)
    expect(out.contentType).toBe('image/png')
    expect(Array.from(out.bytes)).toEqual([1, 2, 3])
  })

  it('refuses another tenant object without reading it', async () => {
    await expect(
      downloadStoredMedia(buildMediaRef('chat-media', `account-${B}/x.png`), A),
    ).rejects.toBeInstanceOf(MediaReferenceError)
    expect(download).not.toHaveBeenCalled()
  })
})
