# 01 — Current architecture audit (as-is)

> Status: Phase 1 deliverable, **review draft**. Everything here is derived
> from the repository at commit `c04f56d` (+ Phase 1 branding edits). It
> describes what **exists today**. Proposals live in
> [02-hybrid-saas-target-architecture.md](./02-hybrid-saas-target-architecture.md).
> Nothing in this document was run against a live database; RLS behaviour
> is read from migration SQL, not tested.

## 1. Stack

Next.js 16.4.6 (App Router) · React 19.2.4 · TypeScript 6 · Supabase
(Postgres 17, Auth, Storage, Realtime) · next-intl (en/pt/es/ko) ·
vitest. One Next.js app, one Supabase project per deployment.

## 2. Tenancy model today

The product is **already account-scoped multi-tenant**, introduced by
migration `017_account_sharing.sql`:

| Concept | Implementation (existing) |
|---|---|
| Tenant | `accounts` (`id`, `name`, `owner_user_id`) |
| User ↔ tenant | `profiles.account_id` + `profiles.account_role` — **exactly one account per user** |
| Roles | enum `account_role_enum`: `owner > admin > agent > viewer` |
| Authorization helper | `is_account_member(account_id, min_role)` — SECURITY DEFINER, reads `profiles` by `auth.uid()` |
| Tenant key on data | `account_id` column on 25 domain tables (plus `profiles` and `account_invitations`) |
| Signup | trigger `handle_new_user` creates a personal account + `owner` profile for every new auth user |
| Team invites | `account_invitations` (hashed token); `redeem_invitation` **moves** the user into the inviter's account and **deletes** their personal account |
| Ownership | `idx_accounts_one_per_owner` — a user can own **at most one** account; `transfer_account_ownership` RPC |
| Profile hardening | trigger `enforce_profile_privilege_columns` blocks direct edits of `account_id`/`account_role` (migration 055) |

