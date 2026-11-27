-- 111_member_rpcs_workspaces — F2-b2 (migration 069): the workspace-aware member RPCs
-- (set_member_role / remove_account_member / transfer_account_ownership with an explicit
-- account) and the old signatures that now delegate to them. Runs against the REAL
-- least-privilege grants. Every "cannot" check has a positive control next to it.
begin;
select * from no_plan();

select tests.guard();
select tests.seed_world();

-- a_agent additionally joins workspace B as an agent (a second membership; their
-- profile / default account stays A).
insert into public.account_memberships (account_id, user_id, role)
  values (tests.u('b_acct'), tests.u('a_agent'), 'agent');

-- ---- set_member_role -----------------------------------------------------------
select is(tests.probe_effect(tests.u('a_admin'),
  format('select public.set_member_role(%L, %L, ''viewer'')', tests.u('a_acct'), tests.u('a_agent')),
  format('select m.role::text || ''/'' || p.account_role::text from public.account_memberships m join public.profiles p on p.user_id = m.user_id where m.account_id = %L and m.user_id = %L', tests.u('a_acct'), tests.u('a_agent'))),
  'val=viewer/viewer', 'POSITIVE CONTROL: an admin changes a member''s role; membership and profile agree');
select is(tests.probe_effect(tests.u('b_owner'),
  format('select public.set_member_role(%L, %L, ''admin'')', tests.u('b_acct'), tests.u('a_agent')),
  format('select m.role::text || ''/'' || p.account_role::text from public.account_memberships m join public.profiles p on p.user_id = m.user_id where m.account_id = %L and m.user_id = %L', tests.u('b_acct'), tests.u('a_agent'))),
  'val=admin/agent', 'B''s owner manages a member who JOINED B: only the B membership changes, the default account role is untouched');
select is(tests.probe_effect(tests.u('a_admin'),
  format('select public.set_member_role(%L, ''viewer'')', tests.u('a_agent')),
  format('select m.role::text || ''/'' || p.account_role::text from public.account_memberships m join public.profiles p on p.user_id = m.user_id where m.account_id = %L and m.user_id = %L', tests.u('a_acct'), tests.u('a_agent'))),
  'val=viewer/viewer', 'the old one-account signature still works (default workspace)');
select ok(tests.probe_val(tests.u('b_owner'), format('public.set_member_role(%L, %L, ''viewer'')', tests.u('a_acct'), tests.u('a_agent'))) ~ '^err=', 'B''s owner cannot manage A''s members');
select ok(tests.probe_val(tests.u('a_admin'), format('public.set_member_role(%L, %L, ''viewer'')', tests.u('b_acct'), tests.u('a_agent'))) ~ '^err=', 'A''s admin cannot manage B (not a member of B)');
select ok(tests.probe_val(tests.u('a_agent'), format('public.set_member_role(%L, %L, ''agent'')', tests.u('a_acct'), tests.u('a_viewer'))) ~ '^err=', 'an agent cannot change roles');
select ok(tests.probe_val(tests.u('a_admin'), format('public.set_member_role(%L, %L, ''owner'')', tests.u('a_acct'), tests.u('a_agent'))) ~ '^err=', 'nobody is promoted to owner this way');
select ok(tests.probe_val(tests.u('a_admin'), format('public.set_member_role(%L, %L, ''viewer'')', tests.u('a_acct'), tests.u('a_owner'))) ~ '^err=', 'an admin cannot demote the owner');
select ok(tests.probe_val(tests.u('a_admin'), format('public.set_member_role(%L, %L, ''viewer'')', tests.u('a_acct'), tests.u('a_admin'))) ~ '^err=', 'nobody changes their own role');
select is(tests.probe_val(null, format('public.set_member_role(%L, %L, ''viewer'')', tests.u('a_acct'), tests.u('a_viewer'))), 'err=42501', 'anon cannot call set_member_role');

-- ---- remove_account_member -----------------------------------------------------
select is(tests.probe_effect(tests.u('b_owner'),
  format('select public.remove_account_member(%L, %L)', tests.u('b_acct'), tests.u('a_agent')),
  format('select (select count(*) from public.account_memberships where account_id = %L and user_id = %L)::text || ''/'' || (p.account_id = %L)::text from public.profiles p where p.user_id = %L', tests.u('b_acct'), tests.u('a_agent'), tests.u('a_acct'), tests.u('a_agent'))),
  'val=0/true', 'POSITIVE CONTROL: removing a JOINED member deletes only the B membership; their own account and default workspace stay');
select is(tests.probe_effect(tests.u('a_admin'),
  format('select public.remove_account_member(%L, %L)', tests.u('a_acct'), tests.u('a_viewer')),
  format('select (p.account_id <> %L)::text || ''/'' || p.account_role::text || ''/'' || (select count(*) from public.account_memberships where account_id = %L and user_id = %L)::text from public.profiles p where p.user_id = %L', tests.u('a_acct'), tests.u('a_acct'), tests.u('a_viewer'), tests.u('a_viewer'))),
  'val=true/owner/0', 'removing a default-workspace member gives them their own account back as owner');
