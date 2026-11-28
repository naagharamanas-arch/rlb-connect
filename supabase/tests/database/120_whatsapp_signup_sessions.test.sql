-- 120_whatsapp_signup_sessions — Embedded Signup S1 (migration 070, PROPOSAL).
-- Cross-tenant read denied, no browser writes, state_hash never browser-readable.
-- Runs against the REAL least-privilege grants. Every "cannot" has a positive control.
-- NOT RUN in the authoring session (no local Supabase) — run in CI / local before merge.
begin;
select * from no_plan();

select tests.guard();
select tests.seed_world();

-- ---- positive controls: members read their own account's session rows --------
select ok(tests.probe_count(tests.u('a_viewer'),
  format('select id, status, expires_at from public.whatsapp_signup_sessions where account_id = %L', tests.u('a_acct'))) ~ '^n=[1-9]',
  'POSITIVE CONTROL: a member reads the non-secret session columns of their own account');
select ok(tests.probe_count(tests.u('b_owner'),
  format('select id from public.whatsapp_signup_sessions where account_id = %L', tests.u('b_acct'))) ~ '^n=[1-9]',
  'POSITIVE CONTROL: another tenant reads its own rows');

-- ---- cross-tenant read denied ----------------------------------------------------
select is(tests.probe_count(tests.u('b_owner'),
  format('select id from public.whatsapp_signup_sessions where account_id = %L', tests.u('a_acct'))),
  'n=0', 'another tenant cannot read this account''s signup sessions');

-- ---- state_hash is never browser-readable ----------------------------------------
select ok(not has_column_privilege('authenticated', 'public.whatsapp_signup_sessions', 'state_hash', 'SELECT'),
  'authenticated has no SELECT on state_hash');
select ok(not has_column_privilege('anon', 'public.whatsapp_signup_sessions', 'state_hash', 'SELECT'),
  'anon has no SELECT on state_hash');
select is(tests.probe_count_strict(tests.u('a_owner'),
  format('select state_hash from public.whatsapp_signup_sessions where account_id = %L', tests.u('a_acct'))),
  'err=42501', 'even an owner of the account cannot select state_hash');
select ok(has_column_privilege('service_role', 'public.whatsapp_signup_sessions', 'state_hash', 'SELECT'),
  'POSITIVE CONTROL: service_role can read state_hash');

-- ---- no browser writes ---------------------------------------------------------------
select ok(not has_table_privilege('authenticated', 'public.whatsapp_signup_sessions', 'INSERT')
      and not has_table_privilege('authenticated', 'public.whatsapp_signup_sessions', 'UPDATE')
      and not has_table_privilege('authenticated', 'public.whatsapp_signup_sessions', 'DELETE'),
  'authenticated has no write privilege');
select ok(not has_table_privilege('anon', 'public.whatsapp_signup_sessions', 'SELECT'),
  'anon has no privilege at all');
select ok(has_table_privilege('service_role', 'public.whatsapp_signup_sessions', 'INSERT')
      and has_table_privilege('service_role', 'public.whatsapp_signup_sessions', 'UPDATE'),
  'POSITIVE CONTROL: service_role can write');

-- Under open grants RLS alone must still refuse writes: there is no write policy.
-- Convention (110, 020, 030): with every table privilege emulated as granted, an INSERT
-- that RLS refuses raises 42501 ("new row violates row-level security policy"); it does
-- not return 0 rows. UPDATE/DELETE are filtered to zero rows (n=0). Because the grants
-- are open here, a missing GRANT cannot be the cause of the 42501.
select tests.emulate_legacy_data_api_grants();
select is(tests.probe_dml(tests.u('a_owner'),
  format('insert into public.whatsapp_signup_sessions (account_id, user_id, state_hash, expires_at) values (%L, %L, %L, now())',
         tests.u('a_acct'), tests.u('a_owner'), 'forged-hash')),
  'err=42501', 'RLS alone (open grants) refuses an owner INSERT');
select is(tests.probe_dml(tests.u('a_owner'),
  format('update public.whatsapp_signup_sessions set status = %L where account_id = %L', 'connected', tests.u('a_acct'))),
  'n=0', 'RLS alone (open grants) refuses an owner UPDATE');
select is(tests.probe_dml(tests.u('a_owner'),
  format('delete from public.whatsapp_signup_sessions where account_id = %L', tests.u('a_acct'))),
  'n=0', 'RLS alone (open grants) refuses an owner DELETE');

-- ---- constraints --------------------------------------------------------------------------
select throws_ok(
  format('insert into public.whatsapp_signup_sessions (account_id, user_id, state_hash, status, expires_at) values (%L, %L, %L, %L, now())',
         tests.u('a_acct'), tests.u('a_owner'), 'h-bad-status', 'bogus'),
  '23514', null, 'status outside the state machine is rejected');
select throws_ok(
  format('insert into public.whatsapp_signup_sessions (account_id, user_id, state_hash, mode, expires_at) values (%L, %L, %L, %L, now())',
         tests.u('a_acct'), tests.u('a_owner'), 'h-bad-mode', 'bogus'),
  '23514', null, 'mode outside {new_number, coexistence} is rejected');

select * from finish();
rollback;
