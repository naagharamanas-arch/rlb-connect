-- 040_rpc_authorization — every function a logged-in (or anonymous) client can
-- call. Each is exercised as: the owning tenant (positive control), a foreign
-- tenant, a lower-privileged member, and anon. Effects are inspected as
-- superuser (probe_effect) and rolled back.
begin;
select * from no_plan();

select tests.guard();
select tests.seed_world();
select tests.emulate_legacy_data_api_grants();

select set_config('tests.c_user', tests.new_user('c-fresh@test.invalid')::text, true);   -- empty personal account
select set_config('tests.empty_embedding', '[' || (select string_agg('0.01', ',') from generate_series(1, 1536)) || ']', true);
update public.ai_knowledge_chunks set embedding = current_setting('tests.empty_embedding')::vector where account_id = tests.u('a_acct');
update public.ai_knowledge_chunks set embedding = current_setting('tests.empty_embedding')::vector where account_id = tests.u('b_acct');

-- ===== is_account_member ======================================================
select is(tests.probe_val(tests.u('a_viewer'), format('public.is_account_member(%L, ''viewer'')', tests.u('a_acct'))), 'val=true',  'POSITIVE CONTROL: a viewer is a viewer-member of their account');
select is(tests.probe_val(tests.u('a_viewer'), format('public.is_account_member(%L, ''agent'')',  tests.u('a_acct'))), 'val=false', 'a viewer is not an agent-member');
select is(tests.probe_val(tests.u('b_owner'),  format('public.is_account_member(%L, ''viewer'')', tests.u('a_acct'))), 'val=false', 'a foreign tenant is not a member');
select is(tests.probe_val(null,                format('public.is_account_member(%L, ''viewer'')', tests.u('a_acct'))), 'val=false', 'anon is not a member');

-- ===== set_member_role ========================================================
select is(tests.probe_effect(tests.u('a_admin'), format('select public.set_member_role(%L, ''agent'')', tests.u('a_viewer')),
          format('select account_role::text from public.profiles where user_id = %L', tests.u('a_viewer'))),
          'val=agent', 'POSITIVE CONTROL: an admin can change a viewer to agent');
select is(tests.probe_effect(tests.u('a_owner'), format('select public.set_member_role(%L, ''admin'')', tests.u('a_agent')),
          format('select account_role::text from public.profiles where user_id = %L', tests.u('a_agent'))),
          'val=admin', 'POSITIVE CONTROL: the owner can change an agent to admin');
select ok(tests.probe_val(tests.u('b_owner'), format('public.set_member_role(%L, ''viewer'')', tests.u('a_agent'))) ~ '^err=', 'a foreign tenant''s owner cannot change A''s member role');
select ok(tests.probe_val(tests.u('b_owner'), format('public.set_member_role(%L, ''owner'')', tests.u('a_agent'))) ~ '^err=', 'a foreign tenant''s owner cannot promote A''s member');
select ok(tests.probe_val(tests.u('a_agent'),  format('public.set_member_role(%L, ''agent'')', tests.u('a_viewer'))) ~ '^err=', 'an agent cannot change roles');
select ok(tests.probe_val(tests.u('a_viewer'), format('public.set_member_role(%L, ''admin'')', tests.u('a_viewer'))) ~ '^err=', 'a viewer cannot promote themselves');
select ok(tests.probe_val(tests.u('a_admin'),  format('public.set_member_role(%L, ''owner'')', tests.u('a_agent'))) ~ '^err=', 'an admin cannot make anyone owner');
select ok(tests.probe_val(tests.u('a_admin'),  format('public.set_member_role(%L, ''viewer'')', tests.u('a_owner'))) ~ '^err=', 'an admin cannot demote the owner');
select ok(tests.probe_val(tests.u('a_admin'),  format('public.set_member_role(%L, ''owner'')', tests.u('a_admin'))) ~ '^err=', 'an admin cannot change their own role');
select is(tests.probe_val(null, format('public.set_member_role(%L, ''viewer'')', tests.u('a_viewer'))), 'err=42501', 'anon cannot execute set_member_role');

