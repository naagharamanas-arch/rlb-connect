-- 063_credential_column_privileges — credential columns are unreadable by the
-- `authenticated` role (finding F1).
--
-- BEFORE: every member (viewer and agent included) could SELECT the encrypted
-- WhatsApp access/verify tokens, the encrypted AI provider keys, the webhook
-- signing secret and the API-key hash of their own account.
-- AFTER: no browser session and no RLS-scoped client can read them. Server code
-- reads them with the service role via src/lib/credentials/server.ts, after
-- authorising the caller (requireRole etc.). Non-secret columns stay readable by
-- members exactly as before (RLS still scopes rows); INSERT / UPDATE / DELETE are
-- untouched (admins still save credentials; only reading them back is closed).
--
-- Column-level privileges are the only mechanism that works here: every member
-- shares the one `authenticated` database role, and a table-level SELECT grant
-- overrides a column-level REVOKE, so the table-level grant is removed first
-- and an explicit column list is granted back.
--
-- PREREQUISITES: 061 (explicit grants), 062 (has_verify_token) and the
-- application refactor that stops reading these columns as `authenticated`.
--
-- NEW COLUMNS: a column added to one of these tables later is NOT readable by
-- `authenticated` until it is added to the list below (fail-closed). The test
-- suite (060_known_gaps / 080_credential_columns) fails if a column is neither
-- granted here nor registered as a secret.
--
-- ROLLBACK (restores member-readable credentials; not recommended):
--   GRANT SELECT ON public.whatsapp_config, public.ai_configs,
--     public.webhook_endpoints, public.api_keys TO authenticated;

-- whatsapp_config: access_token, verify_token withheld
REVOKE SELECT ON public.whatsapp_config FROM authenticated;
GRANT SELECT (
  id, user_id, phone_number_id, waba_id, status, connected_at, created_at,
  updated_at, registered_at, subscribed_apps_at, last_registration_error,
  account_id, mirror_inbound_media, has_verify_token
) ON public.whatsapp_config TO authenticated;

-- ai_configs: api_key, embeddings_api_key withheld
REVOKE SELECT ON public.ai_configs FROM authenticated;
GRANT SELECT (
  id, account_id, created_by, provider, model, system_prompt, is_active,
  auto_reply_enabled, auto_reply_max_per_conversation, created_at, updated_at,
  handoff_agent_id, base_url
) ON public.ai_configs TO authenticated;

-- webhook_endpoints: secret withheld
REVOKE SELECT ON public.webhook_endpoints FROM authenticated;
GRANT SELECT (
  id, account_id, created_by, url, events, is_active, last_delivery_at,
  failure_count, created_at
) ON public.webhook_endpoints TO authenticated;

-- api_keys: key_hash withheld
REVOKE SELECT ON public.api_keys FROM authenticated;
GRANT SELECT (
  id, account_id, created_by, name, key_prefix, scopes, last_used_at,
  expires_at, revoked_at, created_at
) ON public.api_keys TO authenticated;
