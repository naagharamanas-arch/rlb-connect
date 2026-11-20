-- 005_grants_mode — the suite knows which grants it is running against.
--
-- The suite runs in up to three passes (see .github/workflows/migrations.yml): the
-- real grants from migration 061, the same suite with the legacy open grants emulated
-- on top ("open mode", marker schema tests_open_grants), and 061 re-applied over
-- legacy grants. This file proves the mode switch itself works in BOTH directions, so
-- the open-mode pass cannot silently be a copy of the real-grants pass (and a leaked
-- marker cannot silently turn a real-grants pass into an open one):
--   * marker present  => emulation is applied: authenticated holds table-level SELECT
--                        on a credential table (which 063 withholds);
--   * marker absent   => the real grants are untouched: it does not.
begin;
select * from no_plan();

select tests.guard();

create temp table mode as
  select to_regnamespace('tests_open_grants') is not null as open_mode;

select ok(not has_table_privilege('authenticated', 'public.whatsapp_config', 'SELECT'),
          'before any emulation, authenticated has no table-level SELECT on whatsapp_config (063)');

select tests.emulate_legacy_data_api_grants();

select is(has_table_privilege('authenticated', 'public.whatsapp_config', 'SELECT'),
          (select open_mode from mode),
          'open grants are emulated exactly when the tests_open_grants marker exists');

select is(current_setting('tests.emulated', true) is not distinct from 'on',
          (select open_mode from mode),
          'the probe helpers treat the run as RLS-only exactly when open grants are emulated');

select * from finish();
rollback;
