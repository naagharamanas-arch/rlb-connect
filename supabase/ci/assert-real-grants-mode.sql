-- Fails if the "open grants" test mode is still enabled. Run before the passes that
-- must test the REAL grants, so a leaked marker can never make them silently run in
-- open mode.
do $$
begin
  if to_regnamespace('tests_open_grants') is not null then
    raise exception 'open-grants test mode is still enabled (schema tests_open_grants exists)';
  end if;
end $$;
