import 'server-only'

import {
  createClient,
  type PostgrestError,
  type SupabaseClient,
} from '@supabase/supabase-js'

/**
 * SERVER-ONLY access to credential-bearing columns.
 *
 * Why this exists (finding F1): the `authenticated` database role can no longer
 * SELECT the secret columns below (migration 063), so no browser session — and
 * no RLS-scoped server client acting for a viewer or agent — can read them.
 * Anything that legitimately needs a secret (sending through Meta, calling the
 * AI provider, signing a webhook) reads it HERE, with the service role, after
 * the caller has authenticated the user and resolved the account id on the
 * server.
 *
 * RULES
 *   1. Server code only. Never import this from a `'use client'` module or a
 *      component (a source guard in src/lib/credentials/guard.test.ts enforces
 *      this).
 *   2. The caller must already have authorised the request (`requireRole`,
 *      `requireApiKey`, a verified Meta signature, a cron secret …) and must
 *      pass an account id it derived itself — never one taken from the request
 *      body. Every query below is filtered to that single account.
 *   3. Return secrets to the browser? Never. Return only derived,
 *      non-sensitive facts ("connected", "last four digits").
 */

/** Secret columns, per table. Mirrors migration 063's REVOKE list. */
export const CREDENTIAL_COLUMNS = {
  whatsapp_config: ['access_token', 'verify_token'],
  ai_configs: ['api_key', 'embeddings_api_key'],
  webhook_endpoints: ['secret'],
  api_keys: ['key_hash'],
} as const

let _client: SupabaseClient | null = null
let _override: SupabaseClient | null = null

/**
 * TEST SEAM. Unit tests substitute a fake client here so credential reads hit
 * the fake instead of a real service-role connection. Throws outside tests so
 * production code can never swap the credentials client.
 */
export function setCredentialsDbForTests(db: unknown | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setCredentialsDbForTests is for tests only')
  }
  _override = db as SupabaseClient | null
}

/**
 * Lazy service-role client used only for credential reads. Named so that a
 * grep for `credentialsDb(` finds every place a secret can be read.
 */
export function credentialsDb(): SupabaseClient {
  if (_override) return _override
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _client
}

/**
 * Loosely-typed row result. The project has no generated database types and
 * the caller chooses the column list at runtime, so rows are `any` exactly as
 * they were for the previous `.select('*')` call sites.
 */
export interface CredentialRowResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  error: PostgrestError | null
}

/**
 * The account's full `whatsapp_config` row (or a column subset), including the
 * still-encrypted access and verify tokens. `null` data + null error means
 * "not configured".
 */
export async function fetchWhatsAppConfig(
  accountId: string,
  columns = '*',
): Promise<CredentialRowResult> {
  const result = await credentialsDb()
    .from('whatsapp_config')
    .select(columns)
    .eq('account_id', accountId)
    .maybeSingle()
  return result as unknown as CredentialRowResult
}

/**
 * The account's `ai_configs` row (or a column subset), including the encrypted
 * chat / embeddings API keys. `null` data + null error = not configured.
 */
export async function fetchAiConfig(
  accountId: string,
  columns = '*',
): Promise<CredentialRowResult> {
  const result = await credentialsDb()
    .from('ai_configs')
    .select(columns)
    .eq('account_id', accountId)
    .maybeSingle()
  return result as unknown as CredentialRowResult
}