-- ===== remove_account_member ==================================================
select isnt(tests.probe_effect(tests.u('a_admin'), format('select public.remove_account_member(%L)', tests.u('a_viewer')),
          format('select (account_id = %L)::text from public.profiles where user_id = %L', tests.u('a_acct'), tests.u('a_viewer'))),
          'val=true', 'POSITIVE CONTROL: an admin can remove a viewer (they leave account A)');
select is(tests.probe_effect(tests.u('a_admin'), format('select public.remove_account_member(%L)', tests.u('a_viewer')),
          format('select (account_id = %L)::text from public.profiles where user_id = %L', tests.u('a_acct'), tests.u('a_viewer'))),
          'val=false', 'the removed member no longer belongs to account A');
select ok(tests.probe_val(tests.u('b_owner'), format('public.remove_account_member(%L)', tests.u('a_viewer'))) ~ '^err=', 'a foreign tenant''s owner cannot remove A''s member');
select ok(tests.probe_val(tests.u('a_agent'), format('public.remove_account_member(%L)', tests.u('a_viewer'))) ~ '^err=', 'an agent cannot remove members');
select ok(tests.probe_val(tests.u('a_admin'), format('public.remove_account_member(%L)', tests.u('a_owner'))) ~ '^err=', 'nobody can remove the owner');
select ok(tests.probe_val(tests.u('a_admin'), format('public.remove_account_member(%L)', tests.u('a_admin'))) ~ '^err=', 'a member cannot remove themselves this way');
select is(tests.probe_val(null, format('public.remove_account_member(%L)', tests.u('a_viewer'))), 'err=42501', 'anon cannot execute remove_account_member');

-- ===== transfer_account_ownership =============================================
select is(tests.probe_effect(tests.u('a_owner'), format('select public.transfer_account_ownership(%L)', tests.u('a_admin')),
          format('select (select account_role::text from public.profiles where user_id = %L) || ''/'' || (select account_role::text from public.profiles where user_id = %L)',
                 tests.u('a_admin'), tests.u('a_owner'))),
          'val=owner/admin', 'POSITIVE CONTROL: the owner can hand ownership to a member (roles swap)');
select ok(tests.probe_val(tests.u('a_admin'), format('public.transfer_account_ownership(%L)', tests.u('a_agent'))) ~ '^err=', 'an admin cannot transfer ownership');
select ok(tests.probe_val(tests.u('a_agent'), format('public.transfer_account_ownership(%L)', tests.u('a_agent'))) ~ '^err=', 'an agent cannot transfer ownership');
select ok(tests.probe_val(tests.u('a_owner'), format('public.transfer_account_ownership(%L)', tests.u('b_owner'))) ~ '^err=', 'the owner cannot hand ownership to a user of ANOTHER account');
select ok(tests.probe_val(tests.u('b_owner'), format('public.transfer_account_ownership(%L)', tests.u('a_admin'))) ~ '^err=', 'a foreign tenant''s owner cannot take over A');
select is(tests.probe_val(null, format('public.transfer_account_ownership(%L)', tests.u('a_admin'))), 'err=42501', 'anon cannot execute transfer_account_ownership');

-- ===== invitations ============================================================
-- peek: capability by design; must expose ONLY name / role / expiry.
select is(tests.probe_val(null, 'public.peek_invitation(''inv-hash-a'')::jsonb->>''ok'''), 'val=true', 'peek_invitation works for anon with a valid token hash (by design)');
select is(tests.probe_val(null, '(select string_agg(k, '','' order by k) from jsonb_object_keys(public.peek_invitation(''inv-hash-a'')::jsonb) k)'),
          'val=account_name,expires_at,ok,role', 'peek_invitation reveals nothing but account name, role and expiry (no ids)');
select is(tests.probe_val(null, 'public.peek_invitation(''no-such-hash'')::jsonb->>''reason'''), 'val=not_found', 'peek_invitation on an unknown token reveals nothing');

