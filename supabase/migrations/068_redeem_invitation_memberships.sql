-- ============================================================
-- 068_redeem_invitation_memberships.sql — F2-b1 (tenancy: multi-workspace join)
--
-- redeem_invitation now ADDS a membership instead of moving the caller's profile.
--
--   Before (047): the caller's profile was re-pointed at the inviter's account and the
--   caller's personal account was DELETED. It refused if the caller already had data,
--   other members, or was already in a shared account.
--
--   After: the caller keeps their profile (profiles.account_id / account_role stay as
--   they are — they remain the caller's default workspace until F2-d) and keeps their
--   personal account and data. A row is added to account_memberships for the inviter's
--   account with the invited role. is_account_member() / has_account_access() (067)
--   already read memberships, so RLS grants access to the joined account immediately.
--
-- Refusals kept:   unauthenticated 42501; invitation not found / used / expired 22023;
--                  already an ACTIVE member of that account 23505.
-- New refusal:     a SUSPENDED membership is not re-activated by a new invitation (23505);
--                  an admin must restore it.
-- Refusals gone:   "account has data", "account has other members", "already in a shared
--                  account" — nothing is moved or deleted any more.
--
-- Concurrency: the invitation row is locked FOR UPDATE (same token is serialised);
-- UNIQUE (account_id, user_id) on account_memberships stops a double insert.
--
-- DEPLOY RULE: ship 068 in the SAME release as F2-b2 (set_member_role,
-- remove_account_member, transfer_account_ownership reading memberships). Until b2, those
-- RPCs look the target up by profiles.account_id, so an owner could not change the role
-- of, or remove, a member who joined through this function. Do not deploy 068 alone to
-- production.
--
-- Known gaps until later F2-b steps (all fail CLOSED — a joined member sees less, never
-- more): storage policies and a few helpers that still read profiles.account_id
-- (043/055 policies, dashboard_overview member count, touch_presence).
--
-- ROLLBACK: re-apply the redeem_invitation definition from 047. Memberships already added
-- through 068 remain (valid rows); remove them by hand if the rollback must also undo joins.
-- ============================================================

CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID  -- the joined account_id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_existing_status TEXT;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  -- Every authenticated user has a profile (signup trigger). Defensive.
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = v_caller_id) THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  SELECT status INTO v_existing_status
  FROM account_memberships
  WHERE account_id = v_inv.account_id
    AND user_id = v_caller_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_status = 'active' THEN
      RAISE EXCEPTION 'You are already a member of this account'
        USING ERRCODE = '23505';
    END IF;
    RAISE EXCEPTION 'Your membership in this account is suspended; ask an admin to restore it'
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO account_memberships (account_id, user_id, role, created_by)
  VALUES (v_inv.account_id, v_caller_id, v_inv.role, v_inv.created_by_user_id);

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
