-- 100_realtime — what Realtime can publish, and what it refuses to deliver.
--
-- The app subscribes with postgres_changes only (no Broadcast / Presence). Realtime
-- delivers an INSERT/UPDATE only if the subscriber's role passes RLS on the row, but it
-- does NOT apply RLS to DELETE events: every subscriber of a published table would
-- receive the primary key of every tenant's deleted rows. Migration 065 therefore
--   * stops publishing DELETE (and TRUNCATE) altogether, and
--   * serves the app's legitimate "something was deleted" needs through
--     public.realtime_deletions, whose INSERT events ARE RLS-filtered.
-- This file asserts the publication contract and the behaviour of the signal table.
-- Per-subscriber delivery over a live Realtime server (including "no DELETE event for
-- anyone") is covered by the full-stack authorization job.
begin;
select * from no_plan();

select tests.guard();

-- ---- the publication is exactly the reviewed set ---------------------------------------
select is((select string_agg(tablename::text, ', ' order by tablename) from pg_publication_tables
            where pubname = 'supabase_realtime'),
          'conversations, flow_runs, member_presence, message_reactions, messages, notifications, realtime_deletions',
          'supabase_realtime publishes exactly the seven reviewed tables');

select is((select string_agg(tablename::text, ', ' order by tablename) from pg_publication_tables
            where pubname = 'supabase_realtime'
              and tablename in ('whatsapp_config', 'ai_configs', 'api_keys', 'webhook_endpoints',
                                'account_invitations', 'profiles', 'accounts')),
          null, 'no credential, invitation, profile or account table is published to Realtime');

-- every published table is RLS-protected, so Realtime filters INSERT/UPDATE per subscriber
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

-- ---- DELETE and TRUNCATE are never published (the cross-tenant DELETE exposure) ----------
select is((select pubdelete from pg_publication where pubname = 'supabase_realtime'), false,
          'the publication does not publish DELETE (Realtime never RLS-filters DELETE events)');
select is((select pubtruncate from pg_publication where pubname = 'supabase_realtime'), false,
          'the publication does not publish TRUNCATE');
select ok((select pubinsert and pubupdate from pg_publication where pubname = 'supabase_realtime'),
          'POSITIVE CONTROL: the publication still publishes INSERT and UPDATE');

-- no other publication could be streamed by Realtime with DELETE enabled
select is((select string_agg(pubname::text, ', ') from pg_publication
            where pubname <> 'supabase_realtime' and pubdelete),
          null, 'no other publication publishes DELETE');

-- ---- no Broadcast / Presence surface -------------------------------------------------------
select is((select count(*)::int from pg_policies where schemaname = 'realtime' and tablename = 'messages'),
          0, 'no realtime.messages policy exists (the app uses neither Broadcast nor Presence)');

-- ---- the deletion-signal table -------------------------------------------------------------
select tests.seed_world();

-- the trigger function is not callable by Data API roles
select ok(not has_function_privilege('anon', 'public.record_realtime_deletion()', 'EXECUTE')
      and not has_function_privilege('authenticated', 'public.record_realtime_deletion()', 'EXECUTE'),
          'the signal trigger function is not executable by anon or authenticated');

-- a deleted MESSAGE records one account-scoped signal holding identifiers only
create temp table t_msg as
  select m.id, m.conversation_id from public.messages m
   where m.conversation_id = tests.u('a_conv')::uuid limit 1;
delete from public.messages where id = (select id from t_msg);

select is((select count(*)::int from public.realtime_deletions
            where table_name = 'messages' and account_id = tests.u('a_acct')
              and old_row->>'id' = (select id::text from t_msg)),
          1, 'POSITIVE CONTROL: deleting a message records exactly one signal for its account');
select is((select (select array_agg(k order by k) from jsonb_object_keys(old_row) k)::text
             from public.realtime_deletions
            where table_name = 'messages' and old_row->>'id' = (select id::text from t_msg)),
          '{conversation_id,id}', 'the message signal holds identifiers only (no content, no sender, no text)');

-- visibility is per tenant: A's members see it, B and anon do not
select is(tests.probe_count(tests.u('a_owner'), format('select 1 from public.realtime_deletions where table_name = ''messages'' and old_row->>''id'' = %L', (select id from t_msg))), 'n=1',
          'POSITIVE CONTROL: a tenant A owner can read the signal');
select is(tests.probe_count(tests.u('a_viewer'), format('select 1 from public.realtime_deletions where table_name = ''messages'' and old_row->>''id'' = %L', (select id from t_msg))), 'n=1',
          'POSITIVE CONTROL: a tenant A viewer can read the signal');
select is(tests.probe_count(tests.u('b_owner'), format('select 1 from public.realtime_deletions where account_id = %L', tests.u('a_acct'))), 'n=0',
          'tenant B cannot read tenant A signals');
select is(tests.probe_count(null, 'select 1 from public.realtime_deletions'), 'n=0',
          'anon cannot read any signal (no table privilege)');

-- a deleted NOTIFICATION is signalled only to the notified user, not to the rest of the account
delete from public.notifications where account_id = tests.u('a_acct') and user_id = tests.u('a_owner')::uuid;
select is(tests.probe_count(tests.u('a_owner'), 'select 1 from public.realtime_deletions where table_name = ''notifications'''), 'n=1',
          'POSITIVE CONTROL: the notified user can read the notification-deletion signal');
select is(tests.probe_count(tests.u('a_viewer'), 'select 1 from public.realtime_deletions where table_name = ''notifications'''), 'n=0',
          'a teammate cannot read the signal of someone else''s deleted notification');
select is(tests.probe_count(tests.u('b_owner'), 'select 1 from public.realtime_deletions where table_name = ''notifications'''), 'n=0',
          'tenant B cannot read tenant A notification signals');

-- deleting a conversation records ONE conversation signal; its cascaded messages record none
-- (the parent is already gone when their trigger runs, and the conversation signal covers them)
create temp table t_conv as select id from public.conversations where id = tests.u('b_conv')::uuid;
select is((select count(*)::int from public.messages where conversation_id = (select id from t_conv)) > 0, true,
          'precondition: the conversation has messages');
delete from public.conversations where id = (select id from t_conv);
select is((select count(*)::int from public.realtime_deletions where table_name = 'conversations' and old_row->>'id' = (select id::text from t_conv)),
          1, 'deleting a conversation records one conversation signal');
select is((select count(*)::int from public.realtime_deletions where table_name = 'messages' and old_row->>'conversation_id' = (select id::text from t_conv)),
          0, 'cascaded message deletions record no stray signals');

-- the signal table cannot be written through the Data API
select is(tests.probe_dml(tests.u('a_owner'), format('insert into public.realtime_deletions (account_id, table_name) values (%L, ''messages'')', tests.u('a_acct'))),
          'err=42501', 'an owner cannot forge a deletion signal');
select is(tests.probe_dml(tests.u('a_owner'), 'delete from public.realtime_deletions'),
          'n=0', 'an owner cannot erase deletion signals');

select * from finish();
rollback;
