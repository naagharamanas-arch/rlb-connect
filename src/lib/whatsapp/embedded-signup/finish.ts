import { randomInt } from 'node:crypto'
import {
  MetaApiError,
  debugToken,
  exchangeCodeForToken,
  getPhoneConnectionKind,
  getWabaPhoneNumberDetails,
  registerPhoneNumber,
  subscribeWabaToApp,
} from '@/lib/whatsapp/meta-api'
import { classifyPhoneKind } from '@/lib/whatsapp/connection-status'
import { isNumericMetaId } from '@/lib/whatsapp/waba-pairing'
import type { ConnectionStore } from './connection-store'
import {
  claimSession,
  type SignupSession,
  type SignupSessionStore,
  type SignupStatus,
} from './session'

/**
 * Embedded Signup finish pipeline (docs/architecture/09 §2, slice S1).
 *
 * NOT wired to any route in S1 — it is exercised by unit tests only. Every
 * external effect is injected (`FinishDeps`) so the invariants can be tested:
 *
 *  - tenant: the account is the SESSION's, never the request's. Browser `hints`
 *    are hints only; every id used for a write comes from Meta (debug_token's
 *    granted targets and the WABA's own phone-number list);
 *  - secrets: the code and the token never appear in a result, a step name or a
 *    log line. Failures carry Meta's code/subcode/fbtrace_id only;
 *  - coexistence: `registerPhoneNumber` is NEVER called for a coexistence
 *    number (no PIN, `registered_at` stays NULL by design);
 *  - the token is persisted (encrypted) as soon as the number is verified, so
 *    the single-use code is never the only copy and later steps can be resumed.
 *
 * Meta field names / values used by the helpers are (verify) — see meta-api.ts.
 */

/** Scope the token must hold on the WABA. (verify exact granular scope name) */
const WABA_MANAGEMENT_SCOPE = 'whatsapp_business_management'

export interface FinishDeps {
  sessions: SignupSessionStore
  connections: ConnectionStore
  /** Re-check at finish: caller still admin/owner of the session's account. */
  isStillAdmin: (accountId: string, userId: string) => Promise<boolean>
  /** Shared "claimed by another account" rule (lib/whatsapp/claim.ts), service role. */
  isClaimedByOtherAccount: (args: {
    phoneNumberId: string
    accountId: string
  }) => Promise<{ claimed: boolean; error: unknown }>
  meta: {
    exchangeCodeForToken: typeof exchangeCodeForToken
    debugToken: typeof debugToken
    getWabaPhoneNumberDetails: typeof getWabaPhoneNumberDetails
    getPhoneConnectionKind: typeof getPhoneConnectionKind
    subscribeWabaToApp: typeof subscribeWabaToApp
    registerPhoneNumber: typeof registerPhoneNumber
  }
  /** 6-digit PIN for path A. Injectable for tests. */
  generatePin?: () => string
  now?: () => Date
}

export function defaultMeta(): FinishDeps['meta'] {
  return {
    exchangeCodeForToken,
    debugToken,
    getWabaPhoneNumberDetails,
    getPhoneConnectionKind,
    subscribeWabaToApp,
    registerPhoneNumber,
  }
}

export interface FinishInput {
  /** Opaque state returned by the browser. */
  state: string
  /** Single-use code from FB.login. Exchanged once; never stored or logged. */
  code: string
  /** Server-resolved caller (requireRole). */
  callerUserId: string
  /** Hints from the browser's session event. NEVER trusted for writes. */
  hints?: { wabaId?: unknown; phoneNumberId?: unknown }
}

export type FinishStep =
  | 'session'
  | 'exchange_code'
  | 'debug_token'
  | 'verify_number'
  | 'claim_check'
  | 'persist'
  | 'subscribe_waba'
  | 'register'

export type FinishFailureReason =
  // session
  | 'not_found'
  | 'expired'
  | 'replayed'
  | 'foreign_user'
  | 'role_revoked'
  // verification
  | 'meta_error'
  | 'token_invalid'
  | 'wrong_app'
  | 'waba_not_granted'
  | 'waba_ambiguous'
  | 'phone_not_under_waba'
  | 'phone_ambiguous'
  | 'coexistence_not_confirmed'
  | 'number_claimed_elsewhere'
  | 'already_connected_other_number'
  | 'claim_check_failed'
  | 'store_error'

