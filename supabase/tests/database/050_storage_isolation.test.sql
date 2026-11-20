-- 050_storage_isolation — the three buckets (avatars, chat-media, flow-media).
--
-- Path conventions under test:
--   chat-media / flow-media : account-<account_id>/...   (account members; writes owner/admin/agent)
--   flow-media (legacy)     : <user_id>/...              (that user only)
--   avatars                 : <user_id>/...              (that user only)
--
-- NOTE: chat-media and flow-media are PRIVATE (migration 064); avatars stay
-- public. 090_private_buckets asserts the bucket flags. These policies govern
-- listing/reading through the database API, signed-URL creation and all writes.
begin;
select * from no_plan();

select tests.guard();
select tests.seed_world();
select tests.emulate_legacy_data_api_grants();

-- Supabase blocks direct SQL DELETEs on storage.objects with a trigger
-- (storage.protect_delete, SQLSTATE 42501) unless this setting is on. That guard is
-- separate from RLS; without lifting it every delete — allowed or not — would fail
-- identically and the delete POLICIES would go untested. Scoped to this transaction.
select set_config('storage.allow_delete_query', 'true', true);

-- seed objects (as superuser)
insert into storage.objects (bucket_id, name, owner) values
  ('chat-media', 'account-' || tests.u('a_acct') || '/a.txt', tests.u('a_owner')),
  ('chat-media', 'account-' || tests.u('b_acct') || '/b.txt', tests.u('b_owner')),
  ('flow-media', 'account-' || tests.u('a_acct') || '/a.txt', tests.u('a_owner')),
  ('flow-media', 'account-' || tests.u('b_acct') || '/b.txt', tests.u('b_owner')),
  ('flow-media', tests.u('a_owner') || '/legacy.txt',         tests.u('a_owner')),
  ('avatars',    tests.u('a_owner')  || '/av.png',            tests.u('a_owner')),
  ('avatars',    tests.u('a_viewer') || '/av.png',            tests.u('a_viewer')),
  ('avatars',    tests.u('b_owner')  || '/av.png',            tests.u('b_owner'));

create temp table buckets (bucket text, a_name text, b_name text);
insert into buckets values
  ('chat-media', 'account-' || tests.u('a_acct') || '/%', 'account-' || tests.u('b_acct') || '/%'),
  ('flow-media', 'account-' || tests.u('a_acct') || '/%', 'account-' || tests.u('b_acct') || '/%'),
  ('avatars',    tests.u('a_owner')::text || '/%',        tests.u('b_owner')::text || '/%');

-- ---- POSITIVE CONTROLS -----------------------------------------------------------
select is(tests.probe_count(tests.u('a_owner'),  format('select 1 from storage.objects where bucket_id = %L and name like %L', b.bucket, b.a_name)), 'n=1',
          format('POSITIVE CONTROL: tenant A owner reads its own %s object', b.bucket)) from buckets b;
select is(tests.probe_count(tests.u('b_owner'),  format('select 1 from storage.objects where bucket_id = %L and name like %L', b.bucket, b.b_name)), 'n=1',
          format('POSITIVE CONTROL: tenant B owner reads its own %s object', b.bucket)) from buckets b;
select is(tests.probe_count(tests.u('a_viewer'), format('select 1 from storage.objects where bucket_id = ''chat-media'' and name like %L', 'account-' || tests.u('a_acct') || '/%')), 'n=1',
          'POSITIVE CONTROL: a viewer can read their account''s chat-media');
select is(tests.probe_count(tests.u('a_viewer'), format('select 1 from storage.objects where bucket_id = ''flow-media'' and name like %L', 'account-' || tests.u('a_acct') || '/%')), 'n=1',
          'POSITIVE CONTROL: a viewer can read their account''s flow-media');
select is(tests.probe_count(tests.u('a_owner'),  format('select 1 from storage.objects where bucket_id = ''flow-media'' and name like %L', tests.u('a_owner')::text || '/%')), 'n=1',
          'POSITIVE CONTROL: the legacy per-user flow-media path is readable by that user');
select is(tests.probe_count(tests.u('a_viewer'), format('select 1 from storage.objects where bucket_id = ''avatars'' and name like %L', tests.u('a_viewer')::text || '/%')), 'n=1',
          'POSITIVE CONTROL: a user reads their own avatar');

-- ---- FOREIGN PRINCIPALS: B owner and anon vs tenant A ----------------------------
create temp table foreign_p (who text, uid uuid);
insert into foreign_p values ('tenant B owner', tests.u('b_owner')), ('anon', null);

select is(tests.probe_count(p.uid, format('select 1 from storage.objects where bucket_id = %L and name like %L', b.bucket, b.a_name)), 'n=0',
          format('%s cannot read tenant A''s %s objects', p.who, b.bucket))
from foreign_p p cross join buckets b order by b.bucket, p.who;

select is(tests.probe_count(p.uid, format('select 1 from storage.objects where bucket_id = ''flow-media'' and name like %L', tests.u('a_owner')::text || '/%')), 'n=0',
          format('%s cannot read the legacy per-user flow-media path of A''s owner', p.who))
from foreign_p p;

