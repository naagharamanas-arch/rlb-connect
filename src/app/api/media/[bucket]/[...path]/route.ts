import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import {
  accountFolder,
  buildMediaRef,
  parseMediaRef,
  type PrivateMediaBucket,
} from '@/lib/storage/media-url'

/** Lifetime of the signed URL this route redirects to. Re-authorised per request. */
const REDIRECT_SIGNED_URL_TTL_SECONDS = 120

/**
 * GET /api/media/<bucket>/account-<account_id>/<object>
 *
 * Browser access to the PRIVATE chat-media / flow-media buckets. The caller must
 * be signed in AND a member of the account that owns the object (viewer+); the
 * signing itself runs as the caller, so Storage's own row-level policies are a
 * second gate. Anything outside the caller's account answers 404 (not 403) so
 * the route cannot be used to probe for other tenants' object names.
 *
 * Replies 302 to a short-lived signed URL, so <img>, <video> and <audio>
 * elements stream with range requests from Storage directly.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ bucket: string; path: string[] }> },
) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { bucket, path } = await context.params

    // Rebuild a reference from the route params and re-parse it: one parser,
    // one set of traversal / bucket rules.
    const ref = parseMediaRef(
      buildMediaRef(bucket as PrivateMediaBucket, path.map(decodeURIComponent).join('/')),
    )
    if (!ref || !ref.path.startsWith(`${accountFolder(accountId)}/`)) {
      return notFound()
    }

    const { data, error } = await supabase.storage
      .from(ref.bucket)
      .createSignedUrl(ref.path, REDIRECT_SIGNED_URL_TTL_SECONDS)
    if (error || !data?.signedUrl) return notFound()

    const res = NextResponse.redirect(data.signedUrl, 302)
    res.headers.set('Cache-Control', 'private, no-store')
    return res
  } catch (error) {
    return toErrorResponse(error)
  }
}

function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
