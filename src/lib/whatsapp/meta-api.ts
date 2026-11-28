/**
 * Meta WhatsApp Cloud API helpers.
 *
 * Every function takes a single options object (named parameters) instead
 * of positional arguments. This was a deliberate choice after the same
 * swapped-args bug was found four times in a row with the positional form
 * (e.g. `(accessToken, phoneNumberId)` vs `(phoneNumberId, accessToken)`).
 * With named params, a typo surfaces immediately as a TypeScript error
 * instead of a runtime rejection from Meta.
 */

import { isBusinessScopedUserId } from './wa-identity'
import type { RawPhoneConnectionFacts } from './connection-status'
import { getT } from '@/lib/i18n/translate'
import { INTERACTIVE_LIMITS } from './interactive-limits'
import { resolveMediaLinkForMeta } from '@/lib/storage/media-server'

const ti = getT('Validation.interactive')

/**
 * The Graph API version EVERY Meta call in this app uses. This is the single
 * source of truth: import `META_API_BASE` instead of declaring a version
 * anywhere else (a guard test fails the build if a second literal appears).
 *
 * Version policy (checked against Meta's published Graph API version table):
 *   v21.0 was released 2024-10-02 and is available until 2027-01-21. After a
 *   version is removed Meta defaults calls to the next usable one rather than
 *   failing, so this is a planned upgrade, not an outage — but it should be
 *   done before that date, deliberately, not by fallback. Moving is a ONE-LINE
 *   change here once the Cloud API calls below have been smoke-tested against
 *   the newer version on a Meta test number. Review the WhatsApp Cloud API
 *   changelog entries for v22–v26 first (template category handling,
 *   messaging-limit semantics, status-webhook payload and media-retention
 *   changes).
 *
 *   (verify) Decision 2026-11-28: S1 keeps v21.0. Follow-up R2 — a separate PR,
 *   done BEFORE the S2 runtime test — bumps it. Take the target from Meta's
 *   LIVE Graph versions table, not from a search result or this comment
 *   (Meta's dialog URL already showed v27.0, so v26.0 is not the latest).
 */
export const META_API_VERSION = 'v21.0'
export const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

export interface MetaSendResult {
  messageId: string
}

export interface MetaPhoneInfo {
  id: string
  display_phone_number: string
  verified_name?: string
  quality_rating?: string
}

export interface MetaPhoneHealth {
  id: string
  display_phone_number?: string
  quality_rating?: string
  whatsapp_business_manager_messaging_limit?: string
}

interface MetaErrorResponse {
  error?: {
    message?: string
    code?: number
    error_subcode?: number
    type?: string
    fbtrace_id?: string
    /** WhatsApp-specific envelope — `details` is the human-readable part. */
    error_data?: { messaging_product?: string; details?: string }
  }
}

/**
 * A Graph API failure with Meta's structured envelope preserved.
 *
 * `message` stays what it always was (Meta's `error.message`, or the
 * caller's fallback when the body wasn't JSON) so every existing
 * `err.message` consumer keeps working. The extra fields are what
 * `meta-error-explain.ts` needs to say *why* a call failed and which
 * setting to check — and what a user has to quote to Meta support
 * (`fbtrace_id`). Issue #505.
 */
export class MetaApiError extends Error {
  readonly code: number | null
  readonly subcode: number | null
  readonly type: string | null
  readonly fbtraceId: string | null
  readonly httpStatus: number
  /** `error.error_data.details` — WhatsApp endpoints put the useful text here. */
  readonly details: string | null

  constructor(
    message: string,
    fields: {
      code?: number | null
      subcode?: number | null
      type?: string | null
      fbtraceId?: string | null
      httpStatus: number
      details?: string | null
    },
  ) {
    super(message)
    this.name = 'MetaApiError'
    this.code = fields.code ?? null
    this.subcode = fields.subcode ?? null
    this.type = fields.type ?? null
    this.fbtraceId = fields.fbtraceId ?? null
    this.httpStatus = fields.httpStatus
    this.details = fields.details ?? null
  }
}

/**
 * Read a failed Graph response into a MetaApiError without throwing.
 * Consumes the body — call at most once per response.
 */
