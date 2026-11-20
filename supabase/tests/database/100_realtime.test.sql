-- 100_realtime — what Realtime can publish, and what it refuses to deliver.
--
-- The app subscribes with postgres_changes only (no Broadcast / Presence). Realtime
-- delivers a change only if the subscriber's role passes RLS on the row, so:
--   * the PUBLICATION decides which tables can ever be streamed at all — a table
--     added to it by mistake (a credentials table) would be a new exposure surface;
--   * anon must never receive a change.
-- This file asserts both. Per-tenant delivery of authenticated events (and what a
-- DELETE event carries) needs wal2json-faithful input and a live Realtime
-- server: it is covered by the full-stack authorization job, not here.
begin;
select * from no_plan();

select tests.guard();

-- ---- the publication is exactly the reviewed set ---------------------------------------
select is((select string_agg(tablename::text, ', ' order by tablename) from pg_publication_tables
            where pubname = 'supabase_realtime'),
          'conversations, flow_runs, member_presence, message_reactions, messages, notifications',
          'supabase_realtime publishes exactly the six reviewed tables');

select is((select string_agg(tablename::text, ', ' order by tablename) from pg_publication_tables
            where pubname = 'supabase_realtime'
              and tablename in ('whatsapp_config', 'ai_configs', 'api_keys', 'webhook_endpoints',
                                'account_invitations', 'profiles', 'accounts')),
          null, 'no credential, invitation, profile or account table is published to Realtime');

-- every published table is RLS-protected, so Realtime filters per subscriber
select is((select string_agg(pt.tablename::text, ', ' order by pt.tablename)
             from pg_publication_tables pt
             join pg_class c on c.relname = pt.tablename and c.relnamespace = pt.schemaname::regnamespace
            where pt.pubname = 'supabase_realtime' and not c.relrowsecurity),
          null, 'every published table has row level security enabled');

-- and every published table is a tenant table the matrix already covers
select is((select string_agg(pt.tablename::text, ', ' order by pt.tablename)
             from pg_publication_tables pt
            where pt.pubname = 'supabase_realtime'
              and pt.tablename::text not in (select tbl from tests.table_class)),
          null, 'every published table is covered by the cross-tenant matrix');

-- ---- no Broadcast / Presence surface -------------------------------------------------------
select is((select count(*)::int from pg_policies where schemaname = 'realtime' and tablename = 'messages'),
          0, 'no realtime.messages policy exists (the app uses neither Broadcast nor Presence)');

-- ---- anon never receives a change -----------------------------------------------------------
select tests.seed_world();
create temp table sub_ids (sid uuid);
insert into sub_ids values (gen_random_uuid());
insert into realtime.subscription (subscription_id, entity, claims)
select sid, 'public.messages'::regclass, '{"role":"anon"}'::jsonb from sub_ids;

create temp table m as
  select * from public.messages
   where conversation_id in (select id from public.conversations where account_id = tests.u('a_acct')) limit 1;

create temp table verdicts as
select r.subscription_ids, r.errors
  from realtime.apply_rls(
         jsonb_build_object(
           'type', 'INSERT', 'schema', 'public', 'table', 'messages', 'commit_timestamp', now(),
           'pk', jsonb_build_array(jsonb_build_object('name', 'id', 'type', 'uuid')),
           'columns', (select jsonb_agg(jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid, null)))
                         from pg_attribute a
                        where a.attrelid = 'public.messages'::regclass and a.attnum > 0 and not a.attisdropped),
           'record', (select to_jsonb(m) from m)),
         1048576) r;

select ok((select count(*) from verdicts v, sub_ids s where s.sid = any(v.subscription_ids)) > 0,
          'POSITIVE CONTROL: the event was processed for the anon subscription');
select is((select count(*)::int from verdicts v, sub_ids s
            where s.sid = any(v.subscription_ids) and v.errors = '{}'::text[]),
          0, 'an anon subscription is never given a change (Realtime answers Unauthorized instead)');

select * from finish();
rollback;
