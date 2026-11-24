-- 030_role_matrix — same-tenant role behaviour (viewer < agent < admin < owner)
-- for every table and operation, against the minimum roles recorded in
-- tests.role_expect (read from the policies as they stand today). This is a
-- characterisation of CURRENT behaviour; a deliberate policy change must
-- update tests.role_expect in the same PR.
--
-- Credential-bearing tables: row access is tested here like any other table;
-- the secret COLUMNS are asserted unreadable in 060 / 080.
--
-- allowed  => SELECT/UPDATE see >= 1 row; DELETE removes >= 1 row (or is stopped only by a
--             foreign key, 23503); INSERT is NOT stopped by RLS
--             (any non-42501 outcome, e.g. a duplicate-key error, counts as "got
--             past RLS")
-- denied   => SELECT/UPDATE/DELETE see 0 rows;    INSERT fails with exactly 42501
begin;
select * from no_plan();

select tests.guard();
select tests.seed_world();
select tests.emulate_legacy_data_api_grants();

create temp table roles (name text, rank int, uid uuid);
insert into roles values
  ('viewer', 1, tests.u('a_viewer')), ('agent', 2, tests.u('a_agent')),
  ('admin',  3, tests.u('a_admin')),  ('owner', 4, tests.u('a_owner'));

create temp table exp as
  select r.tbl, r.op, r.min_rank, ro.name as role, ro.uid, ro.rank,
         (r.min_rank is not null and ro.rank >= r.min_rank) as allowed
  from tests.role_expect r cross join roles ro
  where r.gap is null;

-- SELECT
select
  case when e.allowed
    then ok(tests.probe_count(e.uid, format('select 1 from public.%I where %s', e.tbl, tests.pred(e.tbl, tests.u('a_acct')))) ~ '^n=[1-9]',
            format('%s CAN SELECT in %s', e.role, e.tbl))
    else is(tests.probe_count(e.uid, format('select 1 from public.%I where %s', e.tbl, tests.pred(e.tbl, tests.u('a_acct')))),
            'n=0', format('%s cannot SELECT in %s', e.role, e.tbl))
  end
from exp e where e.op = 'SELECT' order by e.tbl, e.rank;

-- UPDATE
select
  case when e.allowed
    then ok(tests.probe_dml(e.uid, format('update public.%I set %I = %I where %s', e.tbl, tests.touch_col(e.tbl), tests.touch_col(e.tbl), tests.pred(e.tbl, tests.u('a_acct')))) ~ '^n=[1-9]',
            format('%s CAN UPDATE in %s', e.role, e.tbl))
    else is(tests.probe_dml(e.uid, format('update public.%I set %I = %I where %s', e.tbl, tests.touch_col(e.tbl), tests.touch_col(e.tbl), tests.pred(e.tbl, tests.u('a_acct')))),
            'n=0', format('%s cannot UPDATE in %s', e.role, e.tbl))
  end
from exp e where e.op = 'UPDATE' order by e.tbl, e.rank;

-- DELETE
select
  case when e.allowed
    then ok(tests.probe_dml(e.uid, format('delete from public.%I where %s', e.tbl, tests.pred(e.tbl, tests.u('a_acct')))) ~ '^(n=[1-9]|err=23503)$',
            format('%s CAN DELETE in %s (a foreign-key restriction, 23503, still means RLS let it through)', e.role, e.tbl))
    else is(tests.probe_dml(e.uid, format('delete from public.%I where %s', e.tbl, tests.pred(e.tbl, tests.u('a_acct')))),
            'n=0', format('%s cannot DELETE in %s', e.role, e.tbl))
  end
from exp e where e.op = 'DELETE' order by e.tbl, e.rank;

-- INSERT
select
  case when e.allowed
    then isnt(tests.probe_dml(e.uid, tests.insert_copy_stmt(e.tbl, tests.u('a_acct'))),
              'err=42501', format('%s is NOT stopped by RLS on INSERT into %s', e.role, e.tbl))
    else is(tests.probe_dml(e.uid, tests.insert_copy_stmt(e.tbl, tests.u('a_acct'))),
            'err=42501', format('%s cannot INSERT into %s', e.role, e.tbl))
  end
from exp e where e.op = 'INSERT' order by e.tbl, e.rank;

-- ---- notifications: keyed on auth.uid(), not on role --------------------------------
-- The seeded notification belongs to A's owner.
select is(tests.probe_count(tests.u('a_owner'), format('select 1 from public.notifications where account_id = %L', tests.u('a_acct'))),
          'n=1', 'owner sees their own notification');
select is(tests.probe_count(r.uid, format('select 1 from public.notifications where account_id = %L', tests.u('a_acct'))),
          'n=0', format('%s cannot see another member''s notification', r.name))
from roles r where r.name <> 'owner';
select is(tests.probe_dml(tests.u('a_owner'), format('update public.notifications set read_at = now() where account_id = %L', tests.u('a_acct'))),
          'n=1', 'owner can mark their own notification read');
select is(tests.probe_dml(r.uid, format('update public.notifications set read_at = now() where account_id = %L', tests.u('a_acct'))),
          'n=0', format('%s cannot update another member''s notification', r.name))
from roles r where r.name <> 'owner';
select is(tests.probe_dml_strict(tests.u('a_owner'), format('update public.notifications set title = ''x'' where account_id = %L', tests.u('a_acct'))),
          'err=42501', 'even the owner cannot rewrite notification content (column privilege, migration 027)');
select is(tests.probe_dml(r.uid, tests.insert_copy_stmt('notifications', tests.u('a_acct'))),
          'err=42501', format('%s cannot INSERT notifications (service-only)', r.name))
from roles r;
select is(tests.probe_dml(r.uid, format('delete from public.notifications where account_id = %L', tests.u('a_acct'))),
          'n=0', format('%s cannot DELETE notifications', r.name))
from roles r;

-- ---- profiles ---------------------------------------------------------------------
select ok(tests.probe_count(r.uid, format('select 1 from public.profiles where account_id = %L', tests.u('a_acct'))) = 'n=4',
          format('%s sees all four profiles of their own account', r.name))
from roles r;

select is(tests.probe_dml(r.uid, format('update public.profiles set full_name = full_name where user_id = %L', r.uid)),
          'n=1', format('%s can update their own profile', r.name))
from roles r;

select is(tests.probe_dml(tests.u('a_viewer'), format('update public.profiles set full_name = ''x'' where user_id = %L', tests.u('a_owner'))),
          'n=0', 'viewer cannot edit the owner''s profile');
select is(tests.probe_dml(tests.u('a_admin'), format('update public.profiles set full_name = ''x'' where user_id = %L', tests.u('a_agent'))),
          'n=0', 'even an admin cannot edit another member''s profile row');

select is(tests.probe_dml(r.uid, format('update public.profiles set account_role = ''owner'' where user_id = %L', r.uid)),
          'err=42501', format('%s cannot promote themselves (privilege-column trigger, migration 055)', r.name))
from roles r where r.name <> 'owner';
select is(tests.probe_dml(r.uid, format('update public.profiles set account_id = %L where user_id = %L', tests.u('b_acct'), r.uid)),
          'err=42501', format('%s cannot move themselves into another account', r.name))
from roles r;
select is(tests.probe_dml(r.uid, tests.insert_copy_stmt('profiles', tests.u('a_acct'))),
          'err=42501', format('%s cannot INSERT a profile directly', r.name))
from roles r;
select is(tests.probe_dml(r.uid, format('delete from public.profiles where account_id = %L', tests.u('a_acct'))),
          'n=0', format('%s cannot DELETE profiles', r.name))
from roles r;

-- ---- accounts: identity columns are immutable even for an owner ----------------------
select is(tests.probe_dml(tests.u('a_owner'), format('update public.accounts set owner_user_id = %L where id = %L', tests.u('a_admin'), tests.u('a_acct'))),
          'err=42501', 'owner cannot reassign ownership by UPDATE (must use transfer_account_ownership)');
select is(tests.probe_dml(tests.u('a_owner'), format('update public.accounts set name = ''Renamed'' where id = %L', tests.u('a_acct'))),
          'n=1', 'owner can rename the account');

select * from finish();
rollback;
