-- Reproduces an OLDER Supabase project: open default privileges on public tables
-- for the Data API roles. CI applies this, then re-applies migration 061 over it,
-- then runs the suite, to prove 061 converges both kinds of project to the same
-- least-privilege state. Throw-away CI database only.
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
