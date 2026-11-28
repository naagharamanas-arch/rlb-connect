/**
 * Settings → WhatsApp: what "registered" means for each kind of number.
 *
 * Pure and framework-free (safe in the browser and on the server).
 *
 * Why this exists (docs/architecture/09 §4): a number that lives on the
 * WhatsApp Business app (Coexistence) has no Cloud API two-step PIN and
 * `/register` must never be called for it, so `registered_at` stays NULL by
 * design. A Meta TEST number is pre-registered by Meta. Showing either as
 * "Not registered — enter the PIN" is wrong. Everything else, including
 * "we could not tell", keeps today's behaviour: uncertainty NEVER hides the
 * PIN field, because a real Cloud API production number connected manually
 * still needs `/register` with a PIN (issue #136).
 */

export type ConnectionKind = 'coexistence' | 'test_number' | 'cloud_api' | 'unknown'

/** Raw, best-effort facts read from the Graph phone-number node. Every field may be absent. */
export interface RawPhoneConnectionFacts {
  /** `platform_type` (e.g. CLOUD_API). (verify exact values in current Meta docs) */
  platformType?: string | null
  /** `is_on_biz_app` — true when the number is also used in the WhatsApp Business app. (verify) */
  isOnBizApp?: boolean | null
  /** `account_mode` — SANDBOX for Meta test numbers. (verify) */
  accountMode?: string | null
}

/**
 * Positive identification only. Anything not positively identified is
 * `unknown`, and `unknown` behaves exactly like today.
 */
export function classifyPhoneKind(raw: RawPhoneConnectionFacts | null | undefined): ConnectionKind {
  if (!raw) return 'unknown'
  if (raw.isOnBizApp === true) return 'coexistence'
  if (typeof raw.accountMode === 'string' && raw.accountMode.toUpperCase() === 'SANDBOX') {
    return 'test_number'
  }
  if (raw.isOnBizApp === false && raw.platformType === 'CLOUD_API') return 'cloud_api'
  return 'unknown'
}

export function isConnectionKind(value: unknown): value is ConnectionKind {
  return (
    value === 'coexistence' ||
    value === 'test_number' ||
    value === 'cloud_api' ||
    value === 'unknown'
  )
}

/** Cloud API `/register` + local `registered_at` only matter for these kinds. */
export function requiresLocalRegistration(kind: ConnectionKind): boolean {
  return kind !== 'coexistence' && kind !== 'test_number'
}

export type ConnectionState =
  | 'no_config'
  | 'coexistence_live'
  | 'coexistence_attention'
  | 'test_number'
  | 'registered'
  | 'registration_failed'
  | 'awaiting_registration'
  | 'unknown'

export interface ConnectionStatusInput {
  /** Is there a saved whatsapp_config row? */
  hasConfig: boolean
  kind: ConnectionKind
  registeredAt: string | null | undefined
  lastRegistrationError: string | null | undefined
  /** WABA subscribed to our app: true / false / null (not checked or check failed). */
  wabaSubscribed: boolean | null | undefined
}

export interface ConnectionStatusView {
  state: ConnectionState
  /** Render the new banner instead of the legacy registered / not-registered one. */
  customBanner: boolean
  showPinField: boolean
  /** Use neutral PIN wording instead of the "needed for a production number" text. */
  neutralPinHint: boolean
}

export function deriveConnectionStatus(input: ConnectionStatusInput): ConnectionStatusView {
  if (!input.hasConfig) {
    // First-time manual save: the PIN field is always available.
    return { state: 'no_config', customBanner: false, showPinField: true, neutralPinHint: false }
  }
  if (input.kind === 'coexistence') {
    return {
      state: input.wabaSubscribed === false ? 'coexistence_attention' : 'coexistence_live',
      customBanner: true,
      showPinField: false,
      neutralPinHint: false,
    }
  }
  if (input.kind === 'test_number') {
    return { state: 'test_number', customBanner: true, showPinField: false, neutralPinHint: false }
  }
  if (input.kind === 'unknown') {
    return { state: 'unknown', customBanner: true, showPinField: true, neutralPinHint: true }
  }
  // cloud_api: today's registered / failed / awaiting behaviour, unchanged.
  const state: ConnectionState = input.registeredAt
    ? 'registered'
    : input.lastRegistrationError
      ? 'registration_failed'
      : 'awaiting_registration'
  return { state, customBanner: false, showPinField: true, neutralPinHint: false }
}
