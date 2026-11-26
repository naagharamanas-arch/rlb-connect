# Workspace deletion and storage cleanup — technical specification (DRAFT)

**Status:** specification only. **No code or migration has been written or
approved.** Implementation needs separate owner approval.
**Why:** the owner's data-deletion workflow (see
`data-deletion.draft.md`) promises verified deletion of a workspace's data
within 30 calendar days. The software cannot do that today. This is a
**pre-launch requirement**; the 30-day commitment stays unpublished until
the work below is built and tested.
**Basis:** repository inspection on 2026-11-25 (migrations 001–065,
`src/`). Facts not verifiable from the repository are marked UNVERIFIED.

## 1. Current state (verified)

| Capability | State |
|---|---|
| Delete a workspace (`accounts` row) | No function, route or UI. Nearly every tenant table has `account_id ... REFERENCES accounts(id) ON DELETE CASCADE` (017, 024, 026–030, 033, 035, 054), so deleting the row would cascade in the database. Never exercised or tested. |
| Delete a user login | No function. `accounts.owner_user_id` is `REFERENCES auth.users ON DELETE RESTRICT` (017), so an owner's login cannot be deleted while they own a workspace. |
| Remove a member | Exists; keeps the login and gives the person a fresh personal account (existing UI text). |
| Delete a contact | Browser calls `supabase.from('contacts').delete()` directly (`contacts/page.tsx`, `contact-detail-view.tsx`), single and bulk. Conversations/messages cascade. No server step. |
| Storage cleanup | Only `lib/storage/upload-media.ts` removes one object it just uploaded. Nothing removes objects when contacts, messages or workspaces are deleted. Buckets: `chat-media`, `flow-media`, `avatars`. |
| Export | Only broadcast-result CSV. |
| Request tracking | None. |
| Backup policy | None verified. D12/D16 are open; no production Supabase project verified. |

## 2. Gaps and required work

### G1. Server-side workspace deletion service (service role)
A single server-only routine (not a browser path), callable only by an
operator after verification, that deletes one workspace by id:
1. **Freeze:** set the workspace unusable first (there are no lifecycle
   states today: add one, e.g. `suspended`, or revoke access). Revoke API
   keys, disable webhooks, cancel scheduled broadcasts and pending
   automation executions, stop cron work for it. Cancel the subscription at
   Dodo Payments once billing exists.
2. **Dry run:** output per-table row counts and per-bucket object counts
   for the workspace, with no personal content, for the verification step.
3. **Storage first:** delete all objects for the workspace in `chat-media`
   and `flow-media` (path prefix contains the account id — verify the exact
   layout per bucket), and avatar objects for users being deleted.
   Paginate; the routine must be idempotent and re-runnable.
4. **Database:** delete the `accounts` row so cascades run, inside a
   transaction where possible.
5. **Residue sweep:** run G3 clean-ups for tables that do not cascade.
6. **Logins:** only if the owner asks, delete the owner's `auth.users`
   row **after** step 4 (because of the RESTRICT), via the admin API.
   Other members' logins are not deleted by a workspace deletion unless
   explicitly decided (open decision, see section 4).
7. **Verify:** a post-delete check asserting zero rows for the account id
   in every table with an `account_id` column (discovered from
   `information_schema`, so new tables are covered) and zero objects under
   the account's storage prefixes. Fail loudly otherwise.

### G2. Contact deletion must clean storage
Today deleting a contact leaves its media objects. Required: move contact
deletion (single and bulk) to a server path that first collects the media
object references for the contact's messages, deletes those objects, then
deletes the contact. Browser-side direct deletes must be removed or
blocked for contacts so the cleanup cannot be bypassed. Check the
`realtime_deletions` signal behaviour (065) still works.

### G3. Residual personal data after contact deletion
Verified: several tables keep rows with `contact_id` set to NULL when a
contact is deleted (`deals`, `broadcast_recipients`, `notifications`,
`automation_logs`, `flow_runs`, `ai_usage_log.conversation_id`).
Specifically, `notifications.title/body` are generated from the contact's
**name or phone number** (027) and survive the deletion. Also inspect for
personal data in `flow_run_events.payload`, `automation_logs` and
`broadcast_recipients.error_message` (contents UNVERIFIED). Required:
decide per table whether to delete or redact rows tied to a deleted
contact, and implement it as part of contact deletion and workspace
deletion.

### G4. Deletion-request ledger
A small operator-only table (service role only, no tenant RLS exposure, no
cascade from `accounts`) recording per request: request id, requester
email, workspace id, verification method/time/by, acknowledged-at, due
dates (2 business days for acknowledgement; 30 calendar days after
verification), completed-at, status, and the dry-run/verification counts.
It holds no workspace content. Its own retention is a counsel decision.

### G5. Backups and restores
Deleted data persists in backups until they expire. Required: (a) verify
and record the actual Supabase backup/PITR retention on the chosen plan and
any own logical dumps (doc 04 §8.5), and put the real expiry in the
public text; (b) a restore procedure that re-applies the deletion ledger
after any restore so deleted workspaces do not reappear. Do not publish a
backup deletion timeline until (a) is verified.

### G6. Audit logs
D9 (audit-log retention vs erasure) is open. Decide what security/audit
records survive a deletion, and that they contain no message content.

### G7. External systems
- **Meta/WhatsApp:** deleting the stored token and config does not delete
  data Meta holds. Decide whether to also unsubscribe the app from the
  customer's WABA on deletion (the config records `subscribed_apps_at`).
- **AI providers:** data sent under the customer's own key is not ours to
  delete; text stays accurate.
- **Dodo Payments:** records kept for tax/dispute purposes; confirm with
  counsel.

### G8. Operations
A runbook for the operator: how a request arrives, identity and ownership
verification, who runs the routine, approval, tracking against the 2-day
and 30-day clocks, completion email, and escalation. No self-service UI is
required by the owner's chosen model.

### G9. Tests
- Fixture workspace with every table and bucket populated; run deletion;
  assert zero residue (G1 step 7) and that a second workspace is
  untouched.
- Contact deletion: media removed, notifications/log residue handled.
- Ordering: owner login deletion after account deletion succeeds; before
  fails as designed.
- Idempotency: re-running after a partial failure completes.
- Cross-tenant: the routine cannot delete another workspace's objects
  (prefix collision tests).
- Add the job to the existing full-stack authorization CI where practical.

## 3. Acceptance criteria
- A verified request can be fully executed by the operator in one
  re-runnable routine, with a recorded dry run and a recorded post-check.
- No stored media, credentials, contacts, messages, logs or webhook secrets
  for the workspace remain, except explicitly retained records.
- Contact deletion leaves no media object and no name/phone residue.
- The 30-day target is measurable from the ledger.
- Backup expiry statement in the public text matches the verified policy.

## 4. Open decisions (owner/counsel)
1. Are members' logins deleted with the workspace, or only on their own
   request? (Members may belong to other workspaces and have personal
   accounts.)
2. Exact records legally or operationally retained and for how long.
3. Whether to unsubscribe the Meta app on deletion.
4. Whether a data export should precede deletion (none exists today).
5. Verification method for ownership.
6. Backup retention (D12/D16).

## 5. Approval gates
No code, migration or deployment under this spec until the owner approves
it. Suggested split (for approval, not started): (1) G2+G3 contact
cleanup; (2) G4 ledger; (3) G1 workspace routine; (4) G9 tests; (5) G5/G8
verification and runbook; all before launch.
