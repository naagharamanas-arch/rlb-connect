/**
 * WA_STATUS_V2 — server-side flag for the Settings → WhatsApp status fix
 * (docs/architecture/09, slice S0). Default OFF. Read at call time from the
 * server environment (same convention as WHATSAPP_REQUIRE_STORED_WABA); never
 * a NEXT_PUBLIC_* value. The browser learns the outcome from the API, which
 * only returns `connection_kind` when the flag is on.
 */
export function isStatusV2Enabled(): boolean {
  return process.env.WA_STATUS_V2 === '1'
}
