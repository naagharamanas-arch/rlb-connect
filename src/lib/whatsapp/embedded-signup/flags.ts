/**
 * Embedded Signup feature flags (docs/architecture/09, slice S1).
 *
 * Server-side env vars read at CALL time (same convention as
 * WA_STATUS_V2 / WHATSAPP_REQUIRE_STORED_WABA); never NEXT_PUBLIC_*. Default
 * OFF. S1 only reads them — nothing calls them from a route yet.
 */

/** `ES_CONNECT_ENABLED=1` turns the Embedded Signup connect flow on. */
export function isEsConnectEnabled(): boolean {
  return process.env.ES_CONNECT_ENABLED === '1'
}

/**
 * `ES_CONNECT_ACCOUNT_ALLOWLIST` — comma-separated account ids. Empty or unset
 * means nobody. Lets only the owner's own account see the flow before Meta
 * approval. Whitespace and empty entries are ignored.
 */
export function esConnectAllowlist(): string[] {
  return (process.env.ES_CONNECT_ACCOUNT_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

export function isAccountAllowlisted(accountId: string): boolean {
  if (!accountId) return false
  return esConnectAllowlist().includes(accountId)
}

/** Both conditions: flag on AND this account allow-listed. */
export function isEsConnectAllowedFor(accountId: string): boolean {
  return isEsConnectEnabled() && isAccountAllowlisted(accountId)
}
