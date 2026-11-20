-- ============================================================================
-- 000_helpers.test.sql — shared helpers for the cross-tenant database suite.
--
-- Run with:  npx --yes supabase@2.113.0 test db        (LOCAL database only)
--
-- This file intentionally has NO begin/rollback: the `tests` schema must
-- persist so the later files (each run in its own session) can use it.
-- 999_teardown.test.sql drops it again.
--
-- SAFETY
--   * tests.guard() aborts if auth.users contains any user that is not a
--     throw-away @test.invalid account, so the suite cannot meaningfully run
--     against a database that holds real users.
--   * Every probe runs in a sub-transaction that is rolled back, and each
--     test file wraps its work in begin ... rollback.
--
-- DESIGN
--   * tests.probe_* run one statement AS a given user (or anon) and return a
--     string: 'n=<count>' (rows seen / affected) or 'err=<SQLSTATE>'. They
--     never leave side effects, so any number of probes are independent.
--   * Positive controls ("A can see A's rows") accompany every "B cannot"
--     check, so a broken harness cannot produce a vacuous pass.
-- ============================================================================

drop schema if exists tests cascade;
create schema tests;
grant usage on schema tests to public;

create extension if not exists pgtap with schema extensions;

-- ---- safety guard ----------------------------------------------------------
create function tests.guard() returns void
language plpgsql as $$
begin
  if exists (select 1 from auth.users
             where email is not null and email not like '%@test.invalid') then
    raise exception 'tests.guard: refusing to run — auth.users contains non-test users';
  end if;
end $$;

-- ---- users / membership ----------------------------------------------------
-- Creating an auth user fires handle_new_user: the user's personal account and
-- owner profile appear exactly as they do for a real signup.
create function tests.new_user(p_email text) returns uuid
language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  perform tests.guard();
  insert into auth.users (id, email, aud, role) values (v, p_email, 'authenticated', 'authenticated');
  return v;
end $$;

-- Setup runs as superuser; the profile-privilege trigger only blocks the
-- `authenticated` role, so a user can be moved into another account here.
-- Like redeem_invitation, this also deletes the user's now-orphaned personal
-- account (otherwise the one-account-per-owner index collides later).
create function tests.set_member(p_user uuid, p_account uuid, p_role public.account_role_enum)
returns void language plpgsql as $$
declare v_old uuid;
begin
  select account_id into v_old from public.profiles where user_id = p_user;
  update public.profiles set account_id = p_account, account_role = p_role where user_id = p_user;
  if v_old is not null and v_old <> p_account then
    delete from public.accounts where id = v_old and owner_user_id = p_user;
  end if;
end $$;

-- ---- probes ----------------------------------------------------------------
-- p_user NULL  => anon.   p_mode: 'count' | 'dml' | 'val'
create function tests._probe(p_user uuid, p_sql text, p_mode text, p_strict boolean default false) returns text
language plpgsql as $$
declare
  v_res text;
  v_n   bigint;
  v_txt text;
  v_msg text;
