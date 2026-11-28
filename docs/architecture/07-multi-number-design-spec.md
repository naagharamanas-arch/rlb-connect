# 07 — Multi-number WhatsApp design spec (Phase 1B)

Status: **DESIGN ONLY. No code, no migrations, nothing applied.** Written 2026-11-25.
Decision recorded: multi-number is built **before** Embedded Signup / Coexistence (see `06-embedded-signup-coexistence-plan.md`).
Hard gate: **no migration from this spec is applied until the Supabase branch mapping and the 063/064 state are reconciled** (open item from the reconciliation audit).

Items marked **[DECISION]** need an owner choice. Recommended defaults are given but are not approved.

## 1. Problem

Today one RLB account has exactly one WhatsApp number:
- `whatsapp_config.account_id` is UNIQUE (`017_account_sharing.sql:312-326`), `phone_number_id` UNIQUE instance-wide (`013_…sql`).
- One encrypted `access_token` and one `verify_token` live in that same row.
- Every send, webhook, broadcast, template and flow looks the number up by `account_id` and expects a single row.

Goal: an account can connect several numbers (possibly under several WABAs), each with its own status, tokens (via its WABA), quality and limits, and every conversation, message, broadcast, flow and API call knows which number it belongs to.

## 2. Facts from the repository that constrain the design

| Fact | Evidence | Consequence |
|---|---|---|
| One conversation per (account, contact) is enforced by a unique index | `036_conversation_contact_dedup.sql` (`idx_conversations_account_contact`) | With two numbers the same customer can message both; the unique index must include the number |
| Contacts unique per (account, normalised phone) and per (account, `wa_user_id`) | `022…:118`, `040…:43` | Contacts stay account-level and shared across numbers (no change) |
| Templates unique on (account, name, language) | `057_message_templates_account_unique.sql` | Templates belong to a **WABA**, not an account; two WABAs may use the same template name. Uniqueness must include the WABA |
| `whatsapp_config` readable columns for members | `063…` grant list: `id, user_id, phone_number_id, waba_id, status, connected_at, created_at, updated_at, registered_at, subscribed_apps_at, last_registration_error, account_id, mirror_inbound_media, has_verify_token` | Secret columns: `access_token`, `verify_token`. Any new secret column must be classified (test `080_credential_columns` fails closed) |
| Webhook routes by `phone_number_id` then cross-checks the WABA | `src/lib/whatsapp/webhook-routing.ts` (commit `781401a`, unpushed) | Lookup moves to the numbers table; the cross-check stays |
| Verify-token handshake accepts any stored config's token | `docs/multi-waba.md`; `webhook/route.ts:198-202` | The verify token is really per Meta app, not per number; decide where it lives |
| Credential reads go through one helper | `src/lib/credentials/server.ts` (`fetchWhatsAppConfig`) | Extend this one helper; keep the source-guard allowlist (`guard.test.ts`) |
| ~35 code sites read `whatsapp_config` | grep of `src` (section 7) | Staged migration, not a big bang |
| Realtime/RLS conventions | `017` policies, `061` grants, `065` realtime grants | New tables follow the same RLS and grant patterns; re-running `061` after `063` would re-grant table SELECT (known hazard) |

## 3. Target data model

### 3.1 Recommended: two tables (credential holder + number)

```
whatsapp_wabas          one row per WABA connection (what a token belongs to)
  id uuid pk
  account_id uuid fk accounts  (RLS tenancy key)
  waba_id text  not null  unique (instance-wide: a WABA belongs to one account)
  access_token text (encrypted)         -- SECRET
  token_kind text                       -- 'manual' | 'embedded_signup'
  token_expires_at timestamptz null
  meta_app_id text null                 -- which Meta app owns the subscription
  status text                           -- connected | needs_attention | disconnected
  subscribed_apps_at timestamptz null
  created_by uuid, created_at, updated_at

whatsapp_numbers        one row per phone number
  id uuid pk
  account_id uuid fk accounts
  waba_row_id uuid fk whatsapp_wabas
  phone_number_id text not null unique  (existing instance-wide rule, migration 013)
  display_phone_number text, verified_name text   -- display facts only
  label text                            -- agent-facing name ("Sales", "Support")
  status text, registered_at, last_registration_error
  quality_rating text null, messaging_tier text null  -- from Meta, informational
  connection_method text                -- 'manual' | 'embedded_signup' | 'coexistence'
  is_default boolean                    -- exactly one default per account (partial unique index)
  mirror_inbound_media boolean          -- moved from whatsapp_config
  created_at, updated_at, connected_at
```

Reasons: one Meta token covers all numbers in a WABA, and Embedded Signup returns exactly one business token per customer WABA. Storing the token per number would duplicate the secret and make rotation error-prone. The verify token is a per-**app** value; keep it in a single account-level or deployment-level place (see decision D6), not per number.

