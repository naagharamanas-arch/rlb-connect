-- 060_known_gaps — documented, NON-cross-tenant gaps. Each open gap is asserted
-- with its SECURE expectation inside a pgTAP TODO, so it shows as
--     not ok N - ... # TODO <id>: <reason>
-- and pg_prove reports "TODO passed" the day it is fixed (then remove the TODO
-- wrapper so the assertion becomes a permanent guard).
--
-- G1 (061) and F1 (063) are both CLOSED: their assertions are permanent hard
-- assertions. This file keeps its name for history; no gap is currently open.
--
-- Nothing in this file touches cross-tenant isolation: any cross-tenant failure
-- belongs in 020/040/050 and must FAIL the suite, never become a TODO.
--
--   G1  (CLOSED by 061) Deployment compatibility: the migrations granted no table
--       privileges to the Data API roles. Deny-by-default (not a leak), but on a
--       Supabase project using the restrictive default the app could not read or write.
--   F1  (CLOSED by 063) Same-tenant credential visibility: members below admin could
--       read credential-bearing columns (WhatsApp tokens, AI keys, webhook signing
--       secret, API-key hash) — six columns, four tables.
begin;
select * from no_plan();

select tests.guard();
select tests.seed_world();

-- ============================================================================
-- G1 — evaluated against the database exactly as the migrations leave it
--      (no emulated grants yet).
-- ============================================================================

-- Guard that PASSES today: least privilege for anon. A future grants migration
-- must not open anon.
select is(
  (select string_agg(c.tbl, ', ' order by c.tbl) from tests.table_class c
    where has_table_privilege('anon', 'public.' || c.tbl, 'SELECT')
       or has_table_privilege('anon', 'public.' || c.tbl, 'INSERT')
       or has_table_privilege('anon', 'public.' || c.tbl, 'UPDATE')
       or has_table_privilege('anon', 'public.' || c.tbl, 'DELETE')),
  null, 'LEAST PRIVILEGE: anon holds no table privilege on any public table');

select is(
  (select string_agg(c.tbl, ', ' order by c.tbl) from tests.table_class c
    where c.owner_readable
      and not has_any_column_privilege('authenticated', 'public.' || c.tbl, 'SELECT')),
  null, 'G1: authenticated can SELECT every user-facing table (RLS then filters rows)');

select is(
  (select string_agg(c.tbl, ', ' order by c.tbl) from tests.table_class c
    where not (has_table_privilege('service_role', 'public.' || c.tbl, 'SELECT')
           and has_table_privilege('service_role', 'public.' || c.tbl, 'INSERT')
           and has_table_privilege('service_role', 'public.' || c.tbl, 'UPDATE')
           and has_table_privilege('service_role', 'public.' || c.tbl, 'DELETE'))),
  null, 'G1: service_role (webhook, automation and flow engines) can read and write every table');

-- ============================================================================
-- F1 — CLOSED by migration 063 (credential columns are unreadable by members).
--      Evaluated against the REAL grants, so this runs BEFORE any emulation.
-- ============================================================================
create temp table cred (tbl text, col text);
insert into cred values
  ('whatsapp_config', 'access_token'), ('whatsapp_config', 'verify_token'),
  ('ai_configs', 'api_key'), ('ai_configs', 'embeddings_api_key'),
  ('webhook_endpoints', 'secret'), ('api_keys', 'key_hash');

-- No member of ANY role (viewer .. owner) can read a credential column: the
-- shared `authenticated` role has no SELECT on it. Strict: the failure must be
-- the privilege error itself, not an empty result.
select is(tests.probe_count_strict(r.uid, format('select %I from public.%I where account_id = %L', c.col, c.tbl, tests.u('a_acct'))),
          'err=42501', format('F1: a %s member cannot read %s.%s', r.name, c.tbl, c.col))
from cred c
cross join (values ('viewer', tests.u('a_viewer')), ('agent', tests.u('a_agent')),
                   ('admin', tests.u('a_admin')), ('owner', tests.u('a_owner'))) r(name, uid)
order by c.tbl, c.col, r.name;

-- `select *` on those tables is refused as well (documented breaking change:
-- callers must name non-secret columns or use src/lib/credentials/server.ts).
select is(tests.probe_count_strict(tests.u('a_owner'), format('select * from public.%I where account_id = %L', t.tbl, tests.u('a_acct'))),
          'err=42501', format('F1: even the owner cannot select * from %s', t.tbl))
from (select distinct tbl from cred) t;

-- POSITIVE CONTROLS: the server (service_role) can still read every credential
-- column, and admins can still WRITE them (saving credentials is unchanged).
select ok(has_column_privilege('service_role', 'public.' || c.tbl, c.col, 'SELECT'),
          format('POSITIVE CONTROL: service_role can read %s.%s', c.tbl, c.col)) from cred c;
select ok(has_column_privilege('authenticated', 'public.' || c.tbl, c.col, 'INSERT')
      and has_column_privilege('authenticated', 'public.' || c.tbl, c.col, 'UPDATE'),
          format('POSITIVE CONTROL: authenticated can still write %s.%s (RLS gates it to admin+)', c.tbl, c.col)) from cred c;

-- POSITIVE CONTROL: admins still read the NON-secret columns of their own row.
select ok(tests.probe_count(tests.u('a_admin'), format('select id, phone_number_id, status, has_verify_token from public.whatsapp_config where account_id = %L', tests.u('a_acct'))) ~ '^n=[1-9]',
          'POSITIVE CONTROL: an admin can still read the non-secret whatsapp_config columns');
select ok(tests.probe_count(tests.u('a_viewer'), format('select id, provider, model, is_active from public.ai_configs where account_id = %L', tests.u('a_acct'))) ~ '^n=[1-9]',
          'POSITIVE CONTROL: a viewer can still read the non-secret ai_configs columns');

-- Cross-tenant remains airtight for the same columns, under open grants (RLS is
-- then the only barrier). Must always pass.
select tests.emulate_legacy_data_api_grants();
select is(tests.probe_count(tests.u('b_owner'), format('select %I from public.%I where account_id = %L', c.col, c.tbl, tests.u('a_acct'))),
          'n=0', format('another tenant cannot read A''s %s.%s', c.tbl, c.col))
from cred c;

select * from finish();
rollback;