-- redeem
select is(tests.probe_effect(tests.u('c_user'), 'select public.redeem_invitation(''inv-hash-a'')',
          format('select (account_id = %L)::text || ''/'' || account_role::text from public.profiles where user_id = %L', tests.u('a_acct'), tests.u('c_user'))),
          'val=true/agent', 'POSITIVE CONTROL: a fresh user redeems a valid invitation and joins ONLY the inviting account, with exactly the invited role');
select ok(tests.probe_val(tests.u('b_owner'), 'public.redeem_invitation(''inv-hash-a'')') ~ '^err=', 'a user who already has data cannot be pulled into A (their data stays put)');
select ok(tests.probe_val(tests.u('c_user'), 'public.redeem_invitation(''no-such-hash'')') ~ '^err=', 'redeeming an unknown token fails');
select is(tests.probe_val(null, 'public.redeem_invitation(''inv-hash-a'')'), 'err=42501', 'anon cannot execute redeem_invitation');

insert into public.account_invitations (account_id, token_hash, role, expires_at, created_by_user_id)
  values (tests.u('a_acct'), 'inv-expired', 'agent', now() - interval '1 day', tests.u('a_owner'));
insert into public.account_invitations (account_id, token_hash, role, expires_at, accepted_at, created_by_user_id)
  values (tests.u('a_acct'), 'inv-used', 'agent', now() + interval '1 day', now(), tests.u('a_owner'));
select ok(tests.probe_val(tests.u('c_user'), 'public.redeem_invitation(''inv-expired'')') ~ '^err=', 'an expired invitation cannot be redeemed');
select ok(tests.probe_val(tests.u('c_user'), 'public.redeem_invitation(''inv-used'')') ~ '^err=', 'an already-used invitation cannot be redeemed');
select is(tests.probe_val(null, 'public.peek_invitation(''inv-expired'')::jsonb->>''reason'''), 'val=expired', 'peek reports an expired invitation without details');

-- ===== dashboard_overview =====================================================
-- A has 4 members, B has 1: setup.memberCount tells us whose data came back.
select is(tests.probe_val(tests.u('a_owner'), 'public.dashboard_overview(7, ''UTC'')::jsonb->''setup''->>''memberCount'''), 'val=4', 'POSITIVE CONTROL: A''s dashboard reports A''s four members');
select is(tests.probe_val(tests.u('a_viewer'), 'public.dashboard_overview(7, ''UTC'')::jsonb->''setup''->>''memberCount'''), 'val=4', 'a viewer sees their own account''s dashboard');
select is(tests.probe_val(tests.u('b_owner'), 'public.dashboard_overview(7, ''UTC'')::jsonb->''setup''->>''memberCount'''), 'val=1', 'B''s dashboard reports B''s data only');
select is(tests.probe_val(null, 'public.dashboard_overview(7, ''UTC'')'), 'err=42501', 'anon cannot execute dashboard_overview');

-- ===== flows: replace_flow_nodes / replace_flow_graph ============================
select ok(tests.probe_val(tests.u('a_agent'), format('public.replace_flow_nodes(%L, ''[]''::jsonb)', tests.u('a_flow'))) ~ '^val=', 'POSITIVE CONTROL: an agent can replace nodes of their flow');
select is(tests.probe_val(tests.u('a_viewer'), format('public.replace_flow_nodes(%L, ''[]''::jsonb)', tests.u('a_flow'))), 'err=42501', 'a viewer cannot replace flow nodes');
select is(tests.probe_val(tests.u('b_owner'),  format('public.replace_flow_nodes(%L, ''[]''::jsonb)', tests.u('a_flow'))), 'err=42501', 'a foreign tenant cannot replace A''s flow nodes');
select is(tests.probe_val(null,                format('public.replace_flow_nodes(%L, ''[]''::jsonb)', tests.u('a_flow'))), 'err=42501', 'anon cannot replace flow nodes');
select ok(tests.probe_val(tests.u('a_agent'), format('public.replace_flow_graph(%L, ''[]''::jsonb, ''{"name":"x"}''::jsonb)', tests.u('a_flow'))) ~ '^val=', 'POSITIVE CONTROL: an agent can replace their flow graph');
select is(tests.probe_val(tests.u('a_viewer'), format('public.replace_flow_graph(%L, ''[]''::jsonb, ''{"name":"x"}''::jsonb)', tests.u('a_flow'))), 'err=42501', 'a viewer cannot replace a flow graph');
select is(tests.probe_val(tests.u('b_owner'),  format('public.replace_flow_graph(%L, ''[]''::jsonb, ''{"name":"hacked"}''::jsonb)', tests.u('a_flow'))), 'err=42501', 'a foreign tenant cannot rewrite A''s flow');
select is(tests.probe_effect(tests.u('b_owner'), format('select public.replace_flow_graph(%L, ''[]''::jsonb, ''{"name":"hacked"}''::jsonb)', tests.u('a_flow')),
          format('select name from public.flows where id = %L', tests.u('a_flow'))),
          'err=42501', 'and the attempt changes nothing (the call itself is rejected)');

-- ===== broadcast delivery leases ================================================
select ok(tests.probe_val(tests.u('a_agent'), format('public.acquire_broadcast_delivery_lease(%L)', tests.u('a_bcast'))) ~ '^val=20', 'POSITIVE CONTROL: an agent can acquire the delivery lease of their broadcast');
select is(tests.probe_val(tests.u('a_viewer'), format('public.acquire_broadcast_delivery_lease(%L)', tests.u('a_bcast'))), 'val=<null>', 'a viewer cannot acquire a delivery lease');
select is(tests.probe_val(tests.u('b_owner'),  format('public.acquire_broadcast_delivery_lease(%L)', tests.u('a_bcast'))), 'val=<null>', 'a foreign tenant cannot acquire A''s delivery lease');
select is(tests.probe_val(null,                format('public.acquire_broadcast_delivery_lease(%L)', tests.u('a_bcast'))), 'err=42501', 'anon cannot execute acquire_broadcast_delivery_lease');

update public.broadcasts set delivery_lease_until = now() + interval '5 minutes' where id = tests.u('a_bcast');
select set_config('tests.a_lease', (select delivery_lease_until::text from public.broadcasts where id = tests.u('a_bcast')), true);
select ok(tests.probe_val(tests.u('a_agent'), format('public.renew_broadcast_delivery_lease(%L, %L::timestamptz)', tests.u('a_bcast'), current_setting('tests.a_lease'))) ~ '^val=20', 'POSITIVE CONTROL: an agent can renew the held lease');
select is(tests.probe_val(tests.u('a_viewer'), format('public.renew_broadcast_delivery_lease(%L, %L::timestamptz)', tests.u('a_bcast'), current_setting('tests.a_lease'))), 'val=<null>', 'a viewer cannot renew a lease');
select is(tests.probe_val(tests.u('b_owner'),  format('public.renew_broadcast_delivery_lease(%L, %L::timestamptz)', tests.u('a_bcast'), current_setting('tests.a_lease'))), 'val=<null>', 'a foreign tenant cannot renew A''s lease');
select is(tests.probe_val(tests.u('a_agent'),  format('public.broadcast_delivery_in_flight(%L)', tests.u('a_bcast'))), 'val=true',  'POSITIVE CONTROL: A sees its broadcast in flight');
select is(tests.probe_val(tests.u('b_owner'),  format('public.broadcast_delivery_in_flight(%L)', tests.u('a_bcast'))), 'val=false', 'B cannot see that A''s broadcast is in flight (RLS applies)');

-- ===== SECURITY INVOKER search helpers: RLS must apply =============================
select ok(tests.probe_count(tests.u('a_owner'), format('select * from public.filter_contacts_by_tags(array[%L]::uuid[], null, 25, 0)', tests.u('a_tag'))) ~ '^n=[1-9]', 'POSITIVE CONTROL: A finds its contact by its tag');
select is(tests.probe_count(tests.u('b_owner'), format('select * from public.filter_contacts_by_tags(array[%L]::uuid[], null, 25, 0)', tests.u('a_tag'))), 'n=0', 'B cannot find A''s contacts through filter_contacts_by_tags');
select is(tests.probe_count(null,               format('select * from public.filter_contacts_by_tags(array[%L]::uuid[], null, 25, 0)', tests.u('a_tag'))), 'err=42501', 'anon cannot call filter_contacts_by_tags');

