-- 010_coverage_meta — structural guards. These fail when someone ADDS a table,
-- a policy, or an exposed function without it being reviewed and classified
-- here, so new surface can never silently escape the isolation tests.
begin;
select * from no_plan();

select tests.guard();
select tests.seed_world();

-- ---- tables ------------------------------------------------------------------
select is(
  (select string_agg(t.tablename, ', ' order by t.tablename) from pg_tables t
    where t.schemaname = 'public' and not exists (select 1 from tests.table_class c where c.tbl = t.tablename)),
  null, 'every public table is classified in tests.table_class (unclassified tables are listed on failure)');

select is(
  (select string_agg(c.tbl, ', ' order by c.tbl) from tests.table_class c
    where not exists (select 1 from pg_tables t where t.schemaname = 'public' and t.tablename = c.tbl)),
  null, 'every classified table still exists');

select is(
  (select string_agg(c.relname, ', ' order by c.relname) from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity),
  null, 'row level security is enabled on every public table');

select is(
  (select string_agg(tablename, ', ' order by tablename) from pg_policies
    where schemaname = 'public' and (trim(qual) = 'true' or trim(with_check) = 'true')),
  null, 'no public-schema policy is unconditionally true');

-- Tables with no policy at all are service-role only. That list must stay exactly this.
select is(
  (select string_agg(t.tablename, ', ' order by t.tablename) from pg_tables t
    where t.schemaname = 'public'
      and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.tablename)),
  'automation_pending_executions, pending_message_statuses',
  'only the two reviewed service-role-only tables have no policy');

-- ---- every table has seeded rows for BOTH tenants (no vacuous isolation checks)
select is(
  (select string_agg(c.tbl, ', ' order by c.tbl) from tests.table_class c
    where coalesce((xpath('/row/n/text()',
            query_to_xml(format('select count(*) n from public.%I where %s', c.tbl, tests.pred(c.tbl, tests.u('a_acct'))), false, true, '')))[1]::text::int, 0) = 0),
  null, 'tenant A has at least one seeded row in every table');

select is(
  (select string_agg(c.tbl, ', ' order by c.tbl) from tests.table_class c
    where coalesce((xpath('/row/n/text()',
            query_to_xml(format('select count(*) n from public.%I where %s', c.tbl, tests.pred(c.tbl, tests.u('b_acct'))), false, true, '')))[1]::text::int, 0) = 0),
  null, 'tenant B has at least one seeded row in every table');

-- ---- role_expect covers every table (except the two uid-keyed ones) ----------
select is(
  (select string_agg(c.tbl, ', ' order by c.tbl) from tests.table_class c
    where c.tbl not in ('notifications', 'profiles')
      and (select count(*) from tests.role_expect r where r.tbl = c.tbl) <> 4),
  null, 'role expectations exist for all four operations on every table (except notifications/profiles)');

-- ---- function exposure allowlists ----------------------------------------------
-- Reviewed lists. Anything app-defined in `public` that anon/authenticated can
-- EXECUTE must be named here. Add a name only after reviewing the function's
-- own authorization (reasons below).
create temp table allow_anon (fn text primary key, why text);
insert into allow_anon values
  ('is_account_member',                      'returns false when auth.uid() is null'),
  ('peek_invitation',                        'by design: invite landing page; returns only account name/role/expiry for a valid token hash'),
  ('touch_presence',                         'raises 42501 when auth.uid() is null (hardening: revoke from anon)'),
  ('handle_new_user',                        'trigger function; cannot be invoked directly (hardening: revoke from anon)'),
  ('notify_conversation_assigned',           'trigger function; cannot be invoked directly'),
  ('broadcast_recipient_aggregate_trigger',  'trigger function; cannot be invoked directly'),
  ('update_updated_at_column',               'trigger function'),
  ('update_ai_configs_updated_at',           'trigger function'),
  ('update_ai_knowledge_documents_updated_at','trigger function'),
  ('enforce_profile_privilege_columns',      'trigger function'),
  ('enforce_account_identity_columns',       'trigger function'),
  ('stamp_conversation_closed_at',           'trigger function'),
  ('stamp_deal_closed_at',                   'trigger function'),
  ('_bcast_cols_for_status',                 'pure helper; touches no table');

create temp table allow_auth (fn text primary key, why text);
insert into allow_auth select fn, why from allow_anon;
insert into allow_auth values
  ('has_account_access',              'membership check for auth.uid(); returns false when there is none (see 110)'),
  ('set_member_role',                  'caller must be admin/owner of the target''s account (see 040)'),
  ('remove_account_member',            'same-account admin/owner only (see 040)'),
  ('transfer_account_ownership',       'owner only (see 040)'),
  ('redeem_invitation',                'requires a valid unexpired unused token hash (see 040)'),
  ('dashboard_overview',               'scoped to caller''s account (see 040)'),
  ('replace_flow_nodes',               'agent+ in the flow''s account (see 040)'),
  ('replace_flow_graph',               'delegates to replace_flow_nodes (see 040)'),
  ('acquire_broadcast_delivery_lease', 'agent+ in the broadcast''s account (see 040)'),
  ('renew_broadcast_delivery_lease',   'agent+ in the broadcast''s account (see 040)'),
  ('broadcast_delivery_in_flight',     'SECURITY INVOKER: RLS applies (see 040)'),
  ('filter_contacts_by_tags',          'SECURITY INVOKER: RLS applies (see 040)'),
  ('match_ai_knowledge_fts',           'SECURITY INVOKER: RLS applies (see 040)'),
  ('match_ai_knowledge_semantic',      'SECURITY INVOKER: RLS applies (see 040)');

create temp view app_fns as
  select p.oid, p.proname, p.prosecdef
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');   -- exclude extension members

select is(
  (select string_agg(distinct f.proname, ', ' order by f.proname) from app_fns f
    where has_function_privilege('anon', f.oid, 'EXECUTE') and f.proname not in (select fn from allow_anon)),
  null, 'no un-reviewed app function is executable by ANON');

select is(
  (select string_agg(distinct f.proname, ', ' order by f.proname) from app_fns f
    where has_function_privilege('authenticated', f.oid, 'EXECUTE') and f.proname not in (select fn from allow_auth)),
  null, 'no un-reviewed app function is executable by AUTHENTICATED (service-only functions stay service-only)');

select is(
  (select string_agg(distinct f.proname, ', ' order by f.proname) from app_fns f
    where f.prosecdef and (select p.proconfig is null or p.proconfig::text not like '%search_path%' from pg_proc p where p.oid = f.oid)),
  null, 'every SECURITY DEFINER function pins search_path');

-- Reviewed names must still exist (a typo here would hide a gap).
select is(
  (select string_agg(a.fn, ', ' order by a.fn) from allow_auth a where not exists (select 1 from app_fns f where f.proname = a.fn)),
  null, 'every allowlisted function name exists');

select * from finish();
rollback;