async function readMetaError(response: Response, fallback: string): Promise<MetaApiError> {
  let message = fallback
  let envelope: MetaErrorResponse['error'] | undefined
  try {
    const data = (await response.json()) as MetaErrorResponse
    envelope = data.error
    if (envelope?.message) message = envelope.message
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  return new MetaApiError(message, {
    code: typeof envelope?.code === 'number' ? envelope.code : null,
    subcode: typeof envelope?.error_subcode === 'number' ? envelope.error_subcode : null,
    type: envelope?.type ?? null,
    fbtraceId: envelope?.fbtrace_id ?? null,
    httpStatus: response.status,
    details: envelope?.error_data?.details ?? null,
  })
}

async function throwMetaError(response: Response, fallback: string): Promise<never> {
  throw await readMetaError(response, fallback)
}

// ============================================================
// Phone number / account
// ============================================================

export interface VerifyPhoneNumberArgs {
  phoneNumberId: string
  accessToken: string
}

/**
 * Verify a Meta phone number ID by fetching its public metadata
 * (display_phone_number, verified_name, quality_rating).
 */
export async function verifyPhoneNumber(
  args: VerifyPhoneNumberArgs
): Promise<MetaPhoneInfo> {
  const { phoneNumberId, accessToken } = args
  const url = `${META_API_BASE}/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  return response.json()
}

export async function getPhoneNumberHealth(
  args: VerifyPhoneNumberArgs
): Promise<MetaPhoneHealth> {
  const { phoneNumberId, accessToken } = args
  const headers = { Authorization: `Bearer ${accessToken}` }
  const [response, limitResponse] = await Promise.all([
    fetch(`${META_API_BASE}/${phoneNumberId}?fields=id,display_phone_number,quality_rating`, { headers }),
    fetch(`${META_API_BASE}/${phoneNumberId}?fields=whatsapp_business_manager_messaging_limit`, { headers }).catch(
      () => null
    ),
  ])
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const health: MetaPhoneHealth = await response.json()
  if (limitResponse?.ok) {
    const limit = (await limitResponse.json().catch(() => null)) as Pick<
      MetaPhoneHealth,
      'whatsapp_business_manager_messaging_limit'
    > | null
    if (limit?.whatsapp_business_manager_messaging_limit) {
      health.whatsapp_business_manager_messaging_limit = limit.whatsapp_business_manager_messaging_limit
    }
  }
  return health
}

/**
 * Best-effort, read-only: which kind of number is this? (Coexistence / test /
 * Cloud API.) Used only for the Settings status display (WA_STATUS_V2).
 *
 * Each field is requested on its OWN request: Graph answers a whole request
 * with error #100 when a single field name is unknown on the pinned version,
 * and one unsupported field must never take the others (or the existing
 * verify call) down. Never throws; a field that could not be read is absent.
 * Field names are (verify) against the current Meta docs.
 */
export async function getPhoneConnectionKind(
  args: VerifyPhoneNumberArgs
): Promise<RawPhoneConnectionFacts> {
  const { phoneNumberId, accessToken } = args
  const headers = { Authorization: `Bearer ${accessToken}` }
  const read = async (field: string): Promise<unknown> => {
    try {
      const response = await fetch(`${META_API_BASE}/${phoneNumberId}?fields=${field}`, { headers })
      if (!response.ok) return undefined
      const data = (await response.json()) as Record<string, unknown>
      return data?.[field]
    } catch {
      return undefined
    }
  }
  const [platformType, isOnBizApp, accountMode] = await Promise.all([
    read('platform_type'),
    read('is_on_biz_app'),
    read('account_mode'),
  ])
  return {
    platformType: typeof platformType === 'string' ? platformType : null,
    isOnBizApp: typeof isOnBizApp === 'boolean' ? isOnBizApp : null,
    accountMode: typeof accountMode === 'string' ? accountMode : null,
  }
}

// ============================================================
// Cloud API registration (subscription for inbound webhooks)
// ============================================================
//
// Saving a phone_number_id + access_token to whatsapp_config is NOT
// enough to receive inbound events from Meta. Two extra calls are
// required:
//
//   POST /{phone_number_id}/register
//     Subscribes the number for THIS app's webhook. Requires a
//     6-digit 2FA PIN the user previously set in Meta WhatsApp
//     Manager → Two-step verification. Without /register, inbound
//     events are routed to whichever app last claimed the number
//     (often the one that did Embedded Signup) — so a second user
//     adding a second number under the same WABA silently loses
//     every inbound message.
//
//   POST /{waba_id}/subscribed_apps
//     Subscribes the WABA itself to this app. Required exactly
//     once per WABA, but idempotent so calling on every save is
//     safe and cheap.
//
// Both calls are no-ops when already done — Meta returns success +
// the helpers below treat that as success.

export interface RegisterPhoneNumberArgs {
  phoneNumberId: string
  accessToken: string
  /**
   * 6-digit PIN the user set in Meta WhatsApp Manager →
   * Two-step verification. If 2FA is not enabled on the number,
   * Meta rejects /register with a clear error and the user is
   * pointed at the right setting in the UI.
   */
  pin: string
}

export interface RegisterPhoneNumberResult {
  success: boolean
  /**
   * True when Meta indicated the number was already registered to
   * THIS app — same outcome as a fresh registration from the
   * caller's POV, surfaced separately for logging clarity.
   */
  alreadyRegistered: boolean
}

/**
 * Register a phone number for inbound webhook events.
 *
 * Errors that should be surfaced verbatim to the user:
 *   * Missing / wrong PIN  → "Two-step verification PIN required..."
 *   * No 2FA enabled       → "Two-factor authentication is not on..."
 *   * Number on other app  → "Number is registered to another app..."
 */
export async function registerPhoneNumber(
  args: RegisterPhoneNumberArgs
): Promise<RegisterPhoneNumberResult> {
  const { phoneNumberId, accessToken, pin } = args
  const url = `${META_API_BASE}/${phoneNumberId}/register`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  })

  if (response.ok) {
    return { success: true, alreadyRegistered: false }
  }

  // Meta returns an error envelope with a code. Code 133005 + the
  // text "already registered" appears when the number is already
  // subscribed to this app — that's success from the caller's
  // perspective, surface it as such.
  const error = await readMetaError(response, `Meta API error: ${response.status}`)
  if (/already.*registered/i.test(error.message)) {
    return { success: true, alreadyRegistered: true }
  }
  throw error
}

export interface SubscribeWabaToAppArgs {
  wabaId: string
  accessToken: string
}

/**
 * Subscribe the WABA to this Meta app's webhook. Idempotent — Meta
 * returns success even when the subscription already exists.
 */
export async function subscribeWabaToApp(
  args: SubscribeWabaToAppArgs
): Promise<void> {
  const { wabaId, accessToken } = args
  const url = `${META_API_BASE}/${wabaId}/subscribed_apps`
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
}

export interface ListWabaPhoneNumbersArgs {
  wabaId: string
  accessToken: string
}

export interface WabaPhoneNumber {
  id: string
  display_phone_number?: string
  verified_name?: string
}

/**
 * List the phone numbers that live under a WABA.
 *
 * Used by POST /api/whatsapp/config to prove the Phone Number ID the
 * user typed actually belongs to the WABA ID they typed. A mismatch
 * used to save fine and surface days later as "the webhook never
 * fires" — the WABA that got subscribed wasn't the one owning the
 * number (issue #505). Follows `paging.next` a few pages in case a
 * WABA holds more numbers than one page returns.
 */
export async function listWabaPhoneNumbers(
  args: ListWabaPhoneNumbersArgs
): Promise<WabaPhoneNumber[]> {
  const { wabaId, accessToken } = args
  const out: WabaPhoneNumber[] = []
  let url: string | undefined =
    `${META_API_BASE}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100`
  for (let page = 0; url && page < 5; page++) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      await throwMetaError(response, `Meta API error: ${response.status}`)
    }
    const data = (await response.json()) as {
      data?: WabaPhoneNumber[]
      paging?: { next?: string }
    }
    out.push(...(data.data ?? []))
    url = data.paging?.next
  }
  return out
}

export interface GetSubscribedAppsArgs {
  wabaId: string
  accessToken: string
}

export interface SubscribedApp {
  whatsapp_business_api_data?: {
    id?: string
    name?: string
    link?: string
  }
}

/**
 * Diagnostic — fetch the list of apps currently subscribed to this
 * WABA. The UI uses this to confirm OUR app is in the list when
 * the user clicks Verify Registration.
 */
export async function getSubscribedApps(
  args: GetSubscribedAppsArgs
): Promise<SubscribedApp[]> {
  const { wabaId, accessToken } = args
  const url = `${META_API_BASE}/${wabaId}/subscribed_apps`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = (await response.json()) as { data?: SubscribedApp[] }
  return data.data ?? []
}

// ============================================================
// Embedded Signup helpers (docs/architecture/09, slice S1)
// ============================================================
//
// Server-side only, not called by any route yet (S1 is inert). All of them
// use META_API_BASE — the single Graph version constant. Every Graph path,
// parameter and field name below that is not already used elsewhere in this
// file is UNVERIFIED against the current Meta docs and marked "(verify)";
// re-read the docs before the slice that wires them (S2).
//
// Secrets: the app id and the Embedded Signup app secret are read from the
// environment at CALL time (never at import, never hardcoded). No function
// here puts the code, a token or the secret into an error message or a log
// line; Meta's own error envelope (message/code/fbtrace_id) is passed through
// `readMetaError` exactly like every other helper.

/** Env var names for the Embedded Signup app (values are never exposed). */
const ES_APP_ID_ENV = 'META_APP_ID'
const ES_APP_SECRET_ENV = 'META_ES_APP_SECRET'

function readEsAppCredentials(): { appId: string; appSecret: string } {
  const appId = process.env[ES_APP_ID_ENV]?.trim()
  const appSecret = process.env[ES_APP_SECRET_ENV]?.trim()
  // Name the variable only — never the value.
  if (!appId) throw new Error(`${ES_APP_ID_ENV} is not set`)
  if (!appSecret) throw new Error(`${ES_APP_SECRET_ENV} is not set`)
  return { appId, appSecret }
}

export interface ExchangeCodeForTokenArgs {
  /** The single-use `code` returned by FB.login. Never logged or stored. */
  code: string
}

export interface ExchangeCodeForTokenResult {
  accessToken: string
  tokenType: string | null
  /** Seconds until expiry when Meta reports one (verify: business tokens may omit it). */
  expiresInSeconds: number | null
}

/**
 * Exchange the Embedded Signup `code` for a business token, server-side.
 *
 * GET {graph}/oauth/access_token?client_id&client_secret&code (verify; also
 * verify whether `redirect_uri` is required for the JS-SDK flow). The code is
 * single-use and very short-lived: call this before any other await.
 */
export async function exchangeCodeForToken(
  args: ExchangeCodeForTokenArgs
): Promise<ExchangeCodeForTokenResult> {
  const { appId, appSecret } = readEsAppCredentials()
  const params = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    code: args.code,
  })
  const response = await fetch(`${META_API_BASE}/oauth/access_token?${params.toString()}`)
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = (await response.json().catch(() => null)) as {
    access_token?: unknown
    token_type?: unknown
    expires_in?: unknown
  } | null
  if (!data || typeof data.access_token !== 'string' || data.access_token === '') {
    throw new Error('Meta token exchange returned no access token')
  }
  return {
    accessToken: data.access_token,
    tokenType: typeof data.token_type === 'string' ? data.token_type : null,
    expiresInSeconds: typeof data.expires_in === 'number' ? data.expires_in : null,
  }
}

export interface DebugTokenArgs {
  /** The business token to inspect. */
  inputToken: string
}

export interface DebugTokenGranularScope {
  scope: string
  /** Object ids (e.g. WABA ids) the scope is granted on (verify shape). */
  targetIds: string[]
}

export interface DebugTokenResult {
  appId: string | null
  isValid: boolean
  type: string | null
  scopes: string[]
  granularScopes: DebugTokenGranularScope[]
  /** Unix seconds; 0/absent means "does not expire" (verify). */
  expiresAt: number | null
}

/**
 * Inspect a token with an app access token (`{app_id}|{app_secret}`, verify).
 * The caller must check `appId` equals ours and that the granular scopes list
 * the WABA before trusting anything the browser sent.
 */
export async function debugToken(args: DebugTokenArgs): Promise<DebugTokenResult> {
  const { appId, appSecret } = readEsAppCredentials()
  const params = new URLSearchParams({
    input_token: args.inputToken,
    access_token: `${appId}|${appSecret}`,
  })
  const response = await fetch(`${META_API_BASE}/debug_token?${params.toString()}`)
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const body = (await response.json().catch(() => null)) as {
    data?: {
      app_id?: unknown
      is_valid?: unknown
      type?: unknown
      scopes?: unknown
      granular_scopes?: unknown
      expires_at?: unknown
    }
  } | null
  const d = body?.data
  if (!d || typeof d !== 'object') {
    throw new Error('Meta debug_token returned no data')
  }
  const granular: DebugTokenGranularScope[] = Array.isArray(d.granular_scopes)
    ? (d.granular_scopes as Array<{ scope?: unknown; target_ids?: unknown }>)
        .filter((g) => typeof g?.scope === 'string')
        .map((g) => ({
          scope: g.scope as string,
          targetIds: Array.isArray(g.target_ids)
            ? g.target_ids.filter((t): t is string => typeof t === 'string')
            : [],
        }))
    : []
  return {
    appId: typeof d.app_id === 'string' ? d.app_id : null,
    isValid: d.is_valid === true,
    type: typeof d.type === 'string' ? d.type : null,
    scopes: Array.isArray(d.scopes)
      ? d.scopes.filter((s): s is string => typeof s === 'string')
      : [],
    granularScopes: granular,
    expiresAt: typeof d.expires_at === 'number' ? d.expires_at : null,
  }
}

export interface GetWabaPhoneNumberDetailsArgs {
  wabaId: string
  accessToken: string
}

export interface WabaPhoneNumberDetails extends WabaPhoneNumber {
  /**
   * Meta's platform classification for the number (e.g. Cloud API vs. WhatsApp
   * Business app / coexistence). Field name and values are UNVERIFIED (verify);
   * null when Meta does not return it on this Graph version.
   */
  platformType: string | null
}

/**
 * The numbers under a WABA with the extra detail Embedded Signup needs to
 * classify path A vs B. `platform_type` (verify) is requested in a request
 * of its own: if this Graph version rejects the unknown field the call falls
 * back to the base fields (platformType null) instead of failing the connect —
 * the same defensive pattern as `getPhoneConnectionKind`.
 */
export async function getWabaPhoneNumberDetails(
  args: GetWabaPhoneNumberDetailsArgs
): Promise<WabaPhoneNumberDetails[]> {
  const { wabaId, accessToken } = args
  const headers = { Authorization: `Bearer ${accessToken}` }
  const base = `${META_API_BASE}/${wabaId}/phone_numbers`
  const extended = await fetch(
    `${base}?fields=id,display_phone_number,verified_name,platform_type&limit=100`, // platform_type (verify)
    { headers }
  )
  if (extended.ok) {
    const data = (await extended.json().catch(() => null)) as {
      data?: Array<WabaPhoneNumber & { platform_type?: unknown }>
    } | null
    return (data?.data ?? []).map((n) => ({
      id: n.id,
      display_phone_number: n.display_phone_number,
      verified_name: n.verified_name,
      platformType: typeof n.platform_type === 'string' ? n.platform_type : null,
    }))
  }
  if (extended.status !== 400) {
    await throwMetaError(extended, `Meta API error: ${extended.status}`)
  }
  const numbers = await listWabaPhoneNumbers({ wabaId, accessToken })
  return numbers.map((n) => ({ ...n, platformType: null }))
}

export interface UnsubscribeWabaFromAppArgs {
  wabaId: string
  accessToken: string
}

/**
 * Remove this app's webhook subscription from the WABA (disconnect).
 * DELETE {graph}/{waba}/subscribed_apps (verify). Best-effort at the caller:
 * a failure here must not block the local disconnect.
 */
export async function unsubscribeWabaFromApp(
  args: UnsubscribeWabaFromAppArgs
): Promise<void> {
  const { wabaId, accessToken } = args
  const response = await fetch(`${META_API_BASE}/${wabaId}/subscribed_apps`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
}

// ============================================================
// Sending
// ============================================================

/**
 * Address a send at either a phone number or a business-scoped user ID.
 *
 * Meta uses two mutually-exclusive fields: `to` (+ `recipient_type`)
 * for a phone number, and `recipient` for a BSUID or parent BSUID
 * (issue #519). Every send helper below routes its `to` argument
 * through this, so callers hand over whichever identifier they hold and
 * don't have to know which field Meta wants.
 *
 * The two are never ambiguous: a sanitized phone number is digits only,
 * and a BSUID always carries a two-letter prefix and a dot.
 */
function recipientFields(to: string): Record<string, unknown> {
  return isBusinessScopedUserId(to)
    ? { recipient: to.trim() }
    : { recipient_type: 'individual', to }
}

export interface SendTextMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  text: string
  /** Meta's message_id of the message being replied to. Adds a `context` field
   *  so WhatsApp renders the new message as a reply with a quote preview. */
  contextMessageId?: string
}

/**
 * Send a free-form WhatsApp text message.
 * Only works inside the 24-hour customer service window.
 */
export async function sendTextMessage(
  args: SendTextMessageArgs
): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, text, contextMessageId } = args
  const url = `${META_API_BASE}/${phoneNumberId}/messages`
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    ...recipientFields(to),
    type: 'text',
    text: { body: text },
  }
  if (contextMessageId) {
    body.context = { message_id: contextMessageId }
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

export type MediaKind = 'image' | 'video' | 'document' | 'audio'

export interface SendMediaMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  kind: MediaKind
  /** URL Meta fetches at send time: an external URL, or a private-bucket media reference (signed here). */
  link: string
  /**
   * Account the sender belongs to. REQUIRED whenever `link` is a private-bucket
   * media reference: it is checked against the object's account folder, and the
   * send fails closed without it.
   */
  mediaAccountId?: string
  /** Optional caption — Meta caps at 1024 chars. Documents + images + videos accept it; audio does NOT. */
  caption?: string
  /** Document-only. Shown in the recipient's chat as the file name. Ignored for image/video/audio. */
  filename?: string
  contextMessageId?: string
}

/**
 * Send an image, video, document, or audio (voice note) via a public URL.
 *
 * Used by the Flows engine's `send_media` node and the inbox composer's
 * agent-initiated media sends. Mirrors `sendTextMessage` — single fetch,
 * throws on non-2xx, returns Meta's message id.
 *
 * Audio is special-cased: Meta rejects `caption` and `filename` on audio
 * messages, so we send `{ link }` only. WhatsApp auto-renders an
 * OGG/Opus file as a playable voice note (waveform) rather than a file
 * attachment.
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs,
): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, kind, caption, filename, contextMessageId } = args
  if (!args.link) throw new Error('sendMediaMessage requires a link.')
  // A private-bucket media reference becomes a short-lived signed URL here, after
  // an account-ownership check. External URLs pass through untouched.
  const link = await resolveMediaLinkForMeta(args.link, args.mediaAccountId)
  const url = `${META_API_BASE}/${phoneNumberId}/messages`

  // Audio accepts neither caption nor filename per Meta's spec — adding
  // either yields a 400. image/video/document accept a caption; only
  // document accepts a filename.
  const media: Record<string, unknown> = { link }
  if (caption && kind !== 'audio') media.caption = caption
  if (kind === 'document' && filename) media.filename = filename

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    ...recipientFields(to),
    type: kind,
    [kind]: media,
  }
  if (contextMessageId) body.context = { message_id: contextMessageId }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

import type { MessageTemplate } from '@/types'
import {
  buildSendComponents,
  type SendTimeParams,
} from './template-send-builder'

export interface SendTemplateMessageArgs {
  /** See SendMediaMessageArgs.mediaAccountId — needed when the header media is a private-bucket reference. */
  mediaAccountId?: string
  phoneNumberId: string
  accessToken: string
  to: string
  templateName: string
  language?: string
  /**
   * Legacy body-only params. Kept for backward compat with callers
   * that haven't migrated to the structured `template` + `messageParams`
   * pair below. New callers should pass `template` so media headers
   * and URL buttons land on the send.
   */
  params?: string[]
  /**
   * The template row from message_templates. When provided, the helper
   * builds the full components array (header + body + buttons) via
   * buildSendComponents — that's the only way image/video/document
   * headers and URL-with-variable buttons actually reach the recipient.
   */
  template?: MessageTemplate
  /**
   * Structured per-send values. Body variables go in `body`; header
   * text variables in `headerText`; media overrides in
   * `headerMediaUrl` / `headerMediaId`; URL/COPY_CODE button values
   * in `buttonParams` keyed by index.
   */
  messageParams?: SendTimeParams
  /** Meta's message_id of the message being replied to. */
  contextMessageId?: string
}

/**
 * Send a pre-approved WhatsApp message template. Required outside
 * the 24-hour window and for any first-touch messaging.
 *
 * Caller paths:
 *   - Legacy: pass `params: string[]` (body only). Same behaviour as
 *     before this helper learned about media + buttons.
 *   - Structured: pass `template` (and optionally `messageParams`).
 *     The full components array is built from the row so media
 *     headers + URL buttons land correctly.
 */
export async function sendTemplateMessage(
  args: SendTemplateMessageArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    templateName,
    language = 'en_US',
    params,
    template,
    messageParams,
    contextMessageId,
  } = args
  const url = `${META_API_BASE}/${phoneNumberId}/messages`

  const templatePayload: Record<string, unknown> = {
    name: templateName,
    language: { code: language },
  }

  if (template) {
    // Resolve private-bucket media references (header image/video/document) to
    // short-lived signed URLs before Meta sees them. Fails closed without an
    // account id; external URLs pass through.
    const headerMediaUrl = messageParams?.headerMediaUrl
      ? await resolveMediaLinkForMeta(messageParams.headerMediaUrl, args.mediaAccountId)
      : undefined
    const sendTemplate = template.header_media_url
      ? {
          ...template,
          header_media_url: await resolveMediaLinkForMeta(
            template.header_media_url,
            args.mediaAccountId,
          ),
        }
      : template
    const components = buildSendComponents(sendTemplate, {
      // Legacy callers pass body values in `params`; fold them into
      // `messageParams.body` so the new path covers them too.
      body: messageParams?.body ?? params,
      headerText: messageParams?.headerText,
      headerMediaUrl,
      headerMediaId: messageParams?.headerMediaId,
      buttonParams: messageParams?.buttonParams,
    })
    if (components.length > 0) {
      templatePayload.components = components
    }
  } else if (params && params.length > 0) {
    // Legacy body-only path — no template row available.
    templatePayload.components = [
      {
        type: 'body',
        parameters: params.map((p) => ({ type: 'text', text: String(p) })),
      },
    ]
  }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    ...recipientFields(to),
    type: 'template',
    template: templatePayload,
  }
  if (contextMessageId) {
    body.context = { message_id: contextMessageId }
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

// ============================================================
// Resumable Upload (media handles for template headers)
// ============================================================
//
// Creating a message template with a media HEADER (image/video/
// document) requires an `example.header_handle` — Meta does NOT accept
// a plain public URL at creation time. The handle comes from the
// two-step Resumable Upload API, which is keyed on the Meta APP id (not
// the phone number / WABA):
//
//   1. POST /{app_id}/uploads?file_name&file_length&file_type&access_token
//        → { id: "upload:<session>" }
//   2. POST /{id}  (Authorization: OAuth <token>, file_offset: 0, raw bytes)
//        → { h: "<handle>" }
//
// See https://developers.facebook.com/docs/graph-api/guides/upload

export interface UploadResumableMediaArgs {
  /** Meta App id (env META_APP_ID) — resumable upload is app-scoped. */
  appId: string
  accessToken: string
  fileName: string
  mimeType: string
  bytes: Uint8Array
}

/**
 * Upload a file via the Resumable Upload API and return the media
 * handle to use as `example.header_handle` when creating/editing a
 * template with a media header.
 */
export async function uploadResumableMedia(
  args: UploadResumableMediaArgs,
): Promise<{ handle: string }> {
  const { appId, accessToken, fileName, mimeType, bytes } = args

  // Step 1 — open an upload session.
  const startParams = new URLSearchParams({
    file_name: fileName,
    file_length: String(bytes.byteLength),
    file_type: mimeType,
    access_token: accessToken,
  })
  const startRes = await fetch(
    `${META_API_BASE}/${appId}/uploads?${startParams.toString()}`,
    { method: 'POST' },
  )
  if (!startRes.ok) {
    await throwMetaError(startRes, `Resumable upload start failed: ${startRes.status}`)
  }
  const startData = (await startRes.json()) as { id?: string }
  if (!startData.id) {
    throw new Error('Resumable upload did not return a session id.')
  }

  // Step 2 — upload the bytes. Note the `OAuth` auth scheme (not Bearer)
  // and the file_offset header, both required by this endpoint.
  const uploadRes = await fetch(`${META_API_BASE}/${startData.id}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${accessToken}`,
      file_offset: '0',
    },
    // Uint8Array is a valid BodyInit at runtime; cast around the
    // lib.dom ArrayBufferLike-vs-ArrayBuffer generic mismatch.
    body: bytes as unknown as BodyInit,
  })
  if (!uploadRes.ok) {
    await throwMetaError(uploadRes, `Resumable upload failed: ${uploadRes.status}`)
  }
  const uploadData = (await uploadRes.json()) as { h?: string }
  if (!uploadData.h) {
    throw new Error('Resumable upload did not return a file handle.')
  }
  return { handle: uploadData.h }
}

// ============================================================
// Template submission (Business Management API)
// ============================================================

import type { MetaTemplateSubmitPayload } from './template-components'

export interface SubmitMessageTemplateArgs {
  wabaId: string
  accessToken: string
  payload: MetaTemplateSubmitPayload
}

export interface SubmitMessageTemplateResult {
  id: string
  status: string
  category?: string
}

/**
 * Submit a message template to Meta for approval.
 *
 * Returns Meta's assigned template id + initial status (typically
 * PENDING). Caller persists `id` as `meta_template_id` so the
 * upcoming edit/delete flows can scope to this exact template (and
 * language variant) via `hsm_id`, rather than nuking every variant
 * with the same name.
 *
 * 429s from Meta (rate limit: 100 creates/hour/WABA) surface as a
 * regular `Error('Meta API error: 429')`. The route handler
 * distinguishes 429 and shows a more actionable toast.
 */
export async function submitMessageTemplate(
  args: SubmitMessageTemplateArgs
): Promise<SubmitMessageTemplateResult> {
  const { wabaId, accessToken, payload } = args
  const url = `${META_API_BASE}/${wabaId}/message_templates`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  if (!data?.id) {
    throw new Error('Meta accepted the template but returned no id.')
  }
  return {
    id: String(data.id),
    status: typeof data.status === 'string' ? data.status : 'PENDING',
    category: typeof data.category === 'string' ? data.category : undefined,
  }
}

export interface EditMessageTemplateArgs {
  /** Meta's template id (stored locally as `meta_template_id`). */
  metaTemplateId: string
  accessToken: string
  /** Send the full components array — Meta replaces, not patches. */
  components: MetaTemplateSubmitPayload['components']
  /** Optional — only certain category transitions are allowed by Meta. */
  category?: MetaTemplateSubmitPayload['category']
}

export interface EditMessageTemplateResult {
  success: boolean
}

/**
 * Edit an existing (APPROVED or REJECTED) message template.
 *
 * Meta caps edits at 10 per 30 days (and 1 per 24h for APPROVED
 * templates). Every edit re-triggers review, so the status flips
 * back to PENDING until Meta approves the new components.
 *
 * Note: PENDING / DISABLED / IN_APPEAL templates cannot be edited
 * — the route handler enforces that before calling here.
 */
export async function editMessageTemplate(
  args: EditMessageTemplateArgs
): Promise<EditMessageTemplateResult> {
  const { metaTemplateId, accessToken, components, category } = args
  const body: Record<string, unknown> = { components }
  if (category) body.category = category
  const response = await fetch(`${META_API_BASE}/${metaTemplateId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json().catch(() => ({}))
  return { success: data?.success !== false }
}

export interface DeleteMessageTemplateArgs {
  wabaId: string
  accessToken: string
  name: string
  /**
   * Without `hsm_id`, Meta deletes EVERY language variant of the
   * template with this `name`. Pass the row's `meta_template_id`
   * to scope to a single variant.
   */
  metaTemplateId?: string
}

/**
 * Delete a message template on Meta. Pass `metaTemplateId` to scope
 * to a single language variant — otherwise Meta nukes every variant
 * sharing the same `name`.
 */
export async function deleteMessageTemplate(
  args: DeleteMessageTemplateArgs
): Promise<void> {
  const { wabaId, accessToken, name, metaTemplateId } = args
  const params = new URLSearchParams({ name })
  if (metaTemplateId) params.set('hsm_id', metaTemplateId)
  const url = `${META_API_BASE}/${wabaId}/message_templates?${params.toString()}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  // Treat a 404 as a no-op — the template is already gone on Meta's
  // side, and we still want the local row removed.
  if (response.status === 404) return
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
}

// ============================================================
// Reactions
// ============================================================

export interface SendReactionMessageArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  /** Meta's message_id of the message being reacted to. */
  targetMessageId: string
  /** Single emoji, or empty string to remove an existing reaction. */
  emoji: string
}

/**
 * Send a reaction (or removal) to a previously-exchanged message.
 * Empty `emoji` removes the reaction per Meta's spec.
 */
export async function sendReactionMessage(
  args: SendReactionMessageArgs
): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, targetMessageId, emoji } = args
  const url = `${META_API_BASE}/${phoneNumberId}/messages`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      ...recipientFields(to),
      type: 'reaction',
      reaction: { message_id: targetMessageId, emoji },
    }),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

// ============================================================
// Typing indicator (rides on the read receipt)
// ============================================================

export interface SendTypingIndicatorArgs {
  phoneNumberId: string
  accessToken: string
  /** Meta's wamid of the INBOUND message we're about to answer — must
   *  come from a received-message webhook, not one of our own sends. */
  messageId: string
}

/**
 * Mark an inbound message as read AND show "typing…" to the customer.
 *
 * One request does both: Meta's typing indicator is a field on the
 * read-status update. The indicator clears after 25 seconds or as soon
 * as the business sends a message, whichever comes first, so there is
 * nothing to cancel. Meta asks that it only be shown when a reply is
 * actually coming.
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators
 *
 * Returns nothing — the endpoint answers `{ success: true }` and mints
 * no message id. Callers should treat it as best-effort: a failure here
 * must never block the reply that follows.
 */
export async function sendTypingIndicator(
  args: SendTypingIndicatorArgs
): Promise<void> {
  const { phoneNumberId, accessToken, messageId } = args
  const url = `${META_API_BASE}/${phoneNumberId}/messages`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    }),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
}

// ============================================================
// Interactive (button replies + list messages)
// ============================================================
//
// Meta's two flavours of interactive message — used by the Flows
// engine to drive scripted chatbot menus. Caller passes plain
// JS values; helpers shape the Meta payload and enforce Meta's
// limits BEFORE the network call so the failure mode is a
// developer-facing error rather than a customer-facing one.

// Meta's interactive-message limits live in ./interactive-limits (client-safe);
// re-exported here so the senders and existing imports keep working.
export { INTERACTIVE_LIMITS } from './interactive-limits'

export interface InteractiveButton {
  /** Stable id sent back in the webhook when tapped (≤ 256 chars). */
  id: string
  /** Visible label (≤ 20 chars per Meta). */
  title: string
}

export interface SendInteractiveButtonsArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  /** The body text — what the customer reads above the buttons. */
  bodyText: string
  /** Optional plain-text header (≤ 60 chars). */
  headerText?: string
  /** Optional grey footer line under the buttons (≤ 60 chars). */
  footerText?: string
  /** 1–3 buttons. Validated against Meta's limits before sending. */
  buttons: InteractiveButton[]
  /** Meta's message_id of the message being replied to (quote preview). */
  contextMessageId?: string
}

/**
 * Send an interactive message with up to 3 inline reply buttons. The
 * customer taps one and Meta delivers a webhook with
 * `messages[0].interactive.button_reply.id` set to the matching button.id.
 *
 * Validation throws BEFORE the network call so misconfigured flows
 * fail at save time, not during a live conversation.
 */
export async function sendInteractiveButtons(
  args: SendInteractiveButtonsArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId, accessToken, to,
    bodyText, headerText, footerText, buttons, contextMessageId,
  } = args
  validateInteractiveBody(bodyText)
  validateInteractiveHeaderFooter(headerText, footerText)
  if (buttons.length < 1 || buttons.length > INTERACTIVE_LIMITS.maxButtons) {
    throw new Error(
      ti('buttonCount', { max: INTERACTIVE_LIMITS.maxButtons, got: buttons.length })
    )
  }
  const seenButtonIds = new Set<string>()
  for (const btn of buttons) {
    if (!btn.id) throw new Error(ti('buttonMissingId'))
    // Duplicate button ids make the tapped-button webhook ambiguous —
    // Meta rejects them, and the pre-flight validator (interactive.ts)
    // rejects them too, so guard here to keep the two paths in step.
    if (seenButtonIds.has(btn.id)) {
      throw new Error(ti('duplicateButtonId', { id: btn.id }))
    }
    seenButtonIds.add(btn.id)
    if (!btn.title) throw new Error(ti('buttonMissingTitle', { id: btn.id }))
    if (btn.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
      throw new Error(
        ti('buttonTitleTooLong', { title: btn.title, max: INTERACTIVE_LIMITS.buttonTitleMaxLength })
      )
    }
  }

  const interactive: Record<string, unknown> = {
    type: 'button',
    body: { text: bodyText },
    action: {
      buttons: buttons.map((b) => ({
        type: 'reply',
        reply: { id: b.id, title: b.title },
      })),
    },
  }
  if (headerText) interactive.header = { type: 'text', text: headerText }
  if (footerText) interactive.footer = { text: footerText }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    ...recipientFields(to),
    type: 'interactive',
    interactive,
  }
  if (contextMessageId) body.context = { message_id: contextMessageId }

  const url = `${META_API_BASE}/${phoneNumberId}/messages`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

export interface InteractiveListRow {
  /** Stable id sent back in the webhook when tapped (≤ 200 chars). */
  id: string
  /** Visible row title (≤ 24 chars per Meta). */
  title: string
  /** Optional secondary line shown under the title (≤ 72 chars). */
  description?: string
}

export interface InteractiveListSection {
  /** Optional section header shown above its rows. */
  title?: string
  rows: InteractiveListRow[]
}

export interface SendInteractiveListArgs {
  phoneNumberId: string
  accessToken: string
  to: string
  bodyText: string
  /** Label of the tap-to-expand button on the message bubble. */
  buttonLabel: string
  headerText?: string
  footerText?: string
  /**
   * 1–10 rows TOTAL across all sections. Meta caps the *total*, not
   * per-section. Validation enforces this before send.
   */
  sections: InteractiveListSection[]
  contextMessageId?: string
}

/**
 * Send an interactive message with a tap-to-expand list of selectable
 * rows. Use when there are more options than the 3-button limit allows.
 * Webhook arrives with `messages[0].interactive.list_reply.id` set to
 * the matching row.id.
 */
export async function sendInteractiveList(
  args: SendInteractiveListArgs
): Promise<MetaSendResult> {
  const {
    phoneNumberId, accessToken, to,
    bodyText, buttonLabel, headerText, footerText, sections, contextMessageId,
  } = args
  validateInteractiveBody(bodyText)
  validateInteractiveHeaderFooter(headerText, footerText)
  if (!buttonLabel) throw new Error(ti('listRequiresButtonLabel'))
  if (buttonLabel.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
    throw new Error(
      ti('listButtonLabelTooLong', { label: buttonLabel, max: INTERACTIVE_LIMITS.buttonTitleMaxLength })
    )
  }
  if (sections.length < 1 || sections.length > INTERACTIVE_LIMITS.maxListSections) {
    throw new Error(
      ti('listSectionCount', { max: INTERACTIVE_LIMITS.maxListSections, got: sections.length })
    )
  }
  const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0)
  if (totalRows < 1 || totalRows > INTERACTIVE_LIMITS.maxListRowsTotal) {
    throw new Error(
      ti('listRowCount', { max: INTERACTIVE_LIMITS.maxListRowsTotal, got: totalRows })
    )
  }
  const seenIds = new Set<string>()
  for (const section of sections) {
    for (const row of section.rows) {
      if (!row.id) throw new Error(ti('listRowMissingId'))
      if (seenIds.has(row.id)) {
        throw new Error(ti('duplicateRowId', { id: row.id }))
      }
      seenIds.add(row.id)
      if (!row.title) throw new Error(ti('listRowMissingTitle', { id: row.id }))
      if (row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength) {
        throw new Error(
          ti('listRowTitleTooLong', { title: row.title, max: INTERACTIVE_LIMITS.listRowTitleMaxLength })
        )
      }
      if (
        row.description &&
        row.description.length > INTERACTIVE_LIMITS.listRowDescriptionMaxLength
      ) {
        throw new Error(
          ti('listRowDescriptionTooLong', { id: row.id, max: INTERACTIVE_LIMITS.listRowDescriptionMaxLength })
        )
      }
    }
  }

  const interactive: Record<string, unknown> = {
    type: 'list',
    body: { text: bodyText },
    action: {
      button: buttonLabel,
      sections: sections.map((s) => ({
        ...(s.title ? { title: s.title } : {}),
        rows: s.rows.map((r) => ({
          id: r.id,
          title: r.title,
          ...(r.description ? { description: r.description } : {}),
        })),
      })),
    },
  }
  if (headerText) interactive.header = { type: 'text', text: headerText }
  if (footerText) interactive.footer = { text: footerText }

  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    ...recipientFields(to),
    type: 'interactive',
    interactive,
  }
  if (contextMessageId) body.context = { message_id: contextMessageId }

  const url = `${META_API_BASE}/${phoneNumberId}/messages`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.messages[0].id }
}

function validateInteractiveBody(bodyText: string): void {
  if (!bodyText) throw new Error(ti('bodyRequired'))
  if (bodyText.length > INTERACTIVE_LIMITS.bodyMaxLength) {
    throw new Error(
      ti('bodyTooLong', { max: INTERACTIVE_LIMITS.bodyMaxLength })
    )
  }
}

function validateInteractiveHeaderFooter(
  headerText: string | undefined,
  footerText: string | undefined,
): void {
  if (headerText && headerText.length > INTERACTIVE_LIMITS.headerTextMaxLength) {
    throw new Error(
      ti('headerTooLong', { max: INTERACTIVE_LIMITS.headerTextMaxLength })
    )
  }
  if (footerText && footerText.length > INTERACTIVE_LIMITS.footerMaxLength) {
    throw new Error(
      ti('footerTooLong', { max: INTERACTIVE_LIMITS.footerMaxLength })
    )
  }
}

// ============================================================
// Media
// ============================================================

export interface GetMediaUrlArgs {
  mediaId: string
  accessToken: string
}

/**
 * Resolve a media ID to Meta's (short-lived, authenticated) CDN URL
 * plus the MIME type. Step one of the media-proxy flow.
 *
 * `fileSize` is Meta's `file_size` (bytes) and is what lets the
 * inbound mirror (issue #466) reject a file the `chat-media` bucket
 * would refuse WITHOUT downloading it first — a 90 MB document costs
 * nothing to skip here and a full transfer to skip after the fact.
 * Null when Meta omits the field or sends something non-numeric.
 */
export async function getMediaUrl(
  args: GetMediaUrlArgs
): Promise<{ url: string; mimeType: string; fileSize: number | null }> {
  const { mediaId, accessToken } = args
  const response = await fetch(`${META_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwMetaError(response, `Media fetch failed: ${response.status}`)
  }
  const data = await response.json()
  if (!data.url) throw new Error('Media URL not found in Meta response')
  // Meta documents file_size as a number but has been observed sending
  // it as a numeric string; Number() handles both and NaN-guards junk.
  const size = Number(data.file_size)
  return {
    url: data.url,
    mimeType: data.mime_type || 'application/octet-stream',
    fileSize: Number.isFinite(size) && size >= 0 ? size : null,
  }
}

export interface DownloadMediaArgs {
  downloadUrl: string
  accessToken: string
}

/**
 * Fetch the binary bytes for a media URL obtained from getMediaUrl.
 * Step two of the media-proxy flow.
 */
export async function downloadMedia(
  args: DownloadMediaArgs
): Promise<{ buffer: Buffer; contentType: string }> {
  const { downloadUrl, accessToken } = args
  const response = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    throw new Error(`Media download failed: ${response.status}`)
  }
  const contentType =
    response.headers.get('content-type') || 'application/octet-stream'
  const buffer = Buffer.from(await response.arrayBuffer())
  return { buffer, contentType }
}
