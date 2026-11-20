-- 080_credential_columns — column-level privileges from migration 063.
--
-- Every column of the four credential tables is either a registered SECRET
-- (unreadable by `authenticated`, readable by service_role) or an explicitly
-- granted non-secret column. A column added later that is neither fails here
-- (fail-closed: the author must classify it).
begin;
select * from no_plan();

select tests.guard();

create temp table secret_cols (tbl text, col text);
insert into secret_cols values
  ('whatsapp_config', 'access_token'), ('whatsapp_config', 'verify_token'),
  ('ai_configs', 'api_key'), ('ai_configs', 'embeddings_api_key'),
  ('webhook_endpoints', 'secret'), ('api_keys', 'key_hash');

-- registered secret columns must exist (a typo would hide a gap)
select is((select string_agg(s.tbl || '.' || s.col, ', ') from secret_cols s
            where not exists (select 1 from information_schema.columns c
                               where c.table_schema = 'public' and c.table_name = s.tbl and c.column_name = s.col)),
          null, 'every registered secret column exists');

-- no table-level SELECT for authenticated on the credential tables (it would
-- override the column-level restriction)
select is((select string_agg(t, ', ') from (values ('whatsapp_config'), ('ai_configs'), ('webhook_endpoints'), ('api_keys')) v(t)
            where has_table_privilege('authenticated', 'public.' || t, 'SELECT')),
          null, 'no credential table has a table-level SELECT for authenticated');

-- secret columns: unreadable by authenticated and anon, readable by service_role
select is((select string_agg(s.tbl || '.' || s.col, ', ' order by s.tbl, s.col) from secret_cols s
            where has_column_privilege('authenticated', 'public.' || s.tbl, s.col, 'SELECT')),
          null, 'authenticated cannot SELECT any secret column');
select is((select string_agg(s.tbl || '.' || s.col, ', ' order by s.tbl, s.col) from secret_cols s
            where has_column_privilege('anon', 'public.' || s.tbl, s.col, 'SELECT')),
          null, 'anon cannot SELECT any secret column');
select is((select string_agg(s.tbl || '.' || s.col, ', ' order by s.tbl, s.col) from secret_cols s
            where not has_column_privilege('service_role', 'public.' || s.tbl, s.col, 'SELECT')),
          null, 'POSITIVE CONTROL: service_role can SELECT every secret column');

-- every NON-secret column is readable by authenticated (nothing the UI needs is lost) ...
select is((select string_agg(c.table_name || '.' || c.column_name, ', ' order by c.table_name, c.column_name)
             from information_schema.columns c
            where c.table_schema = 'public' and c.table_name in ('whatsapp_config', 'ai_configs', 'webhook_endpoints', 'api_keys')
              and not exists (select 1 from secret_cols s where s.tbl = c.table_name and s.col = c.column_name)
              and not has_column_privilege('authenticated', 'public.' || c.table_name, c.column_name, 'SELECT')),
          null, 'POSITIVE CONTROL: authenticated can SELECT every non-secret column (a new column must be classified)');

-- ... and the secrets are exactly the ones registered: nothing else is withheld.
select is((select string_agg(c.table_name || '.' || c.column_name, ', ' order by c.table_name, c.column_name)
             from information_schema.columns c
            where c.table_schema = 'public' and c.table_name in ('whatsapp_config', 'ai_configs', 'webhook_endpoints', 'api_keys')
              and not has_column_privilege('authenticated', 'public.' || c.table_name, c.column_name, 'SELECT')
              and not exists (select 1 from secret_cols s where s.tbl = c.table_name and s.col = c.column_name)),
          null, 'no unregistered column is withheld from authenticated');

select * from finish();
rollback;