select is(tests.probe_effect(tests.u('a_admin'),
  format('select public.remove_account_member(%L)', tests.u('a_viewer')),
  format('select (p.account_id <> %L)::text || ''/'' || p.account_role::text from public.profiles p where p.user_id = %L', tests.u('a_acct'), tests.u('a_viewer'))),
  'val=true/owner', 'the old one-argument signature still works');
select ok(tests.probe_val(tests.u('b_owner'), format('public.remove_account_member(%L, %L)', tests.u('a_acct'), tests.u('a_viewer'))) ~ '^err=', 'B''s owner cannot remove A''s members');
select ok(tests.probe_val(tests.u('a_agent'), format('public.remove_account_member(%L, %L)', tests.u('a_acct'), tests.u('a_viewer'))) ~ '^err=', 'an agent cannot remove members');
select ok(tests.probe_val(tests.u('a_admin'), format('public.remove_account_member(%L, %L)', tests.u('a_acct'), tests.u('a_owner'))) ~ '^err=', 'the owner cannot be removed');
select ok(tests.probe_val(tests.u('a_admin'), format('public.remove_account_member(%L, %L)', tests.u('a_acct'), tests.u('a_admin'))) ~ '^err=', 'nobody removes themselves');
select is(tests.probe_val(null, format('public.remove_account_member(%L, %L)', tests.u('a_acct'), tests.u('a_viewer'))), 'err=42501', 'anon cannot call remove_account_member');

-- ---- transfer_account_ownership --------------------------------------------------
select is(tests.probe_effect(tests.u('a_owner'),
  format('select public.transfer_account_ownership(%L, %L)', tests.u('a_acct'), tests.u('a_admin')),
  format('select (select role::text from public.account_memberships where account_id = %1$L and user_id = %2$L) || ''/'' || (select role::text from public.account_memberships where account_id = %1$L and user_id = %3$L) || ''/'' || (select (owner_user_id = %2$L)::text from public.accounts where id = %1$L)', tests.u('a_acct'), tests.u('a_admin'), tests.u('a_owner'))),
  'val=owner/admin/true', 'POSITIVE CONTROL: the owner hands the account to a member; roles and owner_user_id swap');
select is(tests.probe_effect(tests.u('a_owner'),
  format('select public.transfer_account_ownership(%L)', tests.u('a_admin')),
  format('select (owner_user_id = %L)::text from public.accounts where id = %L', tests.u('a_admin'), tests.u('a_acct'))),
  'val=true', 'the old one-argument signature still works');
select ok(tests.probe_val(tests.u('a_admin'), format('public.transfer_account_ownership(%L, %L)', tests.u('a_acct'), tests.u('a_agent'))) ~ '^err=', 'an admin cannot transfer ownership');
select ok(tests.probe_val(tests.u('a_owner'), format('public.transfer_account_ownership(%L, %L)', tests.u('a_acct'), tests.u('b_owner'))) ~ '^err=', 'the target must be a member of the account');
insert into public.account_memberships (account_id, user_id, role) values (tests.u('a_acct'), tests.u('b_owner'), 'admin');
select is(tests.probe_val(tests.u('a_owner'), format('public.transfer_account_ownership(%L, %L)', tests.u('a_acct'), tests.u('b_owner'))),
  'err=23505', 'a user who already owns another account cannot be made owner of a second one (until F2-d)');
delete from public.account_memberships where account_id = tests.u('a_acct') and user_id = tests.u('b_owner');
select is(tests.probe_val(tests.u('b_owner'), format('public.transfer_account_ownership(%L, %L)', tests.u('a_acct'), tests.u('a_admin'))) ~ '^err=', true, 'a foreign owner cannot transfer A');
select is(tests.probe_val(null, format('public.transfer_account_ownership(%L, %L)', tests.u('a_acct'), tests.u('a_admin'))), 'err=42501', 'anon cannot call transfer_account_ownership');

-- an unknown user id keeps the pre-069 contract (22023 -> HTTP 400), not a 403
select is(tests.probe_val(tests.u('a_admin'), format('public.remove_account_member(%L, %L)', tests.u('a_acct'), '00000000-0000-4000-8000-000000000000')), 'err=22023', 'removing an unknown user id is 22023, not 42501');
select is(tests.probe_val(tests.u('a_admin'), format('public.set_member_role(%L, %L, ''viewer'')', tests.u('a_acct'), '00000000-0000-4000-8000-000000000000')), 'err=22023', 'changing the role of an unknown user id is 22023');
select is(tests.probe_val(tests.u('a_owner'), format('public.transfer_account_ownership(%L, %L)', tests.u('a_acct'), '00000000-0000-4000-8000-000000000000')), 'err=22023', 'transferring to an unknown user id is 22023');

select * from finish();
rollback;
