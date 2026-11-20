import 'server-only'

import { createHmac } from 'node:crypto'

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import {
  isMediaRef,
  mediaRefBelongsToAccount,
  parseMediaRef,
  type MediaRef,
} from '@/lib/storage/media-url'

/**
 * SERVER-ONLY helpers for the private media buckets: deterministic unguessable
 * object names, and short-lived signed URLs created with the service role.
 *
 * Every signing path takes the account id the CALLER derived server-side and
 * refuses an object outside `account-<id>/`, so a tenant can never get another
 * tenant's media signed by naming it in a request body, flow node or template.
 */

/** Signed URL lifetime for Meta (it fetches at send time). */
export const META_SIGNED_URL_TTL_SECONDS = 15 * 60
/** Signed URL lifetime handed to API consumers. */
export const API_SIGNED_URL_TTL_SECONDS = 60 * 60

export class MediaReferenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaReferenceError'
  }
}

let _admin: SupabaseClient | null = null
let _override: SupabaseClient | null = null

function admin(): SupabaseClient {
  if (_override) return _override
  if (!_admin) {
    _admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _admin
}

/** TEST SEAM (throws outside tests). */
export function setMediaAdminForTests(db: unknown | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setMediaAdminForTests is for tests only')
  }
  _override = db as SupabaseClient | null
}

/**
 * Unguessable but DETERMINISTIC object-name token: HMAC-SHA256 of a stable
 * input under a key derived from ENCRYPTION_KEY (so no new secret). Used where
 * a redelivered webhook must rewrite the same object (inbound mirror).
 * 32 hex chars = 128 bits.
 */
export function deriveObjectToken(accountId: string, stableId: string): string {
  const root = Buffer.from(process.env.ENCRYPTION_KEY!, 'hex')
  const key = createHmac('sha256', root).update('rlb-media-object-name-v1').digest()
  return createHmac('sha256', key)
    .update(`${accountId}:${stableId}`)
    .digest('hex')
    .slice(0, 32)
}

function authorisedRef(url: string, accountId: string): MediaRef {
  const ref = parseMediaRef(url)
  if (!ref) throw new MediaReferenceError('Invalid media reference')
  if (!mediaRefBelongsToAccount(ref, accountId)) {
    throw new MediaReferenceError('Media does not belong to this account')
  }
  return ref
}

/**
 * Turn a stored media reference into a URL Meta can fetch. External URLs are
 * returned unchanged. Throws `MediaReferenceError` for a reference that is
 * malformed, belongs to another account, or cannot be signed — and when no
 * account id is supplied (fail closed).
 */
export async function resolveMediaLinkForMeta(
  url: string,
  accountId: string | undefined,
): Promise<string> {
  if (!isMediaRef(url)) return url
  if (!accountId) throw new MediaReferenceError('A media reference requires an account')
  const ref = authorisedRef(url, accountId)
  const { data, error } = await admin()
    .storage.from(ref.bucket)
    .createSignedUrl(ref.path, META_SIGNED_URL_TTL_SECONDS)
  if (error || !data?.signedUrl) {
    throw new MediaReferenceError('Could not create a signed media URL')
  }
  return data.signedUrl
}

/** Signed URL for API consumers; passes external URLs and null through. */
export async function signMediaForApi(
  url: string | null,
  accountId: string,
): Promise<string | null> {
  if (!url || !isMediaRef(url)) return url
  const ref = parseMediaRef(url)
  if (!ref || !mediaRefBelongsToAccount(ref, accountId)) return null
  const { data } = await admin()
    .storage.from(ref.bucket)
    .createSignedUrl(ref.path, API_SIGNED_URL_TTL_SECONDS)
  return data?.signedUrl ?? null
}

/** Download an account's stored object (template-header samples). */
export async function downloadStoredMedia(
  url: string,
  accountId: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const ref = authorisedRef(url, accountId)
  const { data, error } = await admin().storage.from(ref.bucket).download(ref.path)
  if (error || !data) throw new MediaReferenceError('Could not read the stored media')
  return {
    bytes: new Uint8Array(await data.arrayBuffer()),
    contentType: (data.type || '').split(';')[0].trim().toLowerCase(),
  }
}
