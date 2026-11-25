/**
 * Tenant routing decisions for inbound Meta webhooks.
 *
 * Pure functions (no I/O) so the security-relevant decisions can be tested
 * exhaustively. The webhook handlers do the Supabase reads and pass the rows
 * in; nothing here touches a database or logs.
 *
 * Why this exists
 * ---------------
 * Meta signs a delivery with the *app* secret, so a valid signature proves the
 * delivery came from Meta for one of OUR apps — it does not say which tenant
 * the event belongs to. The tenant is derived afterwards, from ids inside the
 * body:
 *
 *   entry.id                       the WABA the event belongs to
 *   value.metadata.phone_number_id the business number the event is about
 *
 * `phone_number_id` is unique instance-wide (migration 013), so it identifies
 * exactly one workspace. `entry.id` must then agree with the WABA recorded for
 * that workspace. If they disagree the event is for a number that has moved to
 * another WABA, or the stored row is wrong; either way routing it to the
 * workspace would put another business's traffic in this tenant's inbox, so it
 * is refused (not "best effort" delivered).
 */

/** Meta ids arrive as strings but may be numbers in hand-built payloads. */
export function normalizeMetaId(
  value: string | number | null | undefined,
): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s === '' ? null : s
}

export interface PhoneConfigRow {
  account_id: string
  /** Null/absent on legacy rows saved before the WABA id was recorded. */
  waba_id?: string | number | null
}

export type TenantResolution<T extends PhoneConfigRow> =
  | {
      ok: true
      config: T
      /**
       * True when entry.id and the stored waba_id were both present and equal.
       * False only for a legacy row with no stored waba_id, and only when the
       * caller opted in with `allowLegacyNullWaba`: the event is routed on the
       * unique phone_number_id alone and the caller should log it.
       */
      wabaVerified: boolean
    }
  | { ok: false; reason: 'no_config' }
  | { ok: false; reason: 'missing_entry_id' }
  | { ok: false; reason: 'config_missing_waba' }
  | { ok: false; reason: 'ambiguous_number'; matches: number }
  | {
      ok: false
      reason: 'waba_mismatch'
      entryWabaId: string
      configWabaId: string
    }

export interface ResolveOptions {
  /**
   * Transitional compatibility for rows saved before the WABA id was
   * recorded. false (default) = fail closed when the stored waba_id is null.
   * true = route on phone_number_id alone for such rows (still fails closed
   * on a missing entry.id and on any mismatch).
   */
  allowLegacyNullWaba?: boolean
}

/**
 * Decide which workspace configuration a webhook event for one phone number
 * belongs to. Fails closed on: no row, several rows, a missing entry.id, a
 * mismatching WABA, and (unless opted out) a stored row without a WABA id.
 *
 * @param rows        whatsapp_config rows matching metadata.phone_number_id
 * @param entryWabaId entry.id of the webhook envelope (the WABA)
 */
export function resolveTenantForPhoneNumber<T extends PhoneConfigRow>(
  rows: readonly T[] | null | undefined,
  entryWabaId: string | number | null | undefined,
  options: ResolveOptions = {},
): TenantResolution<T> {
  if (!rows || rows.length === 0) return { ok: false, reason: 'no_config' }
  if (rows.length > 1) {
    // Cannot happen once migration 013's UNIQUE(phone_number_id) is in place;
    // if it does, picking one would deliver to a possibly wrong tenant.
    return { ok: false, reason: 'ambiguous_number', matches: rows.length }
  }

  const config = rows[0]
  const entryId = normalizeMetaId(entryWabaId)
  if (entryId === null) return { ok: false, reason: 'missing_entry_id' }

  const storedId = normalizeMetaId(config.waba_id)
  if (storedId === null) {
    return options.allowLegacyNullWaba
      ? { ok: true, config, wabaVerified: false }
      : { ok: false, reason: 'config_missing_waba' }
  }
  if (entryId !== storedId) {
    return {
      ok: false,
      reason: 'waba_mismatch',
      entryWabaId: entryId,
      configWabaId: storedId,
    }
  }
  return { ok: true, config, wabaVerified: true }
}

export interface TemplateOwnerRow {
  account_id: string
  user_id: string
  created_at?: string | null
}

export interface TemplateOwner {
  account_id: string
  /** The user recorded as the config owner; the audit FK for stub rows. */
  user_id: string
}

/**
 * Collapse the whatsapp_config rows that claim one WABA into one entry per
 * workspace, in a deterministic order.
 *
 * A single workspace can legitimately have several rows for the same WABA
 * (several numbers under one WABA). Those are ONE tenant, not an ambiguity.
 * Different workspaces claiming the same WABA id is a different situation and
 * is returned as several owners, so the caller can decide not to guess.
 *
 * Determinism: owners are sorted by account_id; within a workspace the row
 * with the earliest created_at (ties: lowest user_id) supplies `user_id`.
 */
export function groupTemplateOwners(
  rows: readonly TemplateOwnerRow[] | null | undefined,
): TemplateOwner[] {
  const byAccount = new Map<string, TemplateOwnerRow>()
  for (const row of rows ?? []) {
    if (!row.account_id) continue
    const current = byAccount.get(row.account_id)
    if (!current || isBefore(row, current)) byAccount.set(row.account_id, row)
  }
  return [...byAccount.values()]
    .map((r) => ({ account_id: r.account_id, user_id: r.user_id }))
    .sort((a, b) => (a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0))
}

function isBefore(a: TemplateOwnerRow, b: TemplateOwnerRow): boolean {
  const ta = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY
  const tb = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY
  if (ta !== tb) return ta < tb
  return a.user_id < b.user_id
}