select ok(tests.probe_count(tests.u('a_owner'), format('select * from public.match_ai_knowledge_fts(%L, ''zebra'', 5)', tests.u('a_acct'))) ~ '^n=[1-9]', 'POSITIVE CONTROL: A finds its knowledge by full-text search');
select is(tests.probe_count(tests.u('b_owner'), format('select * from public.match_ai_knowledge_fts(%L, ''zebra'', 5)', tests.u('a_acct'))), 'n=0', 'B cannot search A''s knowledge base (full text)');
select ok(tests.probe_count(tests.u('b_owner'), format('select * from public.match_ai_knowledge_fts(%L, ''zebra'', 5)', tests.u('b_acct'))) ~ '^n=[1-9]', 'POSITIVE CONTROL: B finds its own knowledge by full-text search');
select ok(tests.probe_count(tests.u('a_owner'), format('select * from public.match_ai_knowledge_semantic(%L, %L, 5)', tests.u('a_acct'), current_setting('tests.empty_embedding'))) ~ '^n=[1-9]', 'POSITIVE CONTROL: A finds its knowledge by semantic search');
select is(tests.probe_count(tests.u('b_owner'), format('select * from public.match_ai_knowledge_semantic(%L, %L, 5)', tests.u('a_acct'), current_setting('tests.empty_embedding'))), 'n=0', 'B cannot search A''s knowledge base (semantic)');
select is(tests.probe_count(null, format('select * from public.match_ai_knowledge_fts(%L, ''zebra'', 5)', tests.u('a_acct'))), 'err=42501', 'anon cannot call match_ai_knowledge_fts');

-- ===== presence ====================================================================
select is(tests.probe_effect(tests.u('b_owner'), 'select public.touch_presence(''away'')',
          format('select (select status from public.member_presence where account_id = %L) || ''/'' || (select status from public.member_presence where account_id = %L)',
                 tests.u('a_acct'), tests.u('b_acct'))),
          'val=online/away', 'touch_presence changes only the caller''s presence, never another tenant''s');
select is(tests.probe_val(null, 'public.touch_presence(''away'')'), 'err=42501', 'anon cannot touch presence');

-- ===== trigger functions and service-only functions cannot be driven by clients ========
select ok(tests.probe_val(tests.u('b_owner'), 'public.handle_new_user()') ~ '^err=', 'handle_new_user cannot be invoked directly (authenticated)');
select ok(tests.probe_val(null,               'public.handle_new_user()') ~ '^err=', 'handle_new_user cannot be invoked directly (anon)');
select is(tests.probe_val(tests.u('b_owner'), 'public.merge_duplicate_contacts()'),      'err=42501', 'merge_duplicate_contacts is service-only');
select is(tests.probe_val(tests.u('b_owner'), 'public.merge_duplicate_conversations()'), 'err=42501', 'merge_duplicate_conversations is service-only');
select is(tests.probe_val(tests.u('b_owner'), format('public.recompute_broadcast_counts(%L)', tests.u('a_bcast'))), 'err=42501', 'recompute_broadcast_counts is service-only');
select is(tests.probe_val(tests.u('b_owner'), format('public.increment_flow_execution_count(%L)', tests.u('a_flow'))), 'err=42501', 'increment_flow_execution_count is service-only');
select is(tests.probe_val(tests.u('a_owner'), format('public.claim_ai_reply_slot(%L, 5)', tests.u('a_conv'))), 'err=42501', 'claim_ai_reply_slot is service-only (even for the owning tenant)');
select is(tests.probe_val(tests.u('a_owner'), format('public.record_webhook_failure(%L, 5)', tests.u('a_acct'))), 'err=42501', 'record_webhook_failure is service-only');

select * from finish();
rollback;
