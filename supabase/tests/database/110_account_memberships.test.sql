-- 110_account_memberships — F2-a (migration 067): the membership table, role order,
-- dual-write from profiles, the two access helpers, and the first multi-workspace
-- behaviour. Runs against the REAL least-privilege grants (it never calls
-- tests.emulate_legacy_data_api_grants()).
--
-- Every "cannot" check is paired with a positive control so a broken harness
-- cannot produce a vacuous pass.
begin;
select * from no_plan();

select tests.guard();
select tests.seed_world();

-- Extra principals: a manager in tenant A, and a third tenant C with data.
create temp table w on commit drop as
select tests.new_user('a-manager@test.invalid') as mgr,
       tests.new_user('c-owner@test.invalid')   as c_owner;
alter table w add column c_acct uuid;
update w set c_acct = (select account_id from public.profiles where user_id = w.c_owner);
select tests.seed_tenant('c', (select c_owner from w), (select c_acct from w));
select tests.set_member((select mgr from w), tests.u('a_acct'), 'manager');

-- ---- 1. backfill / dual-write parity -----------------------------------------
select is(
  (select count(*)::int from public.profiles p
    where p.account_id is not null
      and not exists (select 1 from public.account_memberships m
                       where m.user_id = p.user_id and m.account_id = p.account_id and m.role = p.account_role)),
  0, 'every profile has a matching membership');
select is(
  (select count(*)::int from public.account_memberships),
  (select count(*)::int from public.profiles where account_id is not null),
  'memberships are 1:1 with profiles while profiles remain the write path (F2-a)');

-- ---- 2. role order ----------------------------------------------------------------
select is(
  (select array_agg(r::text order by public.account_role_rank(r)) from unnest(enum_range(null::public.account_role_enum)) r),
  array['viewer','agent','manager','admin','owner'],
  'role order is viewer < agent < manager < admin < owner');
select is(
  (select array_agg(public.account_role_rank(r) order by public.account_role_rank(r)) from unnest(enum_range(null::public.account_role_enum)) r),
  array[1,2,3,4,5], 'ranks are 1..5, one per role');

-- ---- 3. dual-write follows profile changes ------------------------------------
select is(
  (select role::text from public.account_memberships where user_id = (select mgr from w) and account_id = tests.u('a_acct')),
  'manager', 'set_member(manager) is mirrored into memberships');
select tests.set_member((select mgr from w), tests.u('a_acct'), 'agent');
select is(
  (select role::text from public.account_memberships where user_id = (select mgr from w) and account_id = tests.u('a_acct')),
  'agent', 'a role change on the profile updates the membership');
select tests.set_member((select mgr from w), tests.u('b_acct'), 'viewer');
select is(
  (select count(*)::int from public.account_memberships where user_id = (select mgr from w)),
  1, 'moving to another account leaves exactly one membership');
select is(
  (select account_id from public.account_memberships where user_id = (select mgr from w)),
  tests.u('b_acct'), 'the membership follows the profile to the new account');
select tests.set_member((select mgr from w), tests.u('a_acct'), 'manager');   -- restore for later checks

