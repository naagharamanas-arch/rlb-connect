-- 070_data_api_grants — the explicit least-privilege grants from migration 061.
--
-- Evaluated against the database exactly as the migrations leave it (this file
-- never calls tests.emulate_legacy_data_api_grants()). Every other file in the
-- suite also runs against these real grants once 061 exists (dual mode), so
-- their positive controls prove each allowed operation actually works.
begin;
select * from no_plan();

select tests.guard();

-- (SELECT is checked as table-level OR column-level: the credential tables are
-- column-restricted by migration 063; their secret columns are asserted in 060/080.)
-- Expected authenticated privilege per (table, op), derived from the reviewed
-- policy matrix. tests.role_expect has no rows for profiles / notifications
-- (auth.uid()-keyed), so they are stated explicitly.
create temp table grant_expect on commit drop as
select c.tbl, o.op,
       case
         when c.tbl = 'profiles'      then o.op in ('SELECT', 'UPDATE')
         when c.tbl = 'notifications' then o.op = 'SELECT'   -- UPDATE is column-level (read_at)
         else coalesce((select r.min_rank is not null from tests.role_expect r
                         where r.tbl = c.tbl and r.op = o.op), false)
       end as expected
  from tests.table_class c
 cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) o(op);

select is((select count(*)::int from grant_expect), 148, 'grant matrix covers 37 tables x 4 operations');

-- ---- anon: nothing --------------------------------------------------------------
select is(
  (select string_agg(c.tbl || ':' || p.priv, ', ' order by c.tbl, p.priv)
     from tests.table_class c
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
    where has_table_privilege('anon', 'public.' || c.tbl, p.priv)),
  null, 'LEAST PRIVILEGE: anon holds no privilege of any kind on any public table');

-- ---- authenticated: exactly the policy-derived operations ----------------------------
select is(
  (select string_agg(g.tbl || ':' || g.op, ', ' order by g.tbl, g.op) from grant_expect g
    where g.expected and not (case when g.op = 'SELECT'
                                   then has_any_column_privilege('authenticated', 'public.' || g.tbl, 'SELECT')
                                   else has_table_privilege('authenticated', 'public.' || g.tbl, g.op) end)),
  null, 'authenticated holds every operation that a policy can allow (nothing the app needs is missing)');

select is(
  (select string_agg(g.tbl || ':' || g.op, ', ' order by g.tbl, g.op) from grant_expect g
    where not g.expected and (case when g.op = 'SELECT'
                                     then has_any_column_privilege('authenticated', 'public.' || g.tbl, 'SELECT')
                                     else has_table_privilege('authenticated', 'public.' || g.tbl, g.op) end)),
  null, 'LEAST PRIVILEGE: authenticated holds no operation that no policy can allow');

select is(
  (select string_agg(c.tbl || ':' || p.priv, ', ' order by c.tbl, p.priv)
     from tests.table_class c
    cross join (values ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
    where has_table_privilege('authenticated', 'public.' || c.tbl, p.priv)),
  null, 'LEAST PRIVILEGE: authenticated holds no TRUNCATE / REFERENCES / TRIGGER');

-- notifications: UPDATE is column-level, read_at only (027 preserved)
select is(
  (select string_agg(a.attname, ', ' order by a.attname)
     from pg_attribute a
    where a.attrelid = 'public.notifications'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', 'public.notifications', a.attname, 'UPDATE')),
  'read_at', 'authenticated may UPDATE notifications.read_at and no other column');

-- ---- service_role: read/write everything, nothing more --------------------------------
select is(
  (select string_agg(c.tbl || ':' || o.op, ', ' order by c.tbl, o.op)
     from tests.table_class c cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) o(op)
    where not has_table_privilege('service_role', 'public.' || c.tbl, o.op)),
  null, 'service_role can SELECT, INSERT, UPDATE and DELETE on every table');

select is(
  (select string_agg(c.tbl || ':' || p.priv, ', ' order by c.tbl, p.priv)
     from tests.table_class c
    cross join (values ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
    where has_table_privilege('service_role', 'public.' || c.tbl, p.priv)),
  null, 'LEAST PRIVILEGE: service_role holds no TRUNCATE / REFERENCES / TRIGGER');

-- the two service-only tables are unreachable by authenticated even for SELECT
select is(
  (select string_agg(c.tbl, ', ' order by c.tbl) from tests.table_class c
    where not c.owner_readable and has_any_column_privilege('authenticated', 'public.' || c.tbl, 'SELECT')),
  null, 'service-only tables (no policy) are not selectable by authenticated');

-- ---- every table is covered by this matrix (a new table must be added) -------------------
select is(
  (select string_agg(c.relname, ', ' order by c.relname) from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and c.relname not in (select tbl from tests.table_class)),
  null, 'every public table has a reviewed grant expectation (new tables need an explicit GRANT and a matrix entry)');

-- ---- sequences are not exposed -----------------------------------------------------------
select is(
  (select string_agg(c.relname, ', ' order by c.relname) from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
      and (has_sequence_privilege('anon', c.oid, 'USAGE') or has_sequence_privilege('authenticated', c.oid, 'USAGE'))),
  null, 'no public sequence is usable by anon or authenticated');

-- ---- default privileges: a future table is NOT auto-exposed ------------------------------------
create table public._grant_probe (id int);
select is(
  (select string_agg(r.rolname || ':' || p.priv, ', ' order by r.rolname, p.priv)
     from (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
    where has_table_privilege(r.rolname, 'public._grant_probe', p.priv)),
  null, 'default privileges are locked: a newly created public table grants nothing to the Data API roles');

select * from finish();
rollback;
