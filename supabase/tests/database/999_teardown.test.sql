-- 999_teardown — remove the helper schema installed by 000_helpers so the local
-- database is left exactly as the migrations built it (helpers are for tests only).
select plan(1);
drop schema if exists tests cascade;
select ok(not exists (select 1 from pg_namespace where nspname = 'tests'), 'test helper schema removed');
select * from finish();
