-- ============================================================
-- 069_member_rpcs_memberships.sql — F2-b2 (tenancy: member RPCs per workspace)
--
-- set_member_role, remove_account_member and transfer_account_ownership gain an explicit
-- account argument and work on account_memberships, so an owner/admin can manage members
-- of ANY workspace they administer — including members who joined through
-- redeem_invitation (068) and whose profile points at a different default account.
--
--   NEW   set_member_role(p_account_id, p_user_id, p_new_role)
--   NEW   remove_account_member(p_account_id, p_user_id)            RETURNS the user's default account id
--   NEW   transfer_account_ownership(p_account_id, p_new_owner_user_id)
--   KEPT  the old 2/1/1-argument versions, now thin wrappers that use the caller's
--         profiles.account_id (their default workspace). Existing API routes and UI keep
--         working unchanged; the wrappers are removed in F2-d.
--
-- Rules (unchanged in spirit):
--   * the caller must be an ACTIVE member of p_account_id with role owner/admin
--     (transfer: owner only); manager and below cannot manage members;
--   * the target must be a member of p_account_id;
--   * an owner cannot be demoted or removed, and nobody is promoted to owner, except via
--     transfer_account_ownership; nobody changes or removes themselves.
--
-- Dual-write (until F2-d): when p_account_id is the target's DEFAULT account
-- (profiles.account_id) the role is written through profiles, so the old readers stay
-- correct and the 067 trigger mirrors it into memberships; otherwise memberships are
-- written directly.
--
-- remove_account_member: for a member whose default account is p_account_id the user is
-- given a personal account again (their existing owned account if they have one, else a
-- new one) — as before; for a member who only joined (default account elsewhere) just the
-- membership row is deleted. Their conversation assignments in p_account_id are cleared.
--
-- transfer_account_ownership: accounts.owner_user_id is still unique per user
-- (idx_accounts_one_per_owner, dropped in F2-d), so a user who already owns ANOTHER
-- account cannot be made owner of this one; that is refused with a clear error.
--
-- DEPLOY RULE: ship 069 in the SAME release as 068 (redeem_invitation).
-- ROLLBACK: DROP the three new overloads and re-apply the 047/055 definitions of the old
-- functions (047: set_member_role, transfer_account_ownership; 055: remove_account_member).
-- ============================================================

-- ---------- set_member_role (workspace-aware) ------------------------------
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_account_id UUID,
  p_user_id UUID,
  p_new_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  IF p_account_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'Account and user are required' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM account_memberships
  WHERE account_id = p_account_id
    AND user_id IN (auth.uid(), p_user_id)
  ORDER BY user_id
  FOR UPDATE;

  SELECT role INTO v_caller_role
  FROM account_memberships
  WHERE account_id = p_account_id
    AND user_id = auth.uid()
    AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caller is not a member of this account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role' USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM account_memberships
  WHERE account_id = p_account_id
    AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target user is not a member of this account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner'
      USING ERRCODE = '22023';
  END IF;

  -- Default account of the target: write through profiles (067 mirrors it).
  UPDATE profiles
  SET account_role = p_new_role
  WHERE user_id = p_user_id
    AND account_id = p_account_id;
  IF NOT FOUND THEN
    UPDATE account_memberships
    SET role = p_new_role
    WHERE account_id = p_account_id
      AND user_id = p_user_id;
  END IF;
END;
$$;

ALTER FUNCTION public.set_member_role(UUID, UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, UUID, account_role_enum) TO authenticated;