begin
  begin
    if p_user is null then
      perform set_config('request.jwt.claims', '{"role":"anon"}', true);
      perform set_config('request.jwt.claim.sub', '', true);
      perform set_config('request.jwt.claim.role', 'anon', true);
      execute 'set local role anon';
    else
      perform set_config('request.jwt.claims',
        json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', p_user::text, true);
      perform set_config('request.jwt.claim.role', 'authenticated', true);
      execute 'set local role authenticated';
    end if;

    if p_mode = 'count' then
      execute 'select count(*) from (' || p_sql || ') q' into v_n;
      v_res := 'n=' || v_n;
    elsif p_mode = 'dml' then
      execute p_sql;
      get diagnostics v_n = row_count;
      v_res := 'n=' || v_n;
    else
      execute 'select (' || p_sql || ')::text' into v_txt;
      v_res := 'val=' || coalesce(v_txt, '<null>');
    end if;

    -- Force the sub-transaction (and every effect of the statement) to roll back.
    raise exception 'probe rollback' using errcode = 'TP001';
  exception
    when sqlstate 'TP001' then null;
    when others then
      get stacked diagnostics v_msg = message_text;
      v_res := 'err=' || sqlstate;
      -- DUAL MODE (see emulate_legacy_data_api_grants). Under the REAL least-privilege
      -- grants (061) a read/update/delete the role has no table privilege for fails with
      -- 42501 "permission denied for table" before RLS is even consulted. That is a
      -- denial exactly like RLS filtering to zero rows, so it is reported as n=0 and the
      -- existing "cannot X" assertions keep their meaning. Never applied to INSERT (whose
      -- expected outcome is already err=42501), to column privilege checks (use
      -- probe_dml_strict), or when open grants are emulated (RLS-only mode stays strict:
      -- there a 42501 is still reported as such and fails the "n=0" assertions).
      if v_res = 'err=42501' and not p_strict and p_mode in ('count', 'dml')
         and current_setting('tests.emulated', true) is distinct from 'on'
         and v_msg like 'permission denied for table %'
         and p_sql ~* '^\s*(select|update|delete|with)' then
        v_res := 'n=0';
      end if;
  end;
  return v_res;
end $$;

-- Run p_stmt as the user, then inspect its EFFECT as superuser with p_check
-- (a query returning one text value); everything is rolled back.
create function tests.probe_effect(p_user uuid, p_stmt text, p_check text) returns text
language plpgsql as $$
declare v_res text; v_chk text;
begin
  begin
    if p_user is null then
      perform set_config('request.jwt.claims', '{"role":"anon"}', true);
      perform set_config('request.jwt.claim.sub', '', true);
      perform set_config('request.jwt.claim.role', 'anon', true);
      execute 'set local role anon';
    else
      perform set_config('request.jwt.claims',
        json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', p_user::text, true);
      perform set_config('request.jwt.claim.role', 'authenticated', true);
      execute 'set local role authenticated';
    end if;
    execute p_stmt;
    execute 'reset role';
    execute p_check into v_chk;
    v_res := 'val=' || coalesce(v_chk, '<null>');
    raise exception 'probe rollback' using errcode = 'TP001';
  exception
    when sqlstate 'TP001' then null;
    when others then v_res := 'err=' || sqlstate;
  end;
  return v_res;
end $$;

create function tests.probe_count(p_user uuid, p_query text) returns text
language sql as $$ select tests._probe(p_user, p_query, 'count') $$;

create function tests.probe_dml(p_user uuid, p_stmt text) returns text
language sql as $$ select tests._probe(p_user, p_stmt, 'dml') $$;

-- Strict variant: never maps a permission error to n=0 (for column-privilege assertions).
create function tests.probe_dml_strict(p_user uuid, p_stmt text) returns text
language sql as $$ select tests._probe(p_user, p_stmt, 'dml', true) $$;

-- Strict count probe: reports a privilege error as err=42501 even under real grants.
create function tests.probe_count_strict(p_user uuid, p_query text) returns text
language sql as $$ select tests._probe(p_user, p_query, 'count', true) $$;

create function tests.probe_val(p_user uuid, p_expr text) returns text
language sql as $$ select tests._probe(p_user, p_expr, 'val') $$;

-- ---- emulate the legacy open Data-API grants (per-transaction) --------------
-- Before migration 061 the migrations never GRANTed table privileges (they
-- predate Supabase's restrictive 2026 default for public tables) and relied on
-- RLS alone — former gap G1, now CLOSED by 061 and asserted in 060 and 070.
-- The real grants are therefore the default under test; the "open grants" mode
-- keeps this emulation to test RLS as THE barrier: each test file calls
-- this INSIDE its own transaction (rolled back with it): everything is
-- granted to anon/authenticated/service_role, then migration 027's
-- column-level intent is re-applied. If RLS holds under maximal grants it
-- holds under narrower ones.
create function tests.emulate_legacy_data_api_grants() returns void
language plpgsql as $$
begin
  -- DUAL MODE. Once the migrations themselves grant table privileges (061), the
  -- suite must run against THOSE grants, not an emulated open default that would
  -- mask a missing one. So: emulate only while authenticated holds no table
  -- privilege at all (the pre-061 deny-by-default state).
  -- Open mode (CI second pass): `alter database ... set tests.open_grants = 'on'`
  -- forces the emulation even on top of the real grants, so RLS is again tested
  -- as the ONLY barrier (a regression in RLS cannot hide behind a grant).
  if has_table_privilege('authenticated', 'public.contacts', 'SELECT')
     and coalesce(current_setting('tests.open_grants', true), '') <> 'on' then
    return;
  end if;
  perform set_config('tests.emulated', 'on', true);
  execute 'grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role';
  execute 'grant usage, select on all sequences in schema public to anon, authenticated, service_role';
  execute 'revoke update on public.notifications from authenticated';
  execute 'grant update (read_at) on public.notifications to authenticated';
end $$;

-- ---- table classification (every public table MUST appear here) -------------
-- class: 'core'   accounts / profiles / account_invitations
--        'tenant' carries account_id
--        'child'  scoped only through a parent row (fk_col -> parent.id)
-- owner_readable=false: no policy lets any user read it (service-role only).
create table tests.table_class (
  tbl            text primary key,
  class          text not null check (class in ('core','tenant','child')),
  fk_col         text,
  parent         text,
  owner_readable boolean not null default true
);

insert into tests.table_class (tbl, class) values
  ('accounts','core'), ('profiles','core'), ('account_invitations','core'),
  ('contacts','tenant'), ('tags','tenant'), ('custom_fields','tenant'),
  ('contact_notes','tenant'), ('conversations','tenant'), ('whatsapp_config','tenant'),
  ('message_templates','tenant'), ('pipelines','tenant'), ('deals','tenant'),
  ('broadcasts','tenant'), ('automations','tenant'), ('automation_logs','tenant'),
  ('automation_pending_executions','tenant'), ('flows','tenant'), ('flow_runs','tenant'),
  ('member_presence','tenant'), ('api_keys','tenant'), ('notifications','tenant'),
  ('webhook_endpoints','tenant'), ('ai_configs','tenant'), ('ai_knowledge_documents','tenant'),
  ('ai_knowledge_chunks','tenant'), ('ai_usage_log','tenant'), ('quick_replies','tenant'),
  ('pending_message_statuses','tenant');

insert into tests.table_class (tbl, class, fk_col, parent) values
  ('messages','child','conversation_id','conversations'),
  ('contact_tags','child','contact_id','contacts'),
  ('contact_custom_values','child','contact_id','contacts'),
  ('pipeline_stages','child','pipeline_id','pipelines'),
  ('broadcast_recipients','child','broadcast_id','broadcasts'),
  ('automation_steps','child','automation_id','automations'),
  ('message_reactions','child','conversation_id','conversations'),
  ('flow_nodes','child','flow_id','flows'),
  ('flow_run_events','child','flow_run_id','flow_runs');

-- No policy exists for these two: only the service role can touch them.
update tests.table_class set owner_readable = false
 where tbl in ('automation_pending_executions', 'pending_message_statuses');

-- ---- per-(table, op) minimum role, derived from the policies as they stand --
-- min_rank: 1 viewer, 2 agent, 3 admin, 4 owner; NULL = no policy (nobody).
-- `gap` marks a row that 030_role_matrix must skip because its behaviour is
-- asserted elsewhere; no row is currently marked. The former F1 gap
-- (same-tenant credential visibility) is CLOSED by migration 063: members may
-- read the non-secret columns of the credential tables (rank 1 below), while the
-- secret columns themselves are asserted unreadable in 060 and 080.
create table tests.role_expect (
  tbl      text not null,
  op       text not null check (op in ('SELECT','INSERT','UPDATE','DELETE')),
  min_rank int,
  gap      text,
  primary key (tbl, op)
);

insert into tests.role_expect (tbl, op, min_rank) values
  ('account_invitations','SELECT',3), ('account_invitations','INSERT',3), ('account_invitations','UPDATE',3), ('account_invitations','DELETE',3),
  ('accounts','SELECT',1), ('accounts','INSERT',null), ('accounts','UPDATE',3), ('accounts','DELETE',null),
  ('ai_knowledge_chunks','SELECT',1), ('ai_knowledge_chunks','INSERT',3), ('ai_knowledge_chunks','UPDATE',3), ('ai_knowledge_chunks','DELETE',3),
  ('ai_knowledge_documents','SELECT',1), ('ai_knowledge_documents','INSERT',3), ('ai_knowledge_documents','UPDATE',3), ('ai_knowledge_documents','DELETE',3),
  ('ai_usage_log','SELECT',3), ('ai_usage_log','INSERT',null), ('ai_usage_log','UPDATE',null), ('ai_usage_log','DELETE',null),
  ('automation_logs','SELECT',1), ('automation_logs','INSERT',null), ('automation_logs','UPDATE',null), ('automation_logs','DELETE',null),
  ('automation_pending_executions','SELECT',null), ('automation_pending_executions','INSERT',null), ('automation_pending_executions','UPDATE',null), ('automation_pending_executions','DELETE',null),
  ('automation_steps','SELECT',1), ('automation_steps','INSERT',2), ('automation_steps','UPDATE',2), ('automation_steps','DELETE',2),
  ('automations','SELECT',1), ('automations','INSERT',2), ('automations','UPDATE',2), ('automations','DELETE',2),
  ('broadcast_recipients','SELECT',1), ('broadcast_recipients','INSERT',2), ('broadcast_recipients','UPDATE',2), ('broadcast_recipients','DELETE',2),
  ('broadcasts','SELECT',1), ('broadcasts','INSERT',2), ('broadcasts','UPDATE',2), ('broadcasts','DELETE',2),
  ('contact_custom_values','SELECT',1), ('contact_custom_values','INSERT',2), ('contact_custom_values','UPDATE',2), ('contact_custom_values','DELETE',2),
  ('contact_notes','SELECT',1), ('contact_notes','INSERT',2), ('contact_notes','UPDATE',2), ('contact_notes','DELETE',2),
  ('contact_tags','SELECT',1), ('contact_tags','INSERT',2), ('contact_tags','UPDATE',2), ('contact_tags','DELETE',2),
  ('contacts','SELECT',1), ('contacts','INSERT',2), ('contacts','UPDATE',2), ('contacts','DELETE',2),
  ('conversations','SELECT',1), ('conversations','INSERT',2), ('conversations','UPDATE',2), ('conversations','DELETE',2),
  ('custom_fields','SELECT',1), ('custom_fields','INSERT',3), ('custom_fields','UPDATE',3), ('custom_fields','DELETE',3),
  ('deals','SELECT',1), ('deals','INSERT',2), ('deals','UPDATE',2), ('deals','DELETE',2),
  ('flow_nodes','SELECT',1), ('flow_nodes','INSERT',2), ('flow_nodes','UPDATE',2), ('flow_nodes','DELETE',2),
  ('flow_run_events','SELECT',1), ('flow_run_events','INSERT',null), ('flow_run_events','UPDATE',null), ('flow_run_events','DELETE',null),
  ('flow_runs','SELECT',1), ('flow_runs','INSERT',null), ('flow_runs','UPDATE',null), ('flow_runs','DELETE',null),
  ('flows','SELECT',1), ('flows','INSERT',2), ('flows','UPDATE',2), ('flows','DELETE',2),
  ('member_presence','SELECT',1), ('member_presence','INSERT',null), ('member_presence','UPDATE',null), ('member_presence','DELETE',null),
  ('message_reactions','SELECT',1), ('message_reactions','INSERT',2), ('message_reactions','UPDATE',2), ('message_reactions','DELETE',2),
  ('message_templates','SELECT',1), ('message_templates','INSERT',3), ('message_templates','UPDATE',3), ('message_templates','DELETE',3),
  ('messages','SELECT',1), ('messages','INSERT',2), ('messages','UPDATE',2), ('messages','DELETE',2),
  ('pending_message_statuses','SELECT',null), ('pending_message_statuses','INSERT',null), ('pending_message_statuses','UPDATE',null), ('pending_message_statuses','DELETE',null),
  ('pipeline_stages','SELECT',1), ('pipeline_stages','INSERT',3), ('pipeline_stages','UPDATE',3), ('pipeline_stages','DELETE',3),
  ('pipelines','SELECT',1), ('pipelines','INSERT',3), ('pipelines','UPDATE',3), ('pipelines','DELETE',3),
  ('quick_replies','SELECT',1), ('quick_replies','INSERT',2), ('quick_replies','UPDATE',2), ('quick_replies','DELETE',2),
  ('tags','SELECT',1), ('tags','INSERT',3), ('tags','UPDATE',3), ('tags','DELETE',3);

-- Credential-bearing tables. Rows may be READ (non-secret columns only; the secret
-- columns are withheld from `authenticated` entirely by migration 063 and asserted
-- in 060/080) by any member; writes are admin+.
insert into tests.role_expect (tbl, op, min_rank) values
  ('whatsapp_config','SELECT',1), ('whatsapp_config','INSERT',3), ('whatsapp_config','UPDATE',3), ('whatsapp_config','DELETE',3),
  ('ai_configs','SELECT',1),      ('ai_configs','INSERT',3),      ('ai_configs','UPDATE',3),      ('ai_configs','DELETE',3),
  ('api_keys','SELECT',1),        ('api_keys','INSERT',3),        ('api_keys','UPDATE',3),        ('api_keys','DELETE',3),
  ('webhook_endpoints','SELECT',1),('webhook_endpoints','INSERT',3),('webhook_endpoints','UPDATE',3),('webhook_endpoints','DELETE',3);

-- notifications and profiles are keyed on auth.uid(), not on role: tested
-- explicitly in 030, so they carry no role_expect rows.

-- ---- helpers over the classification ----------------------------------------
create function tests.touch_col(p_tbl text) returns text
language sql stable as $$
  select case when p_tbl = 'notifications' then 'read_at'
         else (select column_name::text from information_schema.columns
               where table_schema = 'public' and table_name = p_tbl
               order by ordinal_position limit 1) end
$$;

-- SQL predicate selecting exactly one tenant's rows in a table, with every
-- parent id inlined as a LITERAL (so it works as another user without
-- relying on that user being able to see the parent).
create function tests.pred(p_tbl text, p_acct uuid) returns text
language plpgsql set search_path = public, pg_temp as $$
declare c tests.table_class; ids uuid[];
begin
  select * into c from tests.table_class where tbl = p_tbl;
  if c.class = 'child' then
    execute format('select coalesce(array_agg(id), ''{}'') from public.%I where account_id = %L', c.parent, p_acct)
      into ids;
    return format('%I = any(%L::uuid[])', c.fk_col, ids);
  elsif p_tbl = 'accounts' then
    return format('id = %L', p_acct);
  else
    return format('account_id = %L', p_acct);
  end if;
end $$;

-- A statement that tries to INSERT a copy of one of the tenant's rows
-- (generated columns and the id removed). Executed by another principal it
-- must fail with 42501 — and ONLY 42501 — otherwise the RLS check did not
-- stop it.
create function tests.insert_copy_stmt(p_tbl text, p_acct uuid) returns text
language plpgsql set search_path = public, pg_temp as $$
declare j jsonb; cols text;
begin
  execute format('select to_jsonb(t) from public.%I t where %s limit 1', p_tbl, tests.pred(p_tbl, p_acct)) into j;
  if j is null then return null; end if;
  -- Insertable columns only: a generated/identity-always column must not be
  -- named at all (even NULL is rejected with 428C9, before RLS is reached).
  select string_agg(quote_ident(column_name::text), ', ' order by ordinal_position) into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = p_tbl
    and is_generated <> 'ALWAYS'
    and not (is_identity = 'YES' and identity_generation = 'ALWAYS')
    and column_name <> 'id';
  j := j - 'id';
  return format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, %L::jsonb)',
                p_tbl, cols, cols, p_tbl, j::text);
end $$;

-- ---- seed one tenant with a row in EVERY table ------------------------------
create function tests.seed_tenant(p_label text, p_owner uuid, p_acct uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  ph text := case p_label when 'a' then '+1555010' else '+1555020' end;
  v_contact uuid; v_conv uuid; v_msg uuid; v_tag uuid; v_cf uuid; v_pipe uuid; v_stage uuid;
  v_bc uuid; v_auto uuid; v_log uuid; v_flow uuid; v_run uuid; v_doc uuid;
begin
  insert into account_invitations (account_id, token_hash, role, expires_at, created_by_user_id)
  values (p_acct, 'inv-hash-' || p_label, 'agent', now() + interval '1 day', p_owner);

  insert into contacts (user_id, account_id, phone, name) values (p_owner, p_acct, ph || '1', 'Contact ' || p_label)
  returning id into v_contact;
  insert into tags (user_id, account_id, name) values (p_owner, p_acct, 'tag-' || p_label) returning id into v_tag;
  insert into contact_tags (contact_id, tag_id) values (v_contact, v_tag);
  insert into custom_fields (user_id, account_id, field_name) values (p_owner, p_acct, 'field-' || p_label) returning id into v_cf;
  insert into contact_custom_values (contact_id, custom_field_id) values (v_contact, v_cf);
  insert into contact_notes (contact_id, user_id, account_id, note_text) values (v_contact, p_owner, p_acct, 'note ' || p_label);

  insert into conversations (user_id, account_id, contact_id) values (p_owner, p_acct, v_contact) returning id into v_conv;
  insert into messages (conversation_id, sender_type, content_text) values (v_conv, 'customer', 'message from ' || p_label)
  returning id into v_msg;
  insert into message_reactions (message_id, conversation_id, actor_type, emoji) values (v_msg, v_conv, 'customer', 'x');

  insert into whatsapp_config (user_id, account_id, phone_number_id, access_token)
  values (p_owner, p_acct, 'phone-id-' || p_label, 'dummy-not-a-real-token');
  insert into message_templates (user_id, account_id, name, body_text) values (p_owner, p_acct, 'tpl_' || p_label, 'hello');

  insert into pipelines (user_id, account_id, name) values (p_owner, p_acct, 'pipe-' || p_label) returning id into v_pipe;
  insert into pipeline_stages (pipeline_id, name) values (v_pipe, 'stage-' || p_label) returning id into v_stage;
  insert into deals (user_id, account_id, pipeline_id, stage_id, title) values (p_owner, p_acct, v_pipe, v_stage, 'deal-' || p_label);

  insert into broadcasts (user_id, account_id, name, template_name) values (p_owner, p_acct, 'bc-' || p_label, 'tpl_' || p_label)
  returning id into v_bc;
  insert into broadcast_recipients (broadcast_id, contact_id) values (v_bc, v_contact);

  insert into automations (user_id, account_id, name, trigger_type) values (p_owner, p_acct, 'auto-' || p_label, 'inbound_message')
  returning id into v_auto;
  insert into automation_steps (automation_id, step_type, position) values (v_auto, 'send_message', 0);
  insert into automation_logs (automation_id, user_id, account_id, trigger_event, status)
  values (v_auto, p_owner, p_acct, 'test', 'success') returning id into v_log;
  insert into automation_pending_executions (automation_id, user_id, account_id, next_step_position, run_at)
  values (v_auto, p_owner, p_acct, 0, now());

  insert into flows (user_id, account_id, name, trigger_type) values (p_owner, p_acct, 'flow-' || p_label, 'manual')
  returning id into v_flow;
  insert into flow_nodes (flow_id, node_key, node_type) values (v_flow, 'start', 'start');
  insert into flow_runs (flow_id, user_id, account_id, contact_id) values (v_flow, p_owner, p_acct, v_contact)
  returning id into v_run;
  insert into flow_run_events (flow_run_id, event_type) values (v_run, 'started');

  insert into member_presence (user_id, account_id) values (p_owner, p_acct);
  insert into api_keys (account_id, name, key_prefix, key_hash)
  values (p_acct, 'key-' || p_label, 'rlbtest_' || p_label, 'hash-' || p_label || '-' || gen_random_uuid());
  insert into notifications (account_id, user_id, title) values (p_acct, p_owner, 'notice ' || p_label);
  insert into webhook_endpoints (account_id, url, secret) values (p_acct, 'https://example.invalid/' || p_label, 'whsec-dummy-' || p_label);

  insert into ai_configs (account_id, provider, model, api_key) values (p_acct, 'openai', 'test-model', 'dummy-not-a-real-key');
  insert into ai_knowledge_documents (account_id, title, content) values (p_acct, 'doc ' || p_label, 'zebra policy ' || p_label)
  returning id into v_doc;
  insert into ai_knowledge_chunks (document_id, account_id, content) values (v_doc, p_acct, 'zebra policy ' || p_label);
  insert into ai_usage_log (account_id, mode, provider, model) values (p_acct, 'draft', 'openai', 'test-model');
  insert into quick_replies (account_id, user_id, title, content_text) values (p_acct, p_owner, 'qr-' || p_label, 'hi');
  insert into pending_message_statuses (account_id, wamid, status) values (p_acct, 'wamid-' || p_label, 'delivered');

  -- ids the RPC / storage tests need
  perform set_config('tests.' || p_label || '_contact', v_contact::text, true);
  perform set_config('tests.' || p_label || '_conv', v_conv::text, true);
  perform set_config('tests.' || p_label || '_tag', v_tag::text, true);
  perform set_config('tests.' || p_label || '_flow', v_flow::text, true);
  perform set_config('tests.' || p_label || '_bcast', v_bc::text, true);
  perform set_config('tests.' || p_label || '_inv_hash', 'inv-hash-' || p_label, true);
end $$;

-- Two tenants. A also has an admin, an agent and a viewer; B only an owner.
-- (Each member keeps a personal account from signup — irrelevant to the tests.)
create function tests.seed_world() returns void
language plpgsql as $$
declare
  a_owner uuid := tests.new_user('a-owner@test.invalid');
  a_admin uuid := tests.new_user('a-admin@test.invalid');
  a_agent uuid := tests.new_user('a-agent@test.invalid');
  a_viewer uuid := tests.new_user('a-viewer@test.invalid');
  b_owner uuid := tests.new_user('b-owner@test.invalid');
  a_acct uuid; b_acct uuid;
begin
  select account_id into a_acct from public.profiles where user_id = a_owner;
  select account_id into b_acct from public.profiles where user_id = b_owner;
  perform tests.set_member(a_admin,  a_acct, 'admin');
  perform tests.set_member(a_agent,  a_acct, 'agent');
  perform tests.set_member(a_viewer, a_acct, 'viewer');

  perform set_config('tests.a_acct', a_acct::text, true);
  perform set_config('tests.b_acct', b_acct::text, true);
  perform set_config('tests.a_owner', a_owner::text, true);
  perform set_config('tests.a_admin', a_admin::text, true);
  perform set_config('tests.a_agent', a_agent::text, true);
  perform set_config('tests.a_viewer', a_viewer::text, true);
  perform set_config('tests.b_owner', b_owner::text, true);

  perform tests.seed_tenant('a', a_owner, a_acct);
  perform tests.seed_tenant('b', b_owner, b_acct);
end $$;

-- convenience accessors (superuser context)
create function tests.u(p_name text) returns uuid language sql stable as $$ select current_setting('tests.' || p_name)::uuid $$;

select plan(2);
select ok(true, 'helpers installed');
select is((select count(*) from tests.table_class)::int, 37, 'classification lists 37 tables');
select * from finish();
