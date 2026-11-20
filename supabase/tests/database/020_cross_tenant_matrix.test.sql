-- 020_cross_tenant_matrix — the core isolation guarantee, for ALL 37 tables.
--
-- Two tenants (A, B), each with a row in every table. For every table we prove
--   * POSITIVE CONTROL: each tenant's owner CAN see its own rows (so a broken
--     harness or a missing grant cannot make the "cannot" checks pass vacuously);
--   * the other tenant's owner, and anon, cannot SELECT / UPDATE / DELETE the
--     tenant's rows and cannot INSERT a row into the tenant;
--   * everything an owner can see belongs to that owner's tenant (no third-party rows).
--
-- Table privileges are emulated as fully open (see tests.emulate_legacy_...),
-- so RLS is the ONLY thing standing between the principals and the data.
-- INSERT must fail with exactly 42501 (RLS violation): any other error would
-- mean the row was not stopped by RLS.
begin;
select * from no_plan();

select tests.guard();
select tests.seed_world();
select tests.emulate_legacy_data_api_grants();

-- ---- POSITIVE CONTROLS ---------------------------------------------------------
select ok(
  tests.probe_count(tests.u('a_owner'), format('select 1 from public.%I where %s', c.tbl, tests.pred(c.tbl, tests.u('a_acct')))) ~ '^n=[1-9]',
  format('POSITIVE CONTROL: tenant A owner sees its own rows in %s', c.tbl))
from tests.table_class c where c.owner_readable order by c.tbl;

select ok(
  tests.probe_count(tests.u('b_owner'), format('select 1 from public.%I where %s', c.tbl, tests.pred(c.tbl, tests.u('b_acct')))) ~ '^n=[1-9]',
  format('POSITIVE CONTROL: tenant B owner sees its own rows in %s', c.tbl))
from tests.table_class c where c.owner_readable order by c.tbl;

-- Service-role-only tables: not even the owner can read them (documented).
select is(
  tests.probe_count(tests.u('a_owner'), format('select 1 from public.%I where %s', c.tbl, tests.pred(c.tbl, tests.u('a_acct')))),
  'n=0', format('%s is service-role only: even the owner sees nothing', c.tbl))
from tests.table_class c where not c.owner_readable order by c.tbl;

-- ---- principals trying to reach a tenant that is not theirs ---------------------
create temp table principals (who text, uid uuid, target uuid);
insert into principals values
  ('tenant B owner', tests.u('b_owner'), tests.u('a_acct')),
  ('tenant A owner', tests.u('a_owner'), tests.u('b_acct')),
  ('anon',           null,               tests.u('a_acct')),
  ('anon',           null,               tests.u('b_acct'));

-- SELECT
select is(
  tests.probe_count(p.uid, format('select 1 from public.%I where %s', c.tbl, tests.pred(c.tbl, p.target))),
  'n=0', format('%s cannot SELECT a foreign tenant''s rows in %s', p.who, c.tbl))
from principals p cross join tests.table_class c order by c.tbl, p.who;

-- UPDATE (a no-op assignment still has to pass the policy to touch the row)
select is(
  tests.probe_dml(p.uid, format('update public.%I set %I = %I where %s',
    c.tbl, tests.touch_col(c.tbl), tests.touch_col(c.tbl), tests.pred(c.tbl, p.target))),
  'n=0', format('%s cannot UPDATE a foreign tenant''s rows in %s', p.who, c.tbl))
from principals p cross join tests.table_class c order by c.tbl, p.who;

-- DELETE
select is(
  tests.probe_dml(p.uid, format('delete from public.%I where %s', c.tbl, tests.pred(c.tbl, p.target))),
  'n=0', format('%s cannot DELETE a foreign tenant''s rows in %s', p.who, c.tbl))
from principals p cross join tests.table_class c order by c.tbl, p.who;

-- INSERT a copy of the foreign tenant's row (must be stopped by RLS itself)
select is(
  tests.probe_dml(p.uid, tests.insert_copy_stmt(c.tbl, p.target)),
  'err=42501', format('%s cannot INSERT into a foreign tenant in %s', p.who, c.tbl))
from principals p cross join tests.table_class c order by c.tbl, p.who;

-- ---- everything an owner can see is its own -------------------------------------
select is(
  tests.probe_count(tests.u('b_owner'), format('select 1 from public.%I where not (%s)', c.tbl, tests.pred(c.tbl, tests.u('b_acct')))),
  'n=0', format('tenant B owner sees no row outside tenant B in %s', c.tbl))
from tests.table_class c order by c.tbl;

select is(
  tests.probe_count(tests.u('a_owner'), format('select 1 from public.%I where not (%s)', c.tbl, tests.pred(c.tbl, tests.u('a_acct')))),
  'n=0', format('tenant A owner sees no row outside tenant A in %s', c.tbl))
from tests.table_class c order by c.tbl;

select * from finish();
rollback;
