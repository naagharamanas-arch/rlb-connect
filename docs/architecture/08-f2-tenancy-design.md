# 08 — F2 Tenancy core: multi-membership design (Wave 1, step 1)

> Status: **DESIGN FOR REVIEW — no code, no migration, nothing applied.**
> Date: 2026-11-27. Builds on docs 02 §5–§8 and 05 (A1–A11, ratified 2026-11-27).
> Rule: reuse the existing WACRM account model; expand → migrate → contract.

## 1. What exists today (verified in repo, HEAD a29f369)

- `accounts` (017): `owner_user_id`, plus `UNIQUE INDEX idx_accounts_one_per_owner`.
- Membership lives on **`profiles.account_id` + `profiles.account_role`** (one account per user).
  Direct edits to these two columns are blocked by a trigger (034); only RPCs change them.
- Role enum `account_role_enum` = owner/admin/agent/viewer. Rank is hard-coded in 3 places that
  must stay aligned: SQL `is_account_member` CASE (017, no ELSE => unknown role = no access), the pgTAP
  `tests.role_expect.min_rank` numbers, and `src/lib/auth/roles.ts`. The member RPCs (018/047/055) use explicit
  role lists (e.g. `NOT IN ('owner','admin')`), not rank. UI role lists (invite dialog, members tab, role-meta,
  peek-result, route-registry `RouteRole`, 4 locale files) also need `manager` in F2-c.
- `is_account_member(account, min_role)` reads `profiles`; referenced **120 times in 13 migration files**
  (all RLS policies go through it).
- Code that reads `profiles` for membership (must be reworked): 018 (`set_member_role`,
  `remove_account_member`, `transfer_account_ownership`), 019 (`peek_invitation`, `redeem_invitation`),
  024 (presence), 027 (notifications), 047 (membership-integrity triggers), `handle_new_user` (017).
- App side: `getCurrentAccount()` / `requireRole()` in `src/lib/auth/account.ts` derive the account from the
  caller's profile. ~19 non-test source files touch `account_role` / `profiles`; ~34 reference `account_id`.
- `redeem_invitation` today **refuses** if the caller already has data or is in a shared account
  ("sign up with a different email"). Multi-membership removes this restriction.
- Tests to extend: pgTAP 020 (cross-tenant), 030 (role matrix), 040 (RPC authz), 050, 100; `route-registry.ts`
  + `route-authorization.test.ts`; `tests/fullstack/*`.

## 2. Target model

```
account_memberships
  id uuid pk, account_id fk accounts, user_id fk auth.users,
  role account_role_enum, status ('active'|'suspended'), created_at, created_by,
  UNIQUE (account_id, user_id)          -- a user has one role per workspace
```
- Agency tables (S4) are **not** part of F2. `has_account_access` is written with a documented extension point
  for the agency branch so S4 adds a clause, not a rewrite.
- `profiles.account_id/account_role` stay during F2 as the **default (home) workspace** only; they stop being an
  authorization source once F2-b ships.

## 3. Migration sequence (expand → migrate → contract)

| Step | Change | Behaviour change | Rollback |
|---|---|---|---|
| **F2-a Expand** | Create `account_memberships` (+RLS, grants, indexes). Backfill 1 row per profile from `profiles`. Dual-write trigger: profile role/account change ⇒ membership upsert. Add `has_account_access()` reading memberships; **re-point `is_account_member` to it as a thin wrapper** (0 policy edits). | None for users (1 membership per user == old state). | Drop wrapper change, trigger, table (nothing else depends on them yet). |
| **F2-b Migrate** | Rewrite 018/019/024/027/047 functions and `handle_new_user` to use memberships. New `redeem_invitation`: adds a membership, does **not** move the profile, no "must be empty" rule; blocks only duplicate membership. Last-owner protection preserved on memberships. | Users can join several workspaces. | Forward-repair migration (functions are `CREATE OR REPLACE`; keep old bodies in the migration file header). |
| **F2-c Routing** | `/w/<id>/…` routes, workspace switcher, `requireWorkspaceRole(id, min)`; legacy URLs redirect to the user's default workspace. | UI. | Feature-flagged by route; legacy routes remain until F2-d. |
| **F2-d Contract** | Drop `idx_accounts_one_per_owner`; stop dual-write; (much later, separate approval) remove `profiles.account_*`. | None. | Re-create index only if no user owns 2 accounts. |

