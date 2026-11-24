/**
 * Client-safe column lists for credential-bearing tables. Contains NO secret
 * column and imports nothing server-side, so browser components may use it.
 * Secret columns live in ./server.ts (CREDENTIAL_COLUMNS) and are readable
 * only there.
 */

/** Non-secret `whatsapp_config` columns (browser-safe). */
export const WHATSAPP_CONFIG_PUBLIC_COLUMNS =
  'id, account_id, user_id, phone_number_id, waba_id, status, connected_at, registered_at, subscribed_apps_at, last_registration_error, mirror_inbound_media, has_verify_token, created_at, updated_at'