### 3.2 Simpler alternative (not recommended)
Drop the UNIQUE(account_id) on `whatsapp_config`, add `label`, `is_default`, keep token per row. Fewer tables and a faster first step, but duplicates tokens per WABA, keeps `verify_token` per row, and needs a second redesign for Embedded Signup. Choose only if time-to-first-multi-number matters more than rework.

### 3.3 Columns added to existing tables

| Table | Change | Notes |
|---|---|---|
| `conversations` | add `whatsapp_number_id uuid` (FK, nullable → backfilled → NOT NULL) | unique index becomes `(account_id, contact_id, whatsapp_number_id)` |
| `messages` | none required (reachable via conversation); add `whatsapp_number_id` only if outbound-from-different-number within a conversation is allowed (D1) | |
| `message_templates` | add `waba_row_id` (FK); uniqueness `(waba_row_id, name, language)` replaces `(account_id, name, language)` | keep `account_id` for RLS |
| `broadcasts` | add `whatsapp_number_id` (required when the account has more than one number) | recipients inherit |
| `flows` / `automations` | optional `whatsapp_number_id` filter on triggers: null = all numbers | replies always go out through the conversation's number |
| `ai_configs` | unchanged (account-level) | |
| API keys / webhooks | unchanged; v1 API gains optional `number_id` / `from` parameter, default = default number | |

### 3.4 Security model
- RLS on both new tables: select `is_account_member(account_id)`, insert/update/delete `is_account_member(account_id,'admin')`, same as `whatsapp_config` today.
- Column privileges exactly like 063: `REVOKE SELECT … FROM authenticated`, then grant only non-secret columns; `access_token` unreadable by `authenticated` and `anon`, readable by `service_role`.
- Extend `080_credential_columns.test.sql` secret list and `CREDENTIAL_COLUMNS` in `credentials/server.ts` in the **same change**.
- Extend `010_coverage_meta` / `020_cross_tenant_matrix` / `030_role_matrix` so the new tables are covered (these tests are designed to fail on an unclassified table).
- Webhook cross-tenant rule unchanged: resolve by unique `phone_number_id`, then require `entry.id` = stored WABA id.

## 4. Behaviour rules

| Area | Rule (recommended) |
|---|---|
| Inbound | Webhook → `phone_number_id` → number row → account. Conversation key = (account, contact, number). |
| Outbound from inbox | Reply uses the conversation's number. New conversation requires choosing a number (default preselected). |
| Template send | Template must belong to the number's WABA; otherwise reject with a clear error. |
| Broadcast | Number is chosen on the wizard; templates list filtered to that WABA. Pacing/limits tracked **per number** (quality and tier), concurrency **per WABA** (see `04-master-plan` M8). |
| Flows & automations | Trigger may filter by number; sends go through the conversation's number. |
| AI reply | Account-level config; replies through the conversation's number. |
| Public API | `number_id` optional; default number when omitted; an unknown or foreign `number_id` returns 404. |
| Disconnect one number | Marks number disconnected; open conversations stay readable; sending blocked with a clear message. |
| Default number | Exactly one per account (partial unique index); deleting the default requires choosing another. |
| Media mirror setting | Per number (moved from `whatsapp_config.mirror_inbound_media`). |

## 5. Decisions needed

| ID | Question | Recommended default |
|---|---|---|
| D1 | Is a conversation bound to one number? Can an agent answer from a different number inside the same thread? | Bound to one number; a customer messaging two numbers gets two threads |
| D2 | Templates: owned by WABA, shown per number | Owned by WABA (matches Meta) |
| D3 | Broadcast: user must pick the number | Required when more than one number |
| D4 | Plan limits on number count | No hard limit in code until the commercial decision; read the limit from one config constant |
| D5 | Member visibility | All members see all numbers in v1; per-number ACL later |
| D6 | Where does the app-level verify token live? | One value per Meta app at deployment level (env), not per number; keep per-account tokens working during transition |
| D7 | Two tables (3.1) vs simpler (3.2) | Two tables |
| D8 | Existing `whatsapp_config` row becomes the first WABA + number; keep `whatsapp_config` readable until contract phase | Yes |
| D9 | Contacts shared across numbers inside an account | Yes (unchanged) |

## 6. Migration plan (expand → migrate → contract)

All steps are separate migrations, each reviewed, applied to staging first, with the usual order and pgTAP coverage. **Not started.**

