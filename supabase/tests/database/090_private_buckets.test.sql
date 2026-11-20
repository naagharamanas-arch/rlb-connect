-- 090_private_buckets — the confidentiality side of migration 064.
--
-- chat-media (customer attachments) and flow-media are private: a public object
-- URL would serve a file to anyone, with no authentication and no revocation.
-- avatars remains public by design. (050_storage_isolation covers who may read,
-- write and delete objects through the policies; signed-URL creation uses the
-- same SELECT policy.)
begin;
select * from no_plan();

select tests.guard();

select is((select public from storage.buckets where id = 'chat-media'), false,
          'chat-media is private (customer attachments are not served by public URL)');
select is((select public from storage.buckets where id = 'flow-media'), false,
          'flow-media is private');
select is((select public from storage.buckets where id = 'avatars'), true,
          'avatars stays public (low sensitivity, plain-URL avatars)');

-- no other bucket is public unexpectedly
select is((select string_agg(id, ', ' order by id) from storage.buckets
            where public and id <> 'avatars'),
          null, 'avatars is the only public bucket');

-- the SELECT policies a member needs to create signed URLs for their own account
-- still exist (a private bucket with no read policy would break the app, not secure it)
select ok(exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                     and cmd = 'SELECT' and qual like '%chat-media%'),
          'POSITIVE CONTROL: a SELECT policy exists for chat-media (members can still be signed URLs)');
select ok(exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                     and cmd = 'SELECT' and qual like '%flow-media%'),
          'POSITIVE CONTROL: a SELECT policy exists for flow-media');

select * from finish();
rollback;
