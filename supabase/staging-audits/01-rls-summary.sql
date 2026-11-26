SELECT
  COUNT(*) FILTER (WHERE NOT c.relrowsecurity) AS rls_disabled_tables,
  COUNT(*) FILTER (
    WHERE c.relrowsecurity AND NOT c.relforcerowsecurity
  ) AS rls_enabled_not_forced,
  COUNT(*) FILTER (
    WHERE c.relrowsecurity AND c.relforcerowsecurity
  ) AS rls_enabled_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p');