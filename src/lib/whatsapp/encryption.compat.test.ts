import { describe, expect, it } from 'vitest'

import { encryptGcm } from '../../../tests/fullstack/crypto.mjs'
import { decrypt, encrypt, isLegacyFormat } from './encryption'

// The full-stack authorization job seeds WhatsApp / AI credentials with its own tiny
// AES-256-GCM helper (tests/fullstack/crypto.mjs) so the app can really decrypt them. That
// helper must stay byte-compatible with the app's encryption module; this test pins it.
describe('full-stack fixture encryption is compatible with the app', () => {
  it('the app decrypts what the harness encrypts', () => {
    const cipher = encryptGcm('fs-wa-token-a')
    expect(cipher.split(':')).toHaveLength(3)
    expect(isLegacyFormat(cipher)).toBe(false)
    expect(decrypt(cipher)).toBe('fs-wa-token-a')
  })

  it('the harness output has the same shape as the app output (iv:ciphertext:tag, 12-byte iv, 16-byte tag)', () => {
    const [iv, , tag] = encryptGcm('x').split(':')
    const [appIv, , appTag] = encrypt('x').split(':')
    expect(iv).toHaveLength(appIv.length)
    expect(tag).toHaveLength(appTag.length)
  })

  it('uses a fresh IV each time and rejects a tampered ciphertext', () => {
    expect(encryptGcm('same')).not.toBe(encryptGcm('same'))
    const [iv, ct, tag] = encryptGcm('secret-value').split(':')
    const flipped = (ct[0] === '0' ? '1' : '0') + ct.slice(1)
    expect(() => decrypt(`${iv}:${flipped}:${tag}`)).toThrow()
  })
})