select is(tests.probe_dml(p.uid, format('update storage.objects set name = name where bucket_id = %L and name like %L', b.bucket, b.a_name)), 'n=0',
          format('%s cannot UPDATE tenant A''s %s objects', p.who, b.bucket))
from foreign_p p cross join buckets b order by b.bucket, p.who;

select is(tests.probe_dml(p.uid, format('delete from storage.objects where bucket_id = %L and name like %L', b.bucket, b.a_name)), 'n=0',
          format('%s cannot DELETE tenant A''s %s objects', p.who, b.bucket))
from foreign_p p cross join buckets b order by b.bucket, p.who;

select is(tests.probe_dml(p.uid, format('insert into storage.objects (bucket_id, name, owner) values (%L, %L, %L)',
            b.bucket, replace(b.a_name, '%', 'planted.txt'), p.uid)), 'err=42501',
          format('%s cannot UPLOAD into tenant A''s %s path', p.who, b.bucket))
from foreign_p p cross join buckets b order by b.bucket, p.who;

select is(tests.probe_dml(p.uid, format('insert into storage.objects (bucket_id, name, owner) values (''flow-media'', %L, %L)',
            tests.u('a_owner')::text || '/planted.txt', p.uid)), 'err=42501',
          format('%s cannot UPLOAD into A''s legacy per-user flow-media folder', p.who))
from foreign_p p;

-- a tenant sees nothing at all outside its own paths
select is(tests.probe_count(tests.u('b_owner'),
          format('select 1 from storage.objects where bucket_id in (''chat-media'',''flow-media'',''avatars'') and name not like %L and name not like %L',
                 'account-' || tests.u('b_acct') || '/%', tests.u('b_owner')::text || '/%')),
          'n=0', 'tenant B owner sees no storage object outside its own paths');

-- ---- WITHIN tenant A: roles -----------------------------------------------------
select isnt(tests.probe_dml(tests.u('a_agent'), format('insert into storage.objects (bucket_id, name, owner) values (''chat-media'', %L, %L)',
            'account-' || tests.u('a_acct') || '/new.txt', tests.u('a_agent'))), 'err=42501', 'POSITIVE CONTROL: an agent can upload to their account''s chat-media');
select isnt(tests.probe_dml(tests.u('a_agent'), format('insert into storage.objects (bucket_id, name, owner) values (''flow-media'', %L, %L)',
            'account-' || tests.u('a_acct') || '/new.txt', tests.u('a_agent'))), 'err=42501', 'POSITIVE CONTROL: an agent can upload to their account''s flow-media');
select is(tests.probe_dml(tests.u('a_viewer'), format('insert into storage.objects (bucket_id, name, owner) values (''chat-media'', %L, %L)',
            'account-' || tests.u('a_acct') || '/new.txt', tests.u('a_viewer'))), 'err=42501', 'a viewer cannot upload to chat-media');
select is(tests.probe_dml(tests.u('a_viewer'), format('insert into storage.objects (bucket_id, name, owner) values (''flow-media'', %L, %L)',
            'account-' || tests.u('a_acct') || '/new.txt', tests.u('a_viewer'))), 'err=42501', 'a viewer cannot upload to flow-media');
select is(tests.probe_dml(tests.u('a_viewer'), format('update storage.objects set name = name where bucket_id = ''chat-media'' and name like %L', 'account-' || tests.u('a_acct') || '/%')),
          'n=0', 'a viewer cannot update chat-media objects');
select is(tests.probe_dml(tests.u('a_viewer'), format('delete from storage.objects where bucket_id = ''chat-media'' and name like %L', 'account-' || tests.u('a_acct') || '/%')),
          'n=0', 'a viewer cannot delete chat-media objects');
select is(tests.probe_dml(tests.u('a_agent'), format('update storage.objects set name = name where bucket_id = ''chat-media'' and name like %L', 'account-' || tests.u('a_acct') || '/%')),
          'n=1', 'POSITIVE CONTROL: an agent can update chat-media objects');
select is(tests.probe_dml(tests.u('a_agent'), format('delete from storage.objects where bucket_id = ''chat-media'' and name like %L', 'account-' || tests.u('a_acct') || '/%')),
          'n=1', 'POSITIVE CONTROL: an agent can delete chat-media objects');
select is(tests.probe_count(tests.u('a_viewer'), format('select 1 from storage.objects where bucket_id = ''avatars'' and name like %L', tests.u('a_owner')::text || '/%')),
          'n=0', 'a teammate cannot read another member''s avatar (avatars are per-user)');

-- ---- a user can still use their OWN paths (so the denials above are not blanket) -----
select isnt(tests.probe_dml(tests.u('b_owner'), format('insert into storage.objects (bucket_id, name, owner) values (''chat-media'', %L, %L)',
            'account-' || tests.u('b_acct') || '/mine.txt', tests.u('b_owner'))), 'err=42501', 'POSITIVE CONTROL: tenant B can upload into its own chat-media path');
select isnt(tests.probe_dml(tests.u('b_owner'), format('insert into storage.objects (bucket_id, name, owner) values (''avatars'', %L, %L)',
            tests.u('b_owner')::text || '/mine.png', tests.u('b_owner'))), 'err=42501', 'POSITIVE CONTROL: a user can upload their own avatar');

select * from finish();
rollback;
