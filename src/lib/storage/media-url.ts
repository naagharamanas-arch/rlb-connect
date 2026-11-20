/**
 * Media references for the PRIVATE `chat-media` and `flow-media` buckets.
 *
 * Those buckets are not public, so a stored URL can never be a bucket URL. What
 * is stored (in `messages.media_url`, flow node config, template headers) is a
 * same-origin, account-scoped reference:
 *
 *   /api/media/<bucket>/account-<account_id>/<object name>
 *
 * - In the browser it is fetched with the session cookie. The route
 *   (src/app/api/media/[bucket]/[...path]/route.ts) authorises the caller and
 *   redirects to a short-lived signed URL.
 * - At send time the SERVER turns it into a short-lived signed URL for Meta
 *   (src/lib/storage/media-server.ts), after checking the object belongs to the
 *   sending account.
 *
 * This module is pure and client-safe. External `https://` links (a URL a user
 * pastes) are NOT media references and pass through everywhere untouched.
 * Avatars stay in the public `avatars` bucket and never use this.
 */

export const MEDIA_PROXY_PREFIX = '/api/media/'

/** Buckets that are private and served only through media references. */
export const PRIVATE_MEDIA_BUCKETS = ['chat-media', 'flow-media'] as const
export type PrivateMediaBucket = (typeof PRIVATE_MEDIA_BUCKETS)[number]

export interface MediaRef {
  bucket: PrivateMediaBucket
  /** Object path inside the bucket, e.g. `account-<uuid>/<token>-name.jpg`. */
  path: string
}

/** Build the stored reference for an object in a private bucket. */
export function buildMediaRef(bucket: PrivateMediaBucket, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${MEDIA_PROXY_PREFIX}${bucket}/${encoded}`
}

/** True for a same-origin media reference (not an external URL). */
export function isMediaRef(url: string | null | undefined): url is string {
  return typeof url === 'string' && url.startsWith(MEDIA_PROXY_PREFIX)
}

/**
 * Parse a media reference. Returns null for anything that is not one, for an
 * unknown bucket, or for a path containing traversal segments.
 */
export function parseMediaRef(url: string | null | undefined): MediaRef | null {
  if (!isMediaRef(url)) return null
  const rest = url.slice(MEDIA_PROXY_PREFIX.length).split(/[?#]/)[0]
  const [bucket, ...segments] = rest.split('/')
  if (!(PRIVATE_MEDIA_BUCKETS as readonly string[]).includes(bucket)) return null
  if (segments.length < 2) return null
  let decoded: string[]
  try {
    decoded = segments.map(decodeURIComponent)
  } catch {
    return null
  }
  if (
    decoded.some(
      (s) => s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes('/'),
    )
  ) {
    return null
  }
  return { bucket: bucket as PrivateMediaBucket, path: decoded.join('/') }
}

/** The account folder segment every private-bucket object lives under. */
export function accountFolder(accountId: string): string {
  return `account-${accountId}`
}

/** True when the reference points inside `accountId`'s folder. */
export function mediaRefBelongsToAccount(ref: MediaRef, accountId: string): boolean {
  return ref.path.startsWith(`${accountFolder(accountId)}/`)
}
