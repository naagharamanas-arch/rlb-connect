-- 065_realtime_deletion_signals — stop publishing DELETE events; replace them with a
-- tenant-scoped deletion signal.
--
-- PROBLEM (verified against a live Realtime server by the full-stack job): Realtime
-- does not apply row level security to DELETE events. Every subscriber of a table in
-- the `supabase_realtime` publication — another tenant, or anon with the public anon
-- key — received the primary key of every deleted row of every tenant.
--
-- FIX.
--  1. The publication stops publishing DELETE (and TRUNCATE) altogether, so no DELETE
--     event can reach anyone: `publish = 'insert, update'`. INSERT and UPDATE events
--     are unchanged; Realtime still filters them per subscriber through RLS.
--  2. The app legitimately reacted to DELETE events in five places (reaction removal,
--     member-presence removal, conversation removal from the unread set, notification
--     deletes, dashboard refresh). They are served by `realtime_deletions`: a
--     BEFORE DELETE trigger on those tables records a minimal signal row
--     (account, table, identifying columns only — never message content). The table
--     is in the publication and protected by RLS, so its INSERT events are filtered
--     per subscriber exactly like any other tenant data: a tenant receives only its
--     own deletions, and notification deletions only reach the notified user.
--
-- The signal rows are ephemeral: each insert prunes rows older than one hour.
-- `account_id` deliberately has NO foreign key, so deleting an account (which
-- cascades through these tables) can never be blocked by its own signals.
--
-- ORDER: additive for old clients (they lose live DELETE syncing until the new app is
-- deployed; nothing breaks). Apply this migration BEFORE deploying the app that
-- subscribes to realtime_deletions.
--
-- ROLLBACK:
--   ALTER PUBLICATION supabase_realtime SET (publish = 'insert, update, delete, truncate');
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.realtime_deletions;
--   DROP TRIGGER IF EXISTS record_realtime_deletion ON public.messages;
--   (same for message_reactions, conversations, notifications, member_presence)
--   DROP FUNCTION public.record_realtime_deletion();
--   DROP TABLE public.realtime_deletions;

CREATE TABLE IF NOT EXISTS public.realtime_deletions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  uuid        NOT NULL,   -- no FK on purpose (see header)
  -- NULL = visible to every member of the account; set = only that user (notifications)
  user_id     uuid,
  table_name  text        NOT NULL
              CHECK (table_name IN ('messages', 'message_reactions', 'conversations',
                                    'notifications', 'member_presence')),
  -- identifying columns of the deleted row only (ids), never content
  old_row     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS realtime_deletions_created_at_idx
  ON public.realtime_deletions (created_at);

ALTER TABLE public.realtime_deletions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS realtime_deletions_select ON public.realtime_deletions;
CREATE POLICY realtime_deletions_select ON public.realtime_deletions
  FOR SELECT
  USING (
    public.is_account_member(account_id)
    AND (user_id IS NULL OR user_id = auth.uid())
  );
-- No INSERT / UPDATE / DELETE policy: only the trigger function (owner) and the
-- service role write this table.

-- Data API grants (migration 061: new tables are not auto-exposed).
GRANT SELECT ON public.realtime_deletions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.realtime_deletions TO service_role;

-- Records one signal per deleted row. SECURITY DEFINER so it can write the table
-- regardless of who deletes; search_path pinned. It resolves the owning account from
-- the OLD row (messages and reactions through their conversation). When the account
-- cannot be resolved — the parent conversation is already gone because the delete is a
-- cascade — nothing is recorded: the parent's own deletion signal already covers it.
CREATE OR REPLACE FUNCTION public.record_realtime_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_user    uuid;
  v_keep    jsonb;
BEGIN
  IF TG_TABLE_NAME = 'messages' THEN
    SELECT c.account_id INTO v_account FROM public.conversations c WHERE c.id = OLD.conversation_id;
    v_keep := jsonb_build_object('id', OLD.id, 'conversation_id', OLD.conversation_id);
  ELSIF TG_TABLE_NAME = 'message_reactions' THEN
    SELECT c.account_id INTO v_account FROM public.conversations c WHERE c.id = OLD.conversation_id;
    v_keep := jsonb_build_object('id', OLD.id, 'conversation_id', OLD.conversation_id,
                                 'message_id', OLD.message_id);
  ELSIF TG_TABLE_NAME = 'conversations' THEN
    v_account := OLD.account_id;
    v_keep := jsonb_build_object('id', OLD.id);
  ELSIF TG_TABLE_NAME = 'notifications' THEN
    v_account := OLD.account_id;
    v_user := OLD.user_id;
    v_keep := jsonb_build_object('id', OLD.id, 'account_id', OLD.account_id);
  ELSIF TG_TABLE_NAME = 'member_presence' THEN
    v_account := OLD.account_id;
    v_keep := jsonb_build_object('user_id', OLD.user_id, 'account_id', OLD.account_id);
  END IF;

  IF v_account IS NOT NULL THEN
    -- keep the table small: drop a few stale signals per insert
    DELETE FROM public.realtime_deletions
     WHERE id IN (SELECT id FROM public.realtime_deletions
                   WHERE created_at < now() - interval '1 hour' ORDER BY id LIMIT 20);
    INSERT INTO public.realtime_deletions (account_id, user_id, table_name, old_row)
    VALUES (v_account, v_user, TG_TABLE_NAME, v_keep);
  END IF;

  RETURN OLD;
END;
$$;

ALTER FUNCTION public.record_realtime_deletion() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_realtime_deletion() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS record_realtime_deletion ON public.messages;
CREATE TRIGGER record_realtime_deletion BEFORE DELETE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.record_realtime_deletion();
DROP TRIGGER IF EXISTS record_realtime_deletion ON public.message_reactions;
CREATE TRIGGER record_realtime_deletion BEFORE DELETE ON public.message_reactions
  FOR EACH ROW EXECUTE FUNCTION public.record_realtime_deletion();
DROP TRIGGER IF EXISTS record_realtime_deletion ON public.conversations;
CREATE TRIGGER record_realtime_deletion BEFORE DELETE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.record_realtime_deletion();
DROP TRIGGER IF EXISTS record_realtime_deletion ON public.notifications;
CREATE TRIGGER record_realtime_deletion BEFORE DELETE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.record_realtime_deletion();
DROP TRIGGER IF EXISTS record_realtime_deletion ON public.member_presence;
CREATE TRIGGER record_realtime_deletion BEFORE DELETE ON public.member_presence
  FOR EACH ROW EXECUTE FUNCTION public.record_realtime_deletion();

-- Realtime publication: publish the signal table, and stop publishing DELETE / TRUNCATE
-- for every published table (the publication-level switch is the only reliable way:
-- Realtime itself never RLS-filters DELETE events).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime'
                    AND schemaname = 'public' AND tablename = 'realtime_deletions') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.realtime_deletions;
  END IF;
END $$;

ALTER PUBLICATION supabase_realtime SET (publish = 'insert, update');