export interface MetaFailureInfo {
  code: number | null
  subcode: number | null
  fbtraceId: string | null
  httpStatus: number | null
}

export type FinishResult =
  | {
      ok: true
      status: 'connected'
      coexistence: boolean
      alreadyConnected: boolean
      steps: string[]
    }
  | {
      ok: false
      reason: FinishFailureReason
      step: FinishStep
      /** True when the token is stored and the remaining steps can be re-run without a new code. */
      resumable: boolean
      steps: string[]
      /** Meta's error identifiers only — no message, no payload, no token. */
      meta?: MetaFailureInfo
    }

function metaInfo(err: unknown): MetaFailureInfo | undefined {
  if (err instanceof MetaApiError) {
    return {
      code: err.code ?? null,
      subcode: err.subcode ?? null,
      fbtraceId: err.fbtraceId ?? null,
      httpStatus: err.httpStatus ?? null,
    }
  }
  return undefined
}

function defaultPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** (verify) Meta's "not available for SMB / Business app numbers" register error. */
function looksLikeSmbRegisterRefusal(err: unknown): boolean {
  return err instanceof Error && /\bSMB\b|business app/i.test(err.message)
}

export async function finishEmbeddedSignup(
  deps: FinishDeps,
  input: FinishInput,
): Promise<FinishResult> {
  const now = deps.now ?? (() => new Date())
  const steps: string[] = []
  let session: SignupSession | null = null
  let tokenStored = false

  const fail = async (
    reason: FinishFailureReason,
    step: FinishStep,
    err?: unknown,
    status?: SignupStatus,
  ): Promise<FinishResult> => {
    if (session) {
      // Best effort: a store failure here must not mask the original reason.
      await deps.sessions
        .update(session.id, {
          status: status ?? (tokenStored ? 'needs_attention' : 'failed'),
          completedSteps: [...steps],
        })
        .catch(() => undefined)
    }
    return { ok: false, reason, step, resumable: tokenStored, steps: [...steps], meta: metaInfo(err) }
  }

  // 1. Session: same user, still admin of THAT account, unexpired, single-use claim.
  const claimed = await claimSession({
    store: deps.sessions,
    state: input.state,
    callerUserId: input.callerUserId,
    isStillAdmin: deps.isStillAdmin,
    now: now(),
  })
  if (!claimed.ok) {
    return { ok: false, reason: claimed.reason, step: 'session', resumable: false, steps }
  }
  session = claimed.session
  const { accountId } = session

  // 2. Exchange the single-use code immediately.
  let accessToken: string
  try {
    ;({ accessToken } = await deps.meta.exchangeCodeForToken({ code: input.code }))
  } catch (err) {
    return fail('meta_error', 'exchange_code', err)
  }
  steps.push('exchange_code')

  // 3. Prove the token is ours and which WABA it is granted on.
  let wabaId: string
  try {
    const dbg = await deps.meta.debugToken({ inputToken: accessToken })
    if (!dbg.isValid) return fail('token_invalid', 'debug_token')
    if (!process.env.META_APP_ID || dbg.appId !== process.env.META_APP_ID.trim()) {
      return fail('wrong_app', 'debug_token')
    }
    const granted = new Set(
      dbg.granularScopes
        .filter((g) => g.scope === WABA_MANAGEMENT_SCOPE)
        .flatMap((g) => g.targetIds)
        .filter(isNumericMetaId),
    )
    const hint = typeof input.hints?.wabaId === 'string' ? input.hints.wabaId : null
    if (hint) {
      if (!granted.has(hint)) return fail('waba_not_granted', 'debug_token')
      wabaId = hint
    } else if (granted.size === 1) {
      wabaId = [...granted][0]
    } else {
      return fail(granted.size === 0 ? 'waba_not_granted' : 'waba_ambiguous', 'debug_token')
    }
  } catch (err) {
    return fail('meta_error', 'debug_token', err)
  }
  steps.push('debug_token')

  // 4. The phone id must come from Meta's own list for that WABA.
  let phoneNumberId: string
  try {
    const numbers = await deps.meta.getWabaPhoneNumberDetails({ wabaId, accessToken })
    const hint = typeof input.hints?.phoneNumberId === 'string' ? input.hints.phoneNumberId : null
    if (hint) {
      if (!numbers.some((n) => n.id === hint)) return fail('phone_not_under_waba', 'verify_number')
      phoneNumberId = hint
    } else if (numbers.length === 1) {
      phoneNumberId = numbers[0].id
    } else {
      return fail(numbers.length === 0 ? 'phone_not_under_waba' : 'phone_ambiguous', 'verify_number')
    }
  } catch (err) {
    return fail('meta_error', 'verify_number', err)
  }
  steps.push('verify_number')

  // Path decision comes from Meta, never from the browser's claim alone.
  let coexistence: boolean
  try {
    const kind = classifyPhoneKind(
      await deps.meta.getPhoneConnectionKind({ phoneNumberId, accessToken }),
    )
    if (session.mode === 'coexistence' && kind !== 'coexistence') {
      return fail('coexistence_not_confirmed', 'verify_number')
    }
    // Meta says Business-app number ⇒ coexistence even if the session said
    // new_number: the safe direction (we then never call /register).
    coexistence = kind === 'coexistence'
  } catch (err) {
    return fail('meta_error', 'verify_number', err)
  }

  // 5. One number per account today; the number must not belong to another account.
  const claim = await deps.isClaimedByOtherAccount({ phoneNumberId, accountId })
  if (claim.error) return fail('claim_check_failed', 'claim_check')
  if (claim.claimed) return fail('number_claimed_elsewhere', 'claim_check')

  let existing
  try {
    existing = await deps.connections.getByAccount(accountId)
  } catch {
    return fail('store_error', 'persist')
  }
  if (existing && existing.phoneNumberId !== phoneNumberId) {
    return fail('already_connected_other_number', 'claim_check')
  }
  if (existing && existing.status === 'connected') {
    // Finishing a number that is already connected to this account is a no-op success.
    await deps.sessions.update(session.id, { status: 'connected', completedSteps: [...steps] })
    return { ok: true, status: 'connected', coexistence, alreadyConnected: true, steps }
  }

  // 6. Persist the token NOW (encrypted, status pending_setup): the code is single-use.
  try {
    await deps.connections.upsertConnection({
      accountId,
      connectedBy: session.userId,
      phoneNumberId,
      wabaId,
      accessToken,
      status: 'pending_setup',
      registeredAt: null,
      subscribedAppsAt: null,
    })
  } catch {
    return fail('store_error', 'persist')
  }
  tokenStored = true
  steps.push('persist_token')

  // 7. Subscribe the WABA (idempotent).
  let subscribedAt: string
  try {
    await deps.meta.subscribeWabaToApp({ wabaId, accessToken })
    subscribedAt = now().toISOString()
  } catch (err) {
    return fail('meta_error', 'subscribe_waba', err)
  }
  steps.push('subscribe_waba')

  // 8. Path A registers with a server-generated PIN; coexistence NEVER does.
  let registeredAt: string | null = null
  if (!coexistence) {
    try {
      // The PIN is not stored in S1 (open question 4: whether Meta needs it again
      // for re-registration is (verify)). It is never returned or logged.
      await deps.meta.registerPhoneNumber({
        phoneNumberId,
        accessToken,
        pin: (deps.generatePin ?? defaultPin)(),
      })
      registeredAt = now().toISOString()
      steps.push('register')
    } catch (err) {
      if (looksLikeSmbRegisterRefusal(err)) {
        // Defensive re-classification (doc 09 §2.2 step 5): this is a
        // coexistence number after all. Do not fail, do not retry /register.
        coexistence = true
      } else {
        return fail('meta_error', 'register', err)
      }
    }
  }

  // 9. Final write: connected. registered_at stays NULL for coexistence by design.
  try {
    await deps.connections.upsertConnection({
      accountId,
      connectedBy: session.userId,
      phoneNumberId,
      wabaId,
      accessToken,
      status: 'connected',
      registeredAt,
      subscribedAppsAt: subscribedAt,
    })
  } catch {
    return fail('store_error', 'persist')
  }
  steps.push('persist')
  await deps.sessions.update(session.id, { status: 'connected', completedSteps: [...steps] })

  return { ok: true, status: 'connected', coexistence, alreadyConnected: false, steps }
}
