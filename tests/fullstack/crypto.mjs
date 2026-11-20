// Test-fixture encryption, byte-compatible with src/lib/whatsapp/encryption.ts (AES-256-GCM,
// `<iv-hex>:<ciphertext-hex>:<authTag-hex>`). Lets the harness seed WhatsApp / AI credentials
// that the app can really decrypt, so credential-bearing routes behave as in production.
// src/lib/whatsapp/encryption.compat.test.ts proves the two implementations interoperate.
import { createCipheriv, randomBytes } from 'node:crypto'

export function encryptGcm(text, keyHex = process.env.ENCRYPTION_KEY) {
  if (!keyHex || keyHex.length !== 64) throw new Error('ENCRYPTION_KEY (64 hex chars) is required')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return `${iv.toString('hex')}:${encrypted}:${cipher.getAuthTag().toString('hex')}`
}