| Step | Content | Rollback |
|---|---|---|
| M1 expand | Create `whatsapp_wabas`, `whatsapp_numbers` (RLS, 063-style column grants, realtime grants as needed). No app reads them yet. | drop tables |
| M2 backfill | One WABA + one number per existing `whatsapp_config` row. Rows with NULL `waba_id` need handling first (see audit below). | delete backfilled rows |
| M3 expand FKs | Add nullable `whatsapp_number_id` / `waba_row_id` to conversations, templates, broadcasts; backfill from the account's single number | drop columns |
| M4 app dual-read | App reads numbers tables; falls back to `whatsapp_config`; writes both | revert app |
| M5 switch | App reads only new tables; unique indexes on conversations and templates replaced; NOT NULL set | revert app, recreate old indexes |
| M6 contract | Stop writing `whatsapp_config`; later drop it (separate approval) | restore from backup |

**Pre-backfill data audit (read-only, to be run later with approval):** number of `whatsapp_config` rows, rows with NULL `waba_id` (these block the WABA cross-check and the WABA-level model), duplicate `phone_number_id`/`waba_id`, conversations per (account, contact) and templates per (account, name, language) to confirm the new unique indexes will not collide.

## 7. Code impact (from grep of `src`; nothing changed)

| Area | Files (non-test) |
|---|---|
| Credential helper | `src/lib/credentials/server.ts` (+ allowlist in `guard.test.ts`) |
| Sending | `src/lib/whatsapp/send-message.ts`, `meta-api.ts` (callers pass the number), `src/lib/whatsapp/resolve-conversation.ts` |
| Flows and automations | `src/lib/flows/meta-send.ts`, `src/lib/automations/meta-send.ts`, `src/lib/flows/engine.ts` |
| Broadcast | `src/app/api/whatsapp/broadcast/route.ts`, `src/lib/whatsapp/broadcast-core.ts`, `broadcast-resume.ts`, `src/hooks/use-broadcast-sending.ts`, `src/app/(dashboard)/broadcasts/new/page.tsx` |
| Templates | `src/app/api/whatsapp/templates/{submit,sync,[id]}/route.ts`, `template-webhook.ts`, template UI under `src/components/settings/` |
| Webhook | `src/app/api/whatsapp/webhook/route.ts`, `src/lib/whatsapp/webhook-routing.ts` |
| Config and health | `src/app/api/whatsapp/config/route.ts`, `config/verify-registration/route.ts`, `health/route.ts`, `react/route.ts`, `media/[mediaId]/route.ts` |
| Public API | `src/lib/api/v1/contacts.ts`, `src/app/api/v1/conversations/**`, `src/lib/api/v1/conversations.ts` |
| UI | `src/components/settings/whatsapp-config.tsx`, `settings-overview.tsx`, `src/app/(dashboard)/inbox/page.tsx`, inbox list and composer (number badge/filter, number picker) |
| Docs | `docs/multi-waba.md`, `docs/public-api.md` |

## 8. Test plan

- pgTAP: RLS and cross-tenant matrix for both new tables; column privileges (080-style); unique indexes (default per account, number per WABA); conversation uniqueness per number; backfill idempotency.
- Unit: number resolution from webhook (match, WABA mismatch, unknown number, two numbers same account), send-through-conversation-number, template/WABA mismatch rejection, default-number rules, API `number_id` ownership.
- Integration (mock Graph): connect second number, send from each, disconnect one, inbound on both.
- Existing suites must stay green; security guard test updated for the new credential reader.
- Staging manual with two Meta test numbers before any customer.
- No hosted verification claims without recorded output.

## 9. Acceptance criteria

1. An admin can add a second number to an account; each number shows status, label and default flag.
2. Inbound messages on either number land in the correct account and number-specific conversation; no cross-tenant routing (existing WABA cross-check preserved).
3. Replies, flows, automations and AI replies leave through the conversation's number.
4. A broadcast uses the chosen number and only that WABA's templates.
5. No member-readable credential column; pgTAP 080 passes with the new secrets registered.
6. Existing single-number accounts behave exactly as before after M5 (backfilled, no action needed).
7. Rollback of every migration step is documented and tested on a non-production database.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Big surface (~35 sites) | Expand/contract with dual-read, one area per PR |
| Duplicate conversations or colliding unique indexes during switch | Pre-backfill audit, collision queries before M5 |
| NULL `waba_id` rows | Fix data before M2, or block those accounts' migration until corrected |
| Token duplicated or lost during backfill | Copy ciphertext as-is (no decrypt), verify decrypt in staging, keep `whatsapp_config` until contract |
| Realtime/RLS gaps on new tables | Reuse `061`/`065` patterns; extend coverage tests |
| Quality/tier tracking per number needs Meta calls | Informational in v1; pacing work stays in M8 |
| Branch ambiguity (staging app may point at production) | Reconcile first; do not apply any step until resolved |

## 11. Out of scope for this spec
Embedded Signup and Coexistence UI (see doc 06), per-number member ACLs, per-number billing, number porting, WhatsApp Calling, catalog.