Server side, API routes call `requireRole(min)` (`src/lib/auth/account.ts`),
which loads the caller's profile and returns `{ supabase, userId,
accountId, role }`. The browser client holds a single `accountId`
(`src/hooks/use-auth.tsx`). The public API (`/api/v1`) authenticates by API
key (hashed, scoped) bound to one `accounts` row.

### Tenant key coverage

| Has `account_id` | Scoped only through a parent join |
|---|---|
| contacts, tags, custom_fields, contact_notes, conversations, whatsapp_config, message_templates, pipelines, deals, broadcasts, automations, automation_logs, automation_pending_executions, flows, flow_runs, member_presence, api_keys, notifications, webhook_endpoints, ai_configs, ai_knowledge_documents, ai_knowledge_chunks, ai_usage_log, quick_replies, pending_message_statuses | **messages**, contact_tags, contact_custom_values, pipeline_stages, broadcast_recipients, automation_steps, message_reactions, flow_nodes, flow_run_events |

Example: `messages_select` is `EXISTS (SELECT 1 FROM conversations c WHERE
c.id = messages.conversation_id AND is_account_member(c.account_id))`.
Correct, but isolation of 9 tables depends on every join being right and
there is no database-level guarantee that a child row's parent belongs to
the same account.

## 3. RLS

- 37 tables, all with `ENABLE ROW LEVEL SECURITY`; 164 `CREATE POLICY`
  statements; 121 references to `is_account_member`.
- Pattern: read = viewer+, operational write = agent+, settings-class
  write = admin+ (`whatsapp_config`, `message_templates`, `ai_configs`,
  `api_keys`, …).
- 25 policy bodies (mostly `storage.objects`) bypass the helper and query
  `profiles` directly, matching `'account-' || account_id` path prefixes.
- 62 `SECURITY DEFINER` occurrences across migrations (RPCs for members,
  invitations, ownership, dashboards, engine counters).
- CI (`supabase/ci/verify-schema.sql`) is an existence smoke test.
  **There is no behavioural cross-tenant test** (no test that logs in as
  tenant A and proves tenant B rows are invisible). Existing
  `*-migration.test.ts` files assert on SQL text.

## 4. WhatsApp integration and credentials

- `whatsapp_config`: `phone_number_id`, `waba_id`, `access_token`
  (AES-256-GCM ciphertext), `verify_token` (encrypted by the config route),
  `UNIQUE(account_id)` → **one WhatsApp number per account**;
  `phone_number_id` unique instance-wide (migration 013).
- Inbound webhook (`/api/whatsapp/webhook`): HMAC-verified, then resolves
  the tenant by `phone_number_id` → `whatsapp_config` using the
  **service-role** client; all further writes are explicit
  service-role inserts carrying the resolved `account_id`.
- Encryption key: **one global `ENCRYPTION_KEY`** for every tenant's WhatsApp
  token and AI key; no key id/version column; rotating it orphans all
  tokens (documented in `.env.local.example`).
- Credentials are entered by pasting a token/phone-number-id; there is no
  Meta Embedded Signup flow.
- Meta API version hard-coded `v21.0` in two places.

## 5. Automations, flows, AI, API, MCP

- Automations/Flows: engine runs under the service role (`admin-client.ts`
  per module) and filters by the automation's `account_id`; cron endpoints
  protected by `AUTOMATION_CRON_SECRET` (`x-cron-secret`).
- AI: per-account BYO key in `ai_configs.api_key` (encrypted); knowledge
  base tables carry `account_id`; `ai_usage_log` records usage per account
  (a ready metering source). Messages are sent to the provider the tenant
  configured (OpenAI / Anthropic / OpenAI-compatible).
- Public API v1 + outbound webhooks: per-account, scoped keys, SSRF guard.
- **MCP server** (`mcp-server/`): a thin client of `/api/v1`; it holds no
  database access and inherits tenant isolation from the API key (one key →
  one account). Dependencies: `@modelcontextprotocol/sdk`, `zod`. Env vars
  and class names still use the `WACRM_` / `Wacrm` prefix. The root
  `tsconfig` also type-checks it, relying on a transitive install of the
  SDK (fragile; see 03 risks).

## 6. Billing / subscriptions

**None.** No plan, subscription, invoice, seat-limit, quota or payment
code exists (searched source, migrations, MCP). The only usage data is
`ai_usage_log`. Feature gating today is role-only plus an optional
`profiles.beta_features` array.

## 7. Audit logging

**No general audit log.** Existing partial records: `automation_logs`,
`ai_usage_log`, `member_presence`, per-row `user_id` author columns, and
`account_invitations.created_by_user_id/accepted_by_user_id`. Nothing
records role changes, WhatsApp config edits, API-key creation, exports or
cross-account access.

## 8. Agency / platform roles

**None.** No super-admin, agency, reseller or support-access concept
exists (searched `src/` and `supabase/`).

## 9. Findings relevant to tenant isolation

| # | Finding | Evidence | Severity (my assessment) |
|---|---|---|---|
| F1 | `whatsapp_config` rows (incl. encrypted `access_token` and `verify_token`) are SELECT-able by **any member incl. viewer** through PostgREST; the app's own routes may hide them, the database does not | `017…:421` `FOR SELECT USING (is_account_member(account_id))`; no later column-privilege change found | Medium — ciphertext only, but widens blast radius if `ENCRYPTION_KEY` leaks; should be admin-only |
| F2 | Same for `ai_configs.api_key` (viewer+ can SELECT, commented as intentional to show "Draft with AI") | `029…:63-67` | Medium |
| F3 | Single global encryption key for all tenants; no key versioning | `encryption.ts`, `.env.local.example` | Medium for SaaS; low for single-company use |
| F4 | One account per user and per owner blocks multi-workspace users (agency staff, owners of several businesses) | `profiles.account_id` single FK; `idx_accounts_one_per_owner`; `redeem_invitation` deletes the personal account | Architectural blocker for the hybrid model |
| F5 | 9 child tables lack `account_id`; isolation via joins only | §2 table | Low–Medium; fixable by denormalising |
| F6 | Service-role client used in 37 source files bypassing RLS; tenant filtering relies on each call site | `git grep` count | Medium; needs central wrapper + tests |
| F7 | In-memory rate limiter (per instance) | `src/lib/rate-limit.ts` | Medium for multi-instance SaaS |
| F8 | Invite-link fallback to `https://wacrm.tech` | `api/account/invitations/route.ts:137` | Low–Medium (third-party domain in a security-relevant link) |
| F9 | Storage policies read `profiles` directly instead of a shared helper (25 sites) — every future access change must touch them | migrations 043/055 | Maintainability |
| F10 | No behavioural RLS tests | §3 | Process gap — highest-leverage fix |

## 7b. Single-business assumptions (checklist)

1. One workspace per user (`profiles.account_id`; UI `useAuth().accountId`).
2. One owner-account per user (`idx_accounts_one_per_owner`).
3. Invite redemption destroys the user's previous account.
4. One WhatsApp number per account (`UNIQUE(account_id)` on `whatsapp_config`).
5. One global encryption key and one Meta app secret list per deployment.
6. Role names/hierarchy fixed (`owner/admin/agent/viewer`), no manager tier.
7. No tenant lifecycle states (suspended, trial, cancelled).
8. User-visible copy refers to "this instance" / self-hosting.
9. Storage: `avatars` is per-user; `flow-media`/`chat-media` per `account-<id>/`.
