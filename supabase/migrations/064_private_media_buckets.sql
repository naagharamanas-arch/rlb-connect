-- 064_private_media_buckets — chat-media and flow-media become PRIVATE.
--
-- BEFORE: both buckets were public ("so Meta can fetch"): anyone holding an
-- object URL could read the file with no authentication, forever, and every URL
-- contains the account id. chat-media holds customer attachments (photos,
-- documents, voice notes) mirrored from inbound WhatsApp messages by default.
-- AFTER: objects are served only (a) to signed-in members of the owning account
-- through GET /api/media/<bucket>/<path>, which redirects to a short-lived signed
-- URL, and (b) to Meta through a short-lived signed URL the server creates at
-- send time. Avatars stay public (low sensitivity, referenced by plain URL).
--
-- This changes only the bucket flag. The storage.objects row-level policies are
-- untouched (account members read; owner/admin/agent write) and already permit
-- members to create signed URLs for their own account folder.
--
-- ORDER: apply together with / after the application change that stores media
-- references instead of bucket URLs (this repo is greenfield: no legacy public
-- URLs exist, so no data migration is needed).
--
-- ROLLBACK (re-publishes every object; not recommended):
--   UPDATE storage.buckets SET public = true WHERE id IN ('chat-media', 'flow-media');

UPDATE storage.buckets
   SET public = false
 WHERE id IN ('chat-media', 'flow-media');