Each step: staging first → CI (pgTAP + full-stack) → owner approval → (production only with a tested backup and explicit approval).
**Production:** before F2-a there must be a read-only audit (profiles with NULL account, accounts without an owner
profile, orphan rows). Not yet done; migration state of 065 on production is also unverified (tracker P1.7).

## 4. Authorization rules (must hold after every step)
1. Workspace id comes from the **URL**, and is verified against `account_memberships` **server-side on every request**.
   Never from a client-supplied field alone; never a DB session variable (no "current tenant" state).
2. Rank mapping lives in one SQL function `account_role_rank(role)` used by `has_account_access` and the RPCs;
   `roles.ts` mirrors it and a unit test compares the two lists.
3. `SECURITY DEFINER` helpers: `SET search_path = public`, no user id parameter, execute grant limited.
4. `service_role` code keeps filtering `account_id`; allow-list test unchanged.
5. Realtime/Storage keep relying on RLS through the same helper; add a test that a user in workspaces A and B
   cannot subscribe to or read workspace C.

## 5. `/w/<id>` routing (F2-c)
- Pages: move `src/app/(dashboard)/*` under `src/app/w/[workspaceId]/…` (route group keeps layout/shell).
- Default workspace: `profiles.account_id` (home) until the user picks another; remember last-used via a
  non-authoritative cookie (UI hint only, always re-validated).
- API routes: **OWNER DECISION D-F2-2** — how the workspace is selected for `/api/*` calls
  (A: `X-Workspace-Id` header validated server-side; B: move APIs under `/api/w/<id>/…`).
  Public REST API (`/api/v1/*`) is unchanged: API keys are already bound to one account.
- Every new route is added to `route-registry.ts` so the authorization test fails if one is missing.

## 6. Roles — OWNER DECISION D-F2-1: add `manager` now?
- Adding `manager` (owner > admin > manager > agent > viewer) is required by the planned roles. `ALTER TYPE … ADD VALUE`
  is irreversible and cannot be used in the same transaction, so it must be its own tiny migration **before** F2-a.
- Ranks shift (owner 5, admin 4, manager 3, agent 2, viewer 1); SQL CASE copies in 018 and `roles.ts` must change together.
- **Recommendation:** add it now (cheap; every later migration then targets the final enum). If you prefer, delay it,
  but the ranking refactor (§4.2) is then done twice.

## 7. Tests required (acceptance for F2)
- pgTAP: user in 2 workspaces reads/writes only where a membership exists (every table in the coverage list);
  removed/suspended member loses access immediately; role matrix incl. `manager`; last-owner cannot be removed or demoted;
  ownership transfer between memberships; profile column guard (034) still holds; `redeem_invitation` cases
  (new user, existing user with data, already member, expired, reused token).
- Full-stack: same user switching `/w/A` → `/w/B`; changing the id in the URL to a workspace without membership → 403/404;
  Realtime and Storage cross-workspace attempts.
- Audit hook point: membership changes call `audit_log()` once F4 exists (F2 only leaves the call sites obvious).

## 8. Out of scope for F2
Agency tables and cross-workspace assignments (S4), audit log table (F4), job queue (F3), billing/seat limits (C-series),
multi-number (S6). Seat entitlements will read `account_memberships` later.

## 9. Risks
| Risk | Mitigation |
|---|---|
| A forgotten policy/RPC still reads `profiles` | grep gate in CI: no `FROM profiles` in policies/RPCs after F2-b except allow-listed home-workspace reads |
| Dual-write drift | pgTAP test: profile and membership agree for every user until F2-d |
| Enum rank drift (SQL vs TS) | single SQL rank function + unit test against `roles.ts` |
| Production data oddities | read-only audit before F2-a (owner-approved) |

## 10. Decisions needed from the owner
- **D-F2-1** add `manager` role now (recommended yes).
- **D-F2-2** API workspace selection: header (A) or path (B). Recommendation: **A** — smaller change, same security (server-verified).
- **D-F2-3** approve this design to start drafting **F2-a** (migration SQL + pgTAP, local files only, nothing applied).
