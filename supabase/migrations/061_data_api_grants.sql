-- 061_data_api_grants — explicit, least-privilege Data API table grants.
--
-- WHY. Earlier migrations never granted table privileges to the Data API roles
-- (anon, authenticated, service_role); they relied on the platform's default
-- ACLs. Where those defaults are open (older Supabase projects) every role got
-- full DML on every table and RLS was the only barrier. Where they are
-- restrictive (new projects / current local image) the roles get no DML at all
-- and the app, including the webhook (service_role), cannot read or write.
-- This migration makes the privileges explicit so the result is identical on
-- both kinds of project.
--
-- MODEL.
--   anon           nothing. No public table is reachable without a session.
--   authenticated  exactly the operations the RLS policies can ever allow
--                  (RLS still decides which rows and which roles). A table with
--                  no policy for an operation gets no grant for it.
--   service_role   SELECT/INSERT/UPDATE/DELETE on every table (the server-side
--                  engines, webhook and cron paths). No TRUNCATE / REFERENCES /
--                  TRIGGER: the Data API never needs them.
--   postgres       unchanged (owner).
--
-- SAFETY. The grants are a superset of what policies allow, so no allowed
-- operation is lost; privileges that were never usable (TRUNCATE, REFERENCES,
-- TRIGGER, and anything on policy-less operations) are removed. Existing
-- column-level restriction on notifications (UPDATE read_at only, migration
-- 027) is preserved. profiles/accounts keep table-level UPDATE because their
-- column guards are triggers (055), which this migration must not reshape.
-- Credential columns (F1) are deliberately NOT handled here: that is a separate
-- migration, applied after the application stops reading them as `authenticated`.
--
-- ROLLBACK. Re-grant: GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN
-- SCHEMA public TO anon, authenticated, service_role; (restores the legacy
-- open state; not recommended).
--
-- NEW TABLES. Default privileges are locked below, so every future table needs
-- its own explicit GRANT in the migration that creates it. supabase/tests
-- (010_coverage_meta) fails if a public table has no reviewed grant.

-- 1. Remove everything first (idempotent; also strips column-level grants).
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- 2. Future tables / sequences created by this role are not auto-exposed.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- 3. service_role: server-side engines read and write everything.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;

-- 4. authenticated: per table, only what a policy can allow.
--    (derived from pg_policies; ALL = all four operations)

-- read-only (no write policy: service-only writes)
GRANT SELECT ON
  public.ai_usage_log,
  public.automation_logs,
  public.flow_run_events,
  public.flow_runs,
  public.member_presence
TO authenticated;

-- read + update (no insert/delete policy)
GRANT SELECT, UPDATE ON
  public.accounts,
  public.profiles
TO authenticated;

-- notifications: read, and update of read_at only (column privilege, 027)
GRANT SELECT ON public.notifications TO authenticated;
GRANT UPDATE (read_at) ON public.notifications TO authenticated;

-- full DML (SELECT + INSERT + UPDATE + DELETE policies)
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.account_invitations,
  public.ai_configs,
  public.ai_knowledge_chunks,
  public.ai_knowledge_documents,
  public.api_keys,
  public.automation_steps,
  public.automations,
  public.broadcast_recipients,
  public.broadcasts,
  public.contact_custom_values,
  public.contact_notes,
  public.contact_tags,
  public.contacts,
  public.conversations,
  public.custom_fields,
  public.deals,
  public.flow_nodes,
  public.flows,
  public.message_reactions,
  public.message_templates,
  public.messages,
  public.pipeline_stages,
  public.pipelines,
  public.quick_replies,
  public.tags,
  public.webhook_endpoints,
  public.whatsapp_config
TO authenticated;

-- automation_pending_executions and pending_message_statuses: no policy at all
-- => service_role only (granted in step 3); authenticated and anon get nothing.
