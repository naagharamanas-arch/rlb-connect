-- Turns ON the "open grants" test mode for the database suite: while the schema
-- `tests_open_grants` exists, tests.emulate_legacy_data_api_grants() emulates the
-- legacy open Data API grants on top of migration 061's real ones, so RLS is the
-- only barrier under test.
--
-- A marker schema (not `ALTER DATABASE ... SET`) because the role `supabase db
-- query` uses is not a superuser and may not set database-level parameters.
-- Always paired with disable-open-grants-mode.sql. Throw-away CI database only.
create schema if not exists tests_open_grants;
comment on schema tests_open_grants is 'marker: database tests run with open grants emulated (CI only)';
