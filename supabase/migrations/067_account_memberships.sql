-- ============================================================
-- 067_account_memberships.sql — multi-membership foundation (F2-a, EXPAND)
--
-- DRAFT — NOT APPLIED anywhere. Design: docs/architecture/08-f2-tenancy-design.md
-- Requires 066 (the `manager` enum value) to be committed first: apply 066 and 067
-- in the SAME release, as separate migration files.
--
-- What this does (and nothing else)
--   1. account_role_rank(role): the single SQL source of the role order
--      viewer 1 < agent 2 < manager 3 < admin 4 < owner 5.
--   2. account_memberships: one row per (account, user) with a role and status.
--      Read-only to members through RLS; written only by SECURITY DEFINER code.
--   3. A dual-write trigger on profiles so the table mirrors profiles.account_id /
--      account_role exactly while the old single-account code is still in use.
--   4. Backfill of every existing profile, followed by a PARITY CHECK that aborts
--      the whole migration if any profile has no matching membership
--      (a silent mismatch would otherwise lock that user out).
--   5. has_account_access(account, min_role): the new helper, reading memberships.
--   6. is_account_member(account, min_role) re-pointed at memberships with the SAME
--      signature, owner and grants, so the ~120 existing RLS policy references need
--      no edit. For every existing user the answer is unchanged (1 membership each).
--
-- Not in this migration: any policy edit, RPC change, invitation change, route
-- change, or removal of the one-account-per-owner index (those are F2-b/c/d).
-- Roles stay fail-closed: an unknown role has a NULL rank and gets no access.
--
-- ROLLBACK (forward repair, before F2-b): re-create is_account_member with the
-- profiles-based body from migration 017 (SELECT EXISTS (SELECT 1 FROM profiles p
-- WHERE p.user_id = auth.uid() AND p.account_id = target_account_id AND <rank CASE
-- on p.account_role> >= <rank CASE on min_role>)), then DROP TRIGGER
-- sync_membership_from_profile ON profiles; DROP FUNCTION sync_membership_from_profile,
-- has_account_access, account_role_rank; DROP TABLE account_memberships.
-- Never apply to production without a tested backup and explicit owner approval.
-- ============================================================

-- ---------- 1. role order -------------------------------------------------
CREATE OR REPLACE FUNCTION public.account_role_rank(p_role public.account_role_enum)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT CASE p_role
    WHEN 'viewer'  THEN 1
    WHEN 'agent'   THEN 2
    WHEN 'manager' THEN 3
    WHEN 'admin'   THEN 4
    WHEN 'owner'   THEN 5
  END;
$$;

ALTER FUNCTION public.account_role_rank(public.account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_role_rank(public.account_role_enum) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_role_rank(public.account_role_enum) TO service_role;

-- ---------- 2. memberships table -----------------------------------------
CREATE TABLE IF NOT EXISTS public.account_memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        public.account_role_enum NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (account_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_account_memberships_user_active
  ON public.account_memberships (user_id) WHERE status = 'active';

ALTER TABLE public.account_memberships ENABLE ROW LEVEL SECURITY;

-- Members of an account may read that account's memberships. No INSERT/UPDATE/DELETE
-- policy: writes happen only through SECURITY DEFINER functions / the service role.
DROP POLICY IF EXISTS account_memberships_select ON public.account_memberships;
CREATE POLICY account_memberships_select ON public.account_memberships
  FOR SELECT USING (public.is_account_member(account_id, 'viewer'));

-- Least-privilege grants (see 061): explicit, nothing for anon.
GRANT SELECT ON public.account_memberships TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_memberships TO service_role;

-- ---------- 3. dual-write from profiles ----------------------------------
-- While profiles.account_id / account_role remain the write path (until F2-b),
-- keep memberships identical to them. A profile that moves account loses the
-- membership in its old account, exactly as it loses access today.
CREATE OR REPLACE FUNCTION public.sync_membership_from_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.account_id IS NOT NULL
     AND OLD.account_id IS DISTINCT FROM NEW.account_id THEN
    DELETE FROM public.account_memberships
    WHERE account_id = OLD.account_id AND user_id = OLD.user_id;
  END IF;

  IF NEW.account_id IS NOT NULL AND NEW.account_role IS NOT NULL THEN
    INSERT INTO public.account_memberships (account_id, user_id, role)
    VALUES (NEW.account_id, NEW.user_id, NEW.account_role)
    ON CONFLICT (account_id, user_id)
    DO UPDATE SET role = EXCLUDED.role
    WHERE public.account_memberships.role IS DISTINCT FROM EXCLUDED.role;
  END IF;

  RETURN NULL;
END;
$$;

ALTER FUNCTION public.sync_membership_from_profile() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_membership_from_profile() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sync_membership_from_profile ON public.profiles;
CREATE TRIGGER sync_membership_from_profile
  AFTER INSERT OR UPDATE OF account_id, account_role ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.sync_membership_from_profile();

-- ---------- 4. backfill + parity check -----------------------------------
INSERT INTO public.account_memberships (account_id, user_id, role)
SELECT p.account_id, p.user_id, p.account_role
FROM public.profiles p
WHERE p.account_id IS NOT NULL AND p.account_role IS NOT NULL
ON CONFLICT (account_id, user_id) DO UPDATE SET role = EXCLUDED.role;

DO $$
DECLARE v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing
  FROM public.profiles p
  WHERE p.account_id IS NOT NULL
    AND p.account_role IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.account_memberships m
      WHERE m.user_id = p.user_id AND m.account_id = p.account_id AND m.role = p.account_role
    );
  IF v_missing > 0 THEN
    RAISE EXCEPTION '067 parity check failed: % profile(s) have no matching membership', v_missing;
  END IF;
END $$;

-- ---------- 5. new helper -------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_account_access(
  p_account uuid,
  p_min     public.account_role_enum DEFAULT 'viewer'
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.account_memberships m
    WHERE m.account_id = p_account
      AND m.user_id = auth.uid()
      AND m.status = 'active'
      AND public.account_role_rank(m.role) >= public.account_role_rank(p_min)
  );
$$;

ALTER FUNCTION public.has_account_access(uuid, public.account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.has_account_access(uuid, public.account_role_enum) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_account_access(uuid, public.account_role_enum) TO authenticated, service_role;

-- ---------- 6. old helper, re-pointed (same signature / owner / grants) --
-- Parameter names must not change (CREATE OR REPLACE). Body is intentionally a
-- direct query (not a call to has_account_access) so RLS evaluation costs one
-- function call, as before. A pgTAP test asserts both helpers always agree.
CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id uuid,
  min_role public.account_role_enum DEFAULT 'viewer'
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.account_memberships m
    WHERE m.account_id = target_account_id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
      AND public.account_role_rank(m.role) >= public.account_role_rank(min_role)
  );
$$;