-- ---- 4. both helpers equal the old profiles-based answer, for everyone ---------
create temp table mismatch (uid uuid, acct uuid, min_role text) on commit drop;
do $$
declare r record; v_expected boolean;
begin
  for r in
    select p.user_id as uid, a.id as acct, m as minr
      from public.profiles p cross join public.accounts a
      cross join unnest(enum_range(null::public.account_role_enum)) m
  loop
    perform set_config('request.jwt.claim.sub', r.uid::text, true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', r.uid::text, 'role', 'authenticated')::text, true);
    v_expected := exists (
      select 1 from public.profiles q
       where q.user_id = r.uid and q.account_id = r.acct
         and public.account_role_rank(q.account_role) >= public.account_role_rank(r.minr));
    if public.is_account_member(r.acct, r.minr) is distinct from v_expected
       or public.has_account_access(r.acct, r.minr) is distinct from v_expected then
      insert into mismatch values (r.uid, r.acct, r.minr::text);
    end if;
  end loop;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;
select is((select count(*)::int from mismatch), 0,
  'is_account_member and has_account_access both equal the profiles-based answer (every user x account x min_role)');
select is(tests.probe_val(tests.u('a_owner'), format('public.has_account_access(%L, %L)', tests.u('a_acct'), 'owner')),
  'val=true', 'positive control: the owner has owner-level access to their own account');

-- ---- 5. manager sits between admin and agent ----------------------------------
select is(tests.probe_val((select mgr from w), format('public.is_account_member(%L, %L)', tests.u('a_acct'), 'agent')),   'val=true',  'manager passes an agent-level check');
select is(tests.probe_val((select mgr from w), format('public.is_account_member(%L, %L)', tests.u('a_acct'), 'manager')), 'val=true',  'manager passes a manager-level check');
select is(tests.probe_val((select mgr from w), format('public.is_account_member(%L, %L)', tests.u('a_acct'), 'admin')),   'val=false', 'manager fails an admin-level check');
select is(tests.probe_val(tests.u('a_agent'), format('public.is_account_member(%L, %L)', tests.u('a_acct'), 'manager')),  'val=false', 'agent fails a manager-level check');
select is(tests.probe_val(tests.u('a_admin'), format('public.is_account_member(%L, %L)', tests.u('a_acct'), 'manager')),  'val=true',  'admin passes a manager-level check');
select ok(tests.probe_dml((select mgr from w), format('update public.contacts set name = name where account_id = %L', tests.u('a_acct'))) ~ '^n=[1-9]',
  'manager can update contacts (agent-level policy)');
select is(tests.probe_dml((select mgr from w), format('update public.tags set name = name where account_id = %L', tests.u('a_acct'))),
  'n=0', 'manager cannot update tags (admin-level policy) until a policy grants it');

-- ---- 6. exposure ------------------------------------------------------------------
select is(tests.probe_val(null, format('public.has_account_access(%L)', tests.u('a_acct'))),
  'err=42501', 'anon cannot execute has_account_access');
select is((select has_function_privilege('authenticated', 'public.account_role_rank(public.account_role_enum)', 'EXECUTE')),
  false, 'account_role_rank is not exposed to authenticated');

-- ---- 7. the table itself -------------------------------------------------------------
select ok(tests.probe_count(tests.u('a_viewer'), format('select 1 from public.account_memberships where account_id = %L', tests.u('a_acct'))) ~ '^n=[1-9]',
  'a viewer can list their account''s memberships');
select is(tests.probe_count(tests.u('b_owner'), format('select 1 from public.account_memberships where account_id = %L', tests.u('a_acct'))),
  'n=0', 'another tenant cannot list them');
select is(tests.probe_dml(tests.u('a_owner'), format('insert into public.account_memberships (account_id, user_id, role) values (%L, %L, ''agent'')', tests.u('a_acct'), (select c_owner from w))),
  'err=42501', 'even an owner cannot insert memberships directly');
select is(tests.probe_dml(tests.u('a_owner'), format('update public.account_memberships set role = ''viewer'' where account_id = %L', tests.u('a_acct'))),
  'n=0', 'even an owner cannot update memberships directly');
select is(tests.probe_dml(tests.u('a_owner'), format('delete from public.account_memberships where account_id = %L', tests.u('a_acct'))),
  'n=0', 'even an owner cannot delete memberships directly');

-- ---- 8. multi-workspace: access follows memberships, per workspace -------------
insert into public.account_memberships (account_id, user_id, role) values (tests.u('b_acct'), tests.u('a_agent'), 'agent');
select ok(tests.probe_count(tests.u('a_agent'), format('select 1 from public.contacts where account_id = %L', tests.u('b_acct'))) ~ '^n=[1-9]',
  'a second membership grants access to workspace B');
select ok(tests.probe_count(tests.u('a_agent'), format('select 1 from public.contacts where account_id = %L', tests.u('a_acct'))) ~ '^n=[1-9]',
  'access to the first workspace is unchanged');
select is(tests.probe_count(tests.u('a_agent'), format('select 1 from public.contacts where account_id = %L', (select c_acct from w))),
  'n=0', 'no access to a workspace with no membership (C)');
select ok(tests.probe_count((select c_owner from w), format('select 1 from public.contacts where account_id = %L', (select c_acct from w))) ~ '^n=[1-9]',
  'positive control: C''s owner sees C''s contacts');
select is(tests.probe_dml(tests.u('a_agent'), format('update public.tags set name = name where account_id = %L', tests.u('b_acct'))),
  'n=0', 'the role is per workspace: an agent in B cannot do admin-level writes there');
update public.account_memberships set status = 'suspended' where account_id = tests.u('b_acct') and user_id = tests.u('a_agent');
select is(tests.probe_count(tests.u('a_agent'), format('select 1 from public.contacts where account_id = %L', tests.u('b_acct'))),
  'n=0', 'a suspended membership loses access at once');
update public.account_memberships set status = 'active' where account_id = tests.u('b_acct') and user_id = tests.u('a_agent');
delete from public.account_memberships where account_id = tests.u('b_acct') and user_id = tests.u('a_agent');
select is(tests.probe_count(tests.u('a_agent'), format('select 1 from public.contacts where account_id = %L', tests.u('b_acct'))),
  'n=0', 'a removed membership loses access at once');
select ok(tests.probe_count(tests.u('a_agent'), format('select 1 from public.contacts where account_id = %L', tests.u('a_acct'))) ~ '^n=[1-9]',
  'the other workspace is unaffected by the removal');

select * from finish();
rollback;