-- ---------- remove_account_member (workspace-aware) -------------------------
CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_account_id UUID,
  p_user_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role account_role_enum;
  v_target_role account_role_enum;
  v_profile_account_id UUID;
  v_target_name TEXT;
  v_target_email TEXT;
  v_owned_account_id UUID;
  v_result_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  IF p_account_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'Account and user are required' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM account_memberships
  WHERE account_id = p_account_id
    AND user_id IN (auth.uid(), p_user_id)
  ORDER BY user_id
  FOR UPDATE;

  SELECT role INTO v_caller_role
  FROM account_memberships
  WHERE account_id = p_account_id
    AND user_id = auth.uid()
    AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caller is not a member of this account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT role INTO v_target_role
  FROM account_memberships
  WHERE account_id = p_account_id
    AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target user is not a member of this account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, full_name, email
  INTO v_profile_account_id, v_target_name, v_target_email
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_profile_account_id = p_account_id THEN
    -- p_account_id is the target's default account: hand them a personal account.
    SELECT id INTO v_owned_account_id
    FROM accounts
    WHERE owner_user_id = p_user_id
      AND id <> p_account_id;

    IF v_owned_account_id IS NULL THEN
      INSERT INTO accounts (name, owner_user_id)
      VALUES (
        COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
        p_user_id
      )
      RETURNING id INTO v_owned_account_id;
    END IF;

    -- 067's trigger drops the old membership and adds the owner membership.
    UPDATE profiles
    SET account_id = v_owned_account_id,
        account_role = 'owner'
    WHERE user_id = p_user_id;

    v_result_account_id := v_owned_account_id;
  ELSE
    v_result_account_id := v_profile_account_id;
  END IF;

  DELETE FROM account_memberships
  WHERE account_id = p_account_id
    AND user_id = p_user_id;

  UPDATE conversations
  SET assigned_agent_id = NULL
  WHERE account_id = p_account_id
    AND assigned_agent_id = p_user_id;

  RETURN v_result_account_id;
END;
$$;

ALTER FUNCTION public.remove_account_member(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID, UUID) TO authenticated;

-- ---------- transfer_account_ownership (workspace-aware) ---------------------
CREATE OR REPLACE FUNCTION public.transfer_account_ownership(
  p_account_id UUID,
  p_new_owner_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  IF p_account_id IS NULL OR p_new_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'Account and user are required' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM account_memberships
  WHERE account_id = p_account_id
    AND user_id IN (auth.uid(), p_new_owner_user_id)
  ORDER BY user_id
  FOR UPDATE;

  SELECT role INTO v_caller_role
  FROM account_memberships
  WHERE account_id = p_account_id
    AND user_id = auth.uid()
    AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Caller is not a member of this account' USING ERRCODE = '42501';
  END IF;
  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership'
      USING ERRCODE = '42501';
  END IF;

  IF p_new_owner_user_id = auth.uid() THEN
    RAISE EXCEPTION 'You are already the owner' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM account_memberships
  WHERE account_id = p_account_id
    AND user_id = p_new_owner_user_id
    AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target user is not an active member of this account'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM accounts
    WHERE owner_user_id = p_new_owner_user_id
      AND id <> p_account_id
  ) THEN
    RAISE EXCEPTION 'The new owner already owns another account; one owned account per user is allowed for now'
      USING ERRCODE = '23505';
  END IF;

  -- Demote the caller, promote the target (through profiles for a default account).
  UPDATE profiles SET account_role = 'admin'
  WHERE user_id = auth.uid() AND account_id = p_account_id;
  IF NOT FOUND THEN
    UPDATE account_memberships SET role = 'admin'
    WHERE account_id = p_account_id AND user_id = auth.uid();
  END IF;

  UPDATE profiles SET account_role = 'owner'
  WHERE user_id = p_new_owner_user_id AND account_id = p_account_id;
  IF NOT FOUND THEN
    UPDATE account_memberships SET role = 'owner'
    WHERE account_id = p_account_id AND user_id = p_new_owner_user_id;
  END IF;

  UPDATE accounts SET owner_user_id = p_new_owner_user_id
  WHERE id = p_account_id;
END;
$$;

ALTER FUNCTION public.transfer_account_ownership(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_account_ownership(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(UUID, UUID) TO authenticated;

-- ---------- old signatures: wrappers over the caller's default account --------
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_user_id UUID,
  p_new_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = auth.uid();
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  PERFORM public.set_member_role(v_account_id, p_user_id, p_new_role);
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = auth.uid();
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  RETURN public.remove_account_member(v_account_id, p_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.transfer_account_ownership(
  p_new_owner_user_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;
  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = auth.uid();
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;
  PERFORM public.transfer_account_ownership(v_account_id, p_new_owner_user_id);
END;
$$;

ALTER FUNCTION public.set_member_role(UUID, account_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_member_role(UUID, account_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, account_role_enum) TO authenticated;
ALTER FUNCTION public.remove_account_member(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_account_member(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_account_member(UUID) TO authenticated;
ALTER FUNCTION public.transfer_account_ownership(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.transfer_account_ownership(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_account_ownership(UUID) TO authenticated;
