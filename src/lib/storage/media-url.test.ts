import { describe, expect, it } from 'vitest'

import {
  buildMediaRef,
  isMediaRef,
  mediaRefBelongsToAccount,
  parseMediaRef,
} from './media-url'

const A = '11111111-2222-3333-4444-555555555555'
const B = '99999999-8888-7777-6666-555555555555'

describe('media references', () => {
  it('round-trips a private-bucket object', () => {
    const ref = buildMediaRef('chat-media', `account-${A}/abc123-my file.png`)
    expect(ref).toBe(`/api/media/chat-media/account-${A}/abc123-my%20file.png`)
    expect(parseMediaRef(ref)).toEqual({
      bucket: 'chat-media',
      path: `account-${A}/abc123-my file.png`,
    })
  })

  it('round-trips a nested path (the inbound folder)', () => {
    const ref = buildMediaRef('chat-media', `account-${A}/inbound/tok-image-1.jpg`)
    expect(parseMediaRef(ref)?.path).toBe(`account-${A}/inbound/tok-image-1.jpg`)
  })

  it('only recognises same-origin references; external URLs are not media references', () => {
    expect(isMediaRef('https://example.com/a.png')).toBe(false)
    expect(isMediaRef('/api/whatsapp/media/123')).toBe(false)
    expect(isMediaRef(null)).toBe(false)
    expect(parseMediaRef('https://example.com/a.png')).toBeNull()
  })

  it('rejects the public avatars bucket and unknown buckets', () => {
    expect(parseMediaRef(`/api/media/avatars/${A}/x.png`)).toBeNull()
    expect(parseMediaRef(`/api/media/other/account-${A}/x.png`)).toBeNull()
  })

  it('rejects traversal, empty and encoded-separator segments', () => {
    expect(parseMediaRef(`/api/media/chat-media/account-${A}/../account-${B}/x.png`)).toBeNull()
    expect(parseMediaRef(`/api/media/chat-media/account-${A}/%2e%2e/x.png`)).toBeNull()
    expect(parseMediaRef(`/api/media/chat-media/account-${A}//x.png`)).toBeNull()
    expect(parseMediaRef(`/api/media/chat-media/account-${A}/a%2Fb.png`)).toBeNull()
    expect(parseMediaRef(`/api/media/chat-media/account-${A}/a%5Cb.png`)).toBeNull()
    expect(parseMediaRef(`/api/media/chat-media/account-${A}/%E0%A4%A.png`)).toBeNull()
    expect(parseMediaRef('/api/media/chat-media/only-one-segment')).toBeNull()
  })

  it('checks the account folder, not a prefix of it', () => {
    const own = parseMediaRef(buildMediaRef('flow-media', `account-${A}/x.png`))!
    expect(mediaRefBelongsToAccount(own, A)).toBe(true)
    expect(mediaRefBelongsToAccount(own, B)).toBe(false)
    const sneaky = parseMediaRef(buildMediaRef('flow-media', `account-${A}extra/x.png`))!
    expect(mediaRefBelongsToAccount(sneaky, A)).toBe(false)
  })
})
