import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt as defaultEncrypt } from '@/lib/whatsapp/encryption'

/**
 * Storage port for a WhatsApp connection (docs/architecture/09, slice S1).
 *
 * Embedded Signup talks only to this interface so storage can move from
 * `whatsapp_config` (one number per account, today) to `whatsapp_numbers`
 * (multi-number, M1) without touching the connect flow.
 *
 * Secrets: the access token is accepted in plaintext, encrypted with the
 * existing token-encryption helper before it is written, and is NEVER returned
 * by any method here. Reads of the token stay with `fetchWhatsAppConfig`
 * (src/lib/credentials/server.ts); this module selects only non-secret columns.
 */

/**
 * `pending_setup` (token stored, setup steps outstanding) and `needs_attention`
 * cannot be represented in `whatsapp_config.status` (CHECK connected|disconnected)
 * until migration 071 (S2) adds `connection_status`.
 */
export type ConnectionStatus =
  | 'pending_setup'
  | 'connected'
  | 'needs_attention'
  | 'disconnected'

/** Non-secret view of a stored connection. */
export interface StoredConnection {
  accountId: string
  phoneNumberId: string
  wabaId: string | null
  status: ConnectionStatus
  registeredAt: string | null
  subscribedAppsAt: string | null
}

export interface UpsertConnectionInput {
  /** Server-resolved account (from the signup session). Never from a request body. */
  accountId: string
  /** The member who connected it (audit column). */
  connectedBy: string
  phoneNumberId: string
  wabaId: string
  /** Plaintext business token; encrypted by the store, never returned. */
  accessToken: string
  /** `pending_setup` right after the code exchange; `connected` once setup completes. */
  status: 'pending_setup' | 'connected'
  /** Null for coexistence numbers BY DESIGN (no /register, no PIN). */
  registeredAt: string | null
  subscribedAppsAt: string | null
}

export type MarkStatusResult =
  | { ok: true }
  | { ok: false; reason: 'not_supported_until_071' | 'not_found' }

export interface ConnectionStore {
  getByAccount(accountId: string): Promise<StoredConnection | null>
  upsertConnection(input: UpsertConnectionInput): Promise<void>
  markStatus(accountId: string, status: ConnectionStatus): Promise<MarkStatusResult>
}

const NON_SECRET_COLUMNS =
  'account_id, phone_number_id, waba_id, status, registered_at, subscribed_apps_at'

/**
 * `whatsapp_config`-backed store. `admin` MUST be a service-role client (the
 * credential columns are withheld from `authenticated`, migration 063).
 *
 * S1 scope: `getByAccount` + `upsertConnection` on EXISTING columns only.
 * `markStatus` is interface-only until S2 ships migration 071
 * (`connection_status`), so it writes nothing and says so.
 */
export function createWhatsAppConfigStore(deps: {
  admin: Pick<SupabaseClient, 'from'>
  encrypt?: (plain: string) => string
}): ConnectionStore {
  const { admin } = deps
  const encrypt = deps.encrypt ?? defaultEncrypt

  return {
    async getByAccount(accountId) {
      const { data, error } = await admin
        .from('whatsapp_config')
        .select(NON_SECRET_COLUMNS)
        .eq('account_id', accountId)
        .maybeSingle()
      if (error) throw new Error('connection store read failed')
      if (!data) return null
      const row = data as {
        account_id: string
        phone_number_id: string
        waba_id: string | null
        status: string
        registered_at: string | null
        subscribed_apps_at: string | null
      }
      return {
        accountId: row.account_id,
        phoneNumberId: row.phone_number_id,
        wabaId: row.waba_id,
        status: row.status === 'connected' ? 'connected' : 'disconnected',
        registeredAt: row.registered_at,
        subscribedAppsAt: row.subscribed_apps_at,
      }
    },

    async upsertConnection(input) {
      const now = new Date().toISOString()
      const connected = input.status === 'connected'
      const row = {
        phone_number_id: input.phoneNumberId,
        waba_id: input.wabaId,
        access_token: encrypt(input.accessToken),
        // `pending_setup` maps to 'disconnected' until 071 can represent it.
        status: connected ? 'connected' : 'disconnected',
        connected_at: connected ? now : null,
        registered_at: input.registeredAt,
        subscribed_apps_at: input.subscribedAppsAt,
        last_registration_error: null,
        updated_at: now,
      }
      const { data: existing, error: readError } = await admin
        .from('whatsapp_config')
        .select('id')
        .eq('account_id', input.accountId)
        .maybeSingle()
      if (readError) throw new Error('connection store read failed')

      const { error } = existing
        ? await admin.from('whatsapp_config').update(row).eq('account_id', input.accountId)
        : await admin
            .from('whatsapp_config')
            .insert({ account_id: input.accountId, user_id: input.connectedBy, ...row })
      if (error) throw new Error('connection store write failed')
    },

    async markStatus() {
      return { ok: false, reason: 'not_supported_until_071' }
    },
  }
}
