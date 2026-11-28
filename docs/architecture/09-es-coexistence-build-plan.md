# 09 — Embedded Signup v4 + Coexistence: build plan

Status: **PLAN ONLY. Nothing here is implemented, migrated, deployed or applied.** Written 2026-11-28 from a read-only audit of the repository at branch `feat/l1-rlb-branding`.
Companion to `06-embedded-signup-coexistence-plan.md` (the "what/why") and `07-multi-number-design-spec.md` (data model). This file is the "exact gaps and the smallest shippable slices".

> Numbering: this is doc **09**. (The same text exists as `08-es-coexistence-build-plan.md` in the main checkout; `08-f2-tenancy-design.md` is a different document.)

Meta API names, event names, field names and limits are written from doc 06 and general knowledge of Meta's docs. **Every item marked (verify) must be re-read in the current Meta documentation before the slice that uses it is coded.** Next.js in this repo has breaking changes (`AGENTS.md`): before writing any route handler, header or client-component code, read the matching guide in `node_modules/next/dist/docs/`.

Hard rules carried from the tracker: official Meta Cloud API only; no unofficial QR/Baileys; do not touch the WhatsApp Business App number `+91 90252 77860`; no migration is applied without explicit approval and a staging-first run; no secret is ever printed, logged, sent to the browser or committed.

---

## Owner decisions 2026-11-28

1. Embedded Signup may ship before multi-number (M1), behind the `connection-store` interface (storage over `whatsapp_config` now, `whatsapp_numbers` later).
2. The coexistence rejection ("partner cannot connect Business App numbers yet") will be raised with Meta by the owner. S4/S5/S7 stay dark and mock-tested until it is lifted.
3. Code reads `META_ES_APP_SECRET` from the environment. Setting it on staging needs a separate approval.
4. A server-generated PIN, if stored, is stored only encrypted at rest with the existing token-encryption helper, never returned to the client and never logged. Whether Meta needs it again for re-registration is (verify).
5. No interim `connection_events` column. Wait for the F4 audit log. (This supersedes the `connection_events` mentions in S2 and open question 5 below.)

## 0. Repository facts that change the plan (found during the audit)

| # | Fact | Evidence | Consequence |
|---|---|---|---|
| F-1 | `registerPhoneNumber` is called **only when a PIN is supplied**; with no PIN the save succeeds with `registration_skipped: true` and `registered_at = NULL` | `src/app/api/whatsapp/config/route.ts:431-463` | A coexistence number that is saved without a PIN is *always* shown as "Not registered" |
| F-2 | The Settings UI derives "Registered / Not registered" **only** from `config.registered_at`, and the PIN field and `noRegistrationHint` ("Enter the 2-step PIN below…") are always shown | `src/components/settings/whatsapp-config.tsx:124, 648-710, 833-852`; `messages/en.json:1870-1877` | This is the bug in item 4 of the task |
| F-3 | `verify-registration` computes `live = phone_metadata_ok && waba_subscribed && locally_marked_registered` | `src/app/api/whatsapp/config/verify-registration/route.ts:147-150` | A coexistence number can **never** report `live: true`, even when fully working |
| F-4 | `META_APP_SECRET` is a **comma-separated list** (several apps) and `META_APP_ID` is a single server-only value | `docs/multi-waba.md`; `config/route.ts:213`; `webhook-signature.ts` | The OAuth code exchange needs *the* secret of the Embedded Signup app. Picking "the first of the list" is a latent bug. Needs an explicit `META_ES_APP_SECRET` (or a documented rule: the secret paired with `META_APP_ID`) |
| F-5 | `requireRole('admin')` resolves the account from `profiles.account_id` / `profiles.account_role` (one "active" account per user). Memberships exist (`067_account_memberships.sql`, `068`, `069`) but `getCurrentAccount` is **not yet workspace-aware** | `src/lib/auth/account.ts:109-193` | "Server-verified workspace id" today = the account the server resolved for the session, bound into the signup session at start and **re-checked at finish**. Never an id taken from the request body. When the workspace-aware helper lands, swap it in without changing the flow |
| F-6 | One WhatsApp number per account (`whatsapp_config.account_id` UNIQUE, `017`); `phone_number_id` UNIQUE instance-wide (`013`) | doc 06 §4, doc 07 §1 | The first ES slice must write through an interface so storage can move to `whatsapp_numbers` (M1, not started) without rewriting the connect flow |
| F-7 | Graph version constant is `v21.0` | `src/lib/whatsapp/meta-api.ts:35` | ES v4 / coexistence endpoints and fields may need a newer version (verify). Tracker item R2 (bump) should precede or accompany S2 |
| F-8 | CSP is **report-only** and allows `script-src 'self'…`, `connect-src 'self' https://*.supabase.co` | `next.config.ts:39-63` | Loading `https://connect.facebook.net` SDK and the popup will be reported (and blocked if CSP is ever enforced). Needs a deliberate allow-list change in S3 |
| F-9 | The webhook handles `statuses`, `messages` and template fields only. No coexistence fields (`history`, `smb_app_state_sync`, `smb_message_echoes`, verify names) and no account/offboarding events | `src/app/api/whatsapp/webhook/route.ts:422-470` | Echoes of messages typed in the Business app would be dropped silently |
| F-10 | The webhook verify-token handshake accepts any `whatsapp_config.verify_token`. An ES-created row has no customer-typed verify token | `webhook/route.ts:174-240`; doc 07 D6 | The callback URL and verify token are **app-level** in Meta; ES rows must not depend on a per-row token (move to a deployment-level value, D6) |
| F-11 | Tracker "last migration = 065" is stale: the repo has `066`–`069` | `supabase/migrations/` | New proposals below start at **070**; confirm before use |
| F-12 | Feature-flag convention is a server-side env var read at call time (e.g. `WHATSAPP_REQUIRE_STORED_WABA`), not a flag service | `webhook/route.ts:334` | Use env flags; do **not** bake flags into `NEXT_PUBLIC_*` (these are build-time and need an image rebuild — tracker P1.6) |
| F-13 | Tracker: Coexistence test was **rejected by Meta**: "partner cannot connect Business App numbers yet" | `MASTER-TASK-TRACKER.md` T7 | Path B cannot be end-to-end tested until Meta lifts this. Path B code can be built and unit-tested against mocks only |

---

## 1. Gap list: current code vs doc 06

Legend: ✅ exists · 🟡 partial · ❌ missing.

### 1.1 Doc 06 §5.2 server steps

| Doc 06 step | State | What exists / what is missing |
|---|---|---|
| Signup session (single-use, TTL, bound to user + account) | ❌ | No table, no API. (`whatsapp_signup_sessions` is only proposed in doc 06 §7) |
| Exchange `code` → business token server-side | ❌ | No `/oauth/access_token` helper in `meta-api.ts`. Needs app id + the right secret (F-4) |
| Verify WABA and phone number belong to the token | 🟡 | `listWabaPhoneNumbers` + `phoneNumberBelongsToWaba` (`waba-pairing.ts`) exist and are used by the manual flow. **Missing:** `debug_token` / granular-scope check that the token is actually granted *this* WABA, and a check that ids came from Meta not the browser |
| Refuse number already claimed by another account | ✅ | `config/route.ts:314-337` (service-role lookup). Must be reused, not copied (extract to a shared function) |
| Subscribe WABA to app | ✅ | `subscribeWabaToApp` (`meta-api.ts:284`). Missing: optional `override_callback_uri` (verify), unsubscribe for disconnect |
| Register number if required (PIN) | 🟡 | `registerPhoneNumber` exists; PIN is user-typed. **Missing:** server-generated PIN for path A, and a hard **skip** for coexistence numbers (F-1) |
| Register webhook fields incl. coexistence echo/state-sync (verify names) | ❌ | Nothing in code |
| Encrypt + store token; store connection method and status | 🟡 | `encrypt` + `whatsapp_config.access_token` exist. **Missing columns:** `connection_method`, `coexistence`, `connection_status`, `token_kind`, `token_expires_at`, `connected_by` |
| Coexistence history/contacts sync handling | ❌ | Nothing (F-9) |
| Audit event for the connection | ❌ | No `audit_logs` table (tracker F4). Minimal substitute proposed in S2 |

### 1.2 Doc 06 §8 work items

| ID | State | Notes |
|---|---|---|
| ES-1 data model | ❌ | Undecided; M1 (`whatsapp_numbers`) not started; D1–D9 unapproved |
| ES-2 signup session API | ❌ | |
| ES-3 client component (SDK loader, popup, session-event capture) | ❌ | No `FB.login` / SDK code anywhere in `src` (grep: no match). CSP change needed (F-8) |
| ES-4 finish endpoint | ❌ | |
| ES-5 coexistence webhook fields | ❌ | F-9 |
| ES-6 disconnect / offboarding / reconnect | 🟡 | Only a hard `DELETE /api/whatsapp/config` that deletes the row. It does **not** unsubscribe the WABA, does not handle Meta-initiated offboarding |
| ES-7 20 mps throughput awareness | ❌ | Broadcast pacing is not number-type aware |
| ES-8 token lifecycle | ❌ | `GET /config` detects a corrupt token only. No expiry / revocation detection |
| ES-9 copy, i18n, consent | ❌ | Four locales must move together (`messages.test.ts` parity) |
| ES-10 staging tests | ❌ | Blocked on Meta (F-13) for path B |

### 1.3 Things that are fine and must not be broken

Manual connect (path C) stays working and unchanged by default; webhook signature check and `phone_number_id`/WABA cross-check (`781401a`); column-privilege protection of `access_token` (`063`) and the `080` fail-closed test; `fetchWhatsAppConfig` as the single credential reader (`src/lib/credentials/server.ts`, guarded by `guard.test.ts`).

---

## 2. Connect flow design

### 2.1 Common (both paths)

```
Browser (admin)                     RLB server                          Meta
 click "Connect WhatsApp"
   ── POST /api/whatsapp/connect/start ─► requireRole('admin'); rate-limit;
                                        create session {account_id, user_id,
                                        state_hash, expires_at=+10min, status=pending}
   ◄── { state, appId, configId, mode } (appId/configId from server env at runtime)
 load Meta JS SDK, FB.login({config_id, response_type:'code',
   override_default_response_type:true, extras:{...}})   (verify exact v4 params)
 popup ─────────────────────────────────────────────────────────────────► user completes
 ◄── code (FB.login callback) + window 'message' event WA_EMBEDDED_SIGNUP
     {event: FINISH | CANCEL | ERROR, data:{waba_id, phone_number_id, ...}} (verify)
   ── POST /api/whatsapp/connect/finish {state, code, [hints: waba_id, phone_number_id]} ─►
                                        1. re-check session user == caller, still admin of
                                           session.account_id, not expired, status=pending
                                        2. atomic claim (pending→exchanging)
                                        3. exchange code (server secret) ─────────────► token
                                        4. verify granted WABA via debug_token, list numbers
                                        5. ids from Meta override browser hints
                                        6. branch: path A / path B (below)
                                        7. persist, mark session completed, audit
   ◄── { status, steps[] }  (never a token, never the code)
```

Rules that apply to every step:

* **Tenant binding.** The account id comes from the session row created at `start` from `requireRole`'s server-resolved context (F-5). `finish` loads the session by `state_hash`, then re-verifies *the same* user is still `admin`/`owner` of **that** account (membership table once workspace-aware, `profiles` today). The request body never carries an account id. A body `waba_id` / `phone_number_id` is a **hint only**; ids used for writes come from Meta responses.
* **Secrets never client-side.** The browser only ever holds the opaque `state`, the short-lived `code` (sent once, never stored or logged) and Meta's public ids. App secret, business token and any PIN stay server-side; token is stored encrypted via `encrypt()` and read only through `fetchWhatsAppConfig`. Responses and logs carry step names, Meta error code/subcode/`fbtrace_id` (the existing `explainMetaError` shape) and **no payloads or tokens**.
* **Token exchange.** Server `GET {graph}/oauth/access_token` with `client_id`, `client_secret` (the Embedded Signup app's secret, see F-4) and `code` (verify whether `redirect_uri` is needed for the JS-SDK flow). The code is single-use and very short-lived: exchange immediately in `finish`, before any other await.
* **Ownership verification.** `GET /debug_token` with an app access token, confirm `app_id` equals ours and `granular_scopes` (messaging + management) list the WABA; then `listWabaPhoneNumbers` must contain the phone id. Any mismatch → fail closed, nothing stored.
* **Already-claimed check.** Same rule as today (a `phone_number_id` linked to another account → 409). Also applies to the WABA once `whatsapp_wabas` exists.
* **WABA subscribe.** `subscribeWabaToApp` (idempotent). Webhook callback URL and verify token are app-level in Meta; the server only ensures the WABA is subscribed and (verify) requests the needed fields.
* **Idempotency.**
  * Session is a state machine: `pending → exchanging → connected | needs_attention | failed`, with a `completed_steps` jsonb (no secrets). Claim is a single conditional `UPDATE … WHERE state_hash=$1 AND status='pending' AND expires_at>now() RETURNING *`, so a double-click or replay gets 409, not a second exchange.
  * The code can be exchanged only once, so the **token is persisted (encrypted) immediately after step 4**, with status `pending_setup`. Steps 6–7 are individually idempotent (subscribe, register, field subscribe, upsert on `(account_id, phone_number_id)`). If one fails, `POST /connect/resume` re-runs the remaining steps from the stored token, with no new code needed.
  * Finish for a number already connected to the same account is a no-op success.
* **Failure handling.** Every Meta call reuses `explainMetaError`; new `MetaConnectStep` values: `exchange_code`, `debug_token`, `subscribe_waba`, `register`, `sync_request` (the first four are new, `subscribe_waba` exists).

### 2.2 Path A — new number / existing Cloud API number

1. Steps 1–5 above; detect "not on the Business app" (phone `platform_type` / signup event, verify).
2. Subscribe WABA.
3. **Register** the number with a server-generated 6-digit PIN (`registerPhoneNumber`, existing helper). Store the PIN encrypted in a new classified secret column only if Meta requires it for later re-registration (verify; see open question 4). The user never types a PIN.
4. Persist `connection_method='embedded_signup'`, `coexistence=false`, `registered_at=now()`, `subscribed_apps_at=now()`.
5. If `/register` fails with "not available for SMB businesses" (or the equivalent code, verify), do **not** fail: re-classify as path B (defensive guard in case detection in step 1 missed).

### 2.3 Path B — Coexistence (number already on the WhatsApp Business app)

1. Steps 1–5 above. Coexistence is identified from the ES `extras` the server asked for at `start` (`featureType` for business-app onboarding, verify) **and** confirmed from Meta (phone-number `platform_type` or the signup session event, verify). The browser's claim alone is never trusted.
2. Subscribe WABA. Subscribe the coexistence webhook fields (verify names: `smb_message_echoes`, `smb_app_state_sync`, `history`).
3. **Never call `/register`, never ask for or generate a PIN.** Hard-coded invariant in the finish pipeline: `if (coexistence) skip(register)`, covered by a unit test that fails if `registerPhoneNumber` is invoked for a coexistence session.
4. Persist `connection_method='coexistence'`, `coexistence=true`, `registered_at = NULL`, `connection_status='connected'`. **`registered_at` stays NULL by design** — the UI must not treat it as a fault (section 4).
5. Request history/contacts sync from Meta inside Meta's allowed window (verify; reported as 24 h after onboarding) and record `sync_requested_at`. Store progress in `completed_steps`. A sync failure sets `needs_attention` with a retry button; it does not disconnect.
6. Show the customer the disclosure (20 mps cap, groups not synced, broadcast lists read-only, disappearing/view-once off — doc 06 §3) **before** they open the popup, with a consent checkbox recorded in the session.

### 2.4 What stays unchanged

Path C (manual token connect) is the fallback; `POST /api/whatsapp/config` is not modified in S1–S4 except for the shared "claimed by another account" helper extraction and the status fields of section 4.

---

## 3. Smallest MVP slices

Each slice ships independently, is **off by default**, and can be reverted by turning off its flag or reverting its PR. Flags are server-side env vars (F-12). All slices keep the existing manual flow working.

Flag set: `WA_STATUS_V2`, `ES_CONNECT_ENABLED`, `ES_CONNECT_ACCOUNT_ALLOWLIST` (comma list of account ids; empty = nobody; used to let only the owner's own account see the button before Meta approval), `ES_COEXISTENCE_ENABLED`.

### S0 — Settings status fix [IMPLEMENTED on branch feat/es-s0-status-v2, not deployed] (no change to existing Meta calls; adds one best-effort read-only Graph call; **no migration**) · flag `WA_STATUS_V2`

* **Why first:** removes the misleading "Not registered / enter PIN" for coexistence/SMB numbers today, for manually connected ones too.
* **Files:** `src/app/api/whatsapp/config/route.ts` (GET: add `connection_kind`, derived); `src/lib/whatsapp/meta-api.ts` (new best-effort `getPhoneConnectionKind` for `platform_type`-style fields, in a **separate** request so an unknown field on v21 cannot break the existing verify call, same pattern as `getPhoneNumberHealth`); `src/app/api/whatsapp/config/verify-registration/route.ts` (fix F-3); `src/components/settings/whatsapp-config.tsx`; `messages/{en,pt,es,ko}.json`; a pure `src/lib/whatsapp/connection-status.ts`.
* **Tests:** unit table for the status matrix (section 4); route tests for GET and verify-registration with mocked Graph; component test: coexistence ⇒ no PIN field and no "Not registered" banner; `messages.test.ts` parity.
* **Tenant isolation:** none changed (same account-scoped reads). Added field comes from Graph with the caller's own token.
* **Migration impact:** none. Kind is derived at read time. (Persisting it is S2.)
* **Rollback:** unset flag → old UI/logic; or revert PR.

### S1 — Server foundations (no public endpoint, no UI) · flag `ES_CONNECT_ENABLED` (inert)

* **Files:** `src/lib/whatsapp/meta-api.ts` (add `exchangeCodeForToken`, `debugToken`, `getWabaPhoneNumberDetails`, `unsubscribeWabaFromApp`, all named-args style); new `src/lib/whatsapp/embedded-signup/{session.ts,finish.ts,connection-store.ts}`; `src/lib/env/validate.ts` (optional ES env: `META_APP_ID` + `META_ES_APP_SECRET` + `META_ES_CONFIG_ID`, only validated when the flag is on); extract the "claimed by another account" check from `config/route.ts` into `src/lib/whatsapp/claim.ts` (route behaviour unchanged, covered by existing `config/route.test.ts`).
* `connection-store.ts` is the **storage interface** (`getByAccount`, `upsertConnection`, `markStatus`): implemented over `whatsapp_config` now, over `whatsapp_numbers` after M1. This is how ES stays decoupled from the multi-number migration (open question 1).
* **Migration proposal 070 (NOT applied):** `whatsapp_signup_sessions` (`id`, `account_id` FK, `user_id`, `state_hash` UNIQUE, `mode` enum-ish text, `status`, `completed_steps jsonb`, `consent_at`, `expires_at`, `used_at`, `created_at`); RLS: members of the account can SELECT own-account rows without `state_hash`, **no** INSERT/UPDATE/DELETE for `authenticated` (server uses service role / SECURITY DEFINER RPCs); explicit column grants in the `061`/`063` style; add to `010_coverage_meta`, `020_cross_tenant_matrix`, `030_role_matrix`.
* **Tests:** unit with mocked `fetch` for each new helper (success, Meta error envelope, malformed JSON); session lifecycle (expired, replayed, foreign user, foreign account, downgraded role at finish); env validation; `guard.test.ts` still green; secret-never-in-output test (serialise results and assert no token / secret / code substring). pgTAP for 070: cross-tenant read denied, no direct writes, no browser-readable `state_hash`.
* **Tenant isolation:** new table is tenant-keyed with RLS and covered by the matrix tests; no existing table changes.
* **Rollback:** nothing calls the code; delete the files / `DROP TABLE whatsapp_signup_sessions` (it holds no business data).

### S2 — Start/finish endpoints, path A, behind allowlist · flag `ES_CONNECT_ENABLED` + `ES_CONNECT_ACCOUNT_ALLOWLIST`

* **Files:** `src/app/api/whatsapp/connect/start/route.ts`, `…/finish/route.ts`, `…/resume/route.ts`; reuse `RATE_LIMITS.whatsappAdmin`; `requireRole('admin')`; `src/lib/whatsapp/embedded-signup/finish.ts` (pipeline).
* **Migration proposal 071 (NOT applied):** extend `whatsapp_config` with nullable `connection_method text`, `coexistence boolean default false`, `connection_status text`, `token_kind text`, `token_expires_at timestamptz`, `connected_by uuid`. Non-secret columns added to the `063` grant list and `public-columns.ts`. If a PIN must be stored, add `two_step_pin` as a **secret** column: revoke from `authenticated`, add to `CREDENTIAL_COLUMNS` and `080_credential_columns.test.sql` in the same change.
* **Tests:** full finish flow with mocked Graph (A happy path; exchange failure; debug_token mismatch; phone not under WABA; number claimed elsewhere → 409; subscribe failure → resumable; register failure → resumable; double finish; concurrent finish; session of another account; role downgrade between start and finish; body-supplied account id ignored); response never contains secrets; log capture shows none.
* **Tenant isolation:** the central risk of the whole feature. Mitigated by server-derived account, session binding, re-verification at finish and the existing claim check. Add negative tests to the cross-tenant matrix.
* **Rollback:** unset flag (endpoints return 404); columns are nullable/additive and ignored by old code; revert PR. Connected rows already created remain valid manual-style rows.

### S3 — Client "Connect WhatsApp" (path A UI) · flag `ES_CONNECT_ENABLED`

* **Files:** `src/components/settings/whatsapp-connect-button.tsx` (SDK loader, `FB.login`, `message` listener, progress, retry), mounted in `whatsapp-config.tsx` above the manual form (manual form moved under "Advanced / manual"); `next.config.ts` CSP (report-only first): `script-src https://connect.facebook.net`, `frame-src`/`connect-src` for Meta's login/ES hosts (verify exact hosts), keep `frame-ancestors 'none'`; `messages/*.json`.
* The component receives `appId`/`configId` from `connect/start` at runtime (no `NEXT_PUBLIC_*` bake, F-12). The `message` listener must check `event.origin` (Meta origins only, verify) and ignore anything without a pending `state`.
* **Tests:** component tests with a mocked SDK and `postMessage`: wrong origin ignored; CANCEL; ERROR; FINISH then finish call; double click; locale parity. Manual staging run with the owner's account (section 5).
* **Tenant isolation:** none beyond S2.
* **Migration impact:** none.
* **Rollback:** unset flag; CSP edit is report-only and revertable.

### S4 — Coexistence connect (path B server) · flag `ES_COEXISTENCE_ENABLED`

* **Files:** extend `embedded-signup/finish.ts` with the coexistence branch (skip register, field subscribe, sync request, disclosure consent), `start` returns `mode:'coexistence'` extras; chooser in the connect component ("My number is on the WhatsApp Business app").
* **Migration:** none beyond 071 (`coexistence`). Optionally `sync_requested_at` in 071.
* **Tests:** the invariant test (register never called); detection from Meta response rather than browser; fallback re-classification on the "not available for SMB" error; sync-request failure leaves the number connected with `needs_attention`.
* **Real-world test is blocked by Meta (F-13).** Ship dark; unit-tested against mocks only until Meta lifts the restriction.
* **Rollback:** unset flag.

### S5 — Coexistence inbound: echoes, state sync, history · flag `ES_COEXISTENCE_ENABLED`

* **Files:** `src/app/api/whatsapp/webhook/route.ts` (new `change.field` branches before the messages branch at ~`:447`), new `src/lib/whatsapp/coexistence-webhook.ts`; reuse `resolveAccountForPhoneNumber(phone_number_id, entry.id)` so the WABA cross-check applies to every new field.
* **Migration proposal 072 (NOT applied):** `messages.source` (e.g. `'cloud_api' | 'business_app_echo' | 'history_sync'`, default `'cloud_api'`) and, if not already present, a unique index guaranteeing no duplicate per `(account_id, wa_message_id)` (**verify first** that the index exists; a duplicate-producing history import is the main data risk). Backfill is a default value, no data rewrite.
* **Tests:** echo creates an outbound message with the right conversation and **no** auto-reply/flow/AI trigger (echoes must not run automations; add an explicit test); replayed echo/history batch is idempotent; history for contacts unknown to the account; WABA mismatch rejected; payload with another account's phone id ignored.
* **Tenant isolation:** new inbound paths are the second biggest risk; every one must resolve the account through the existing cross-checked resolver, never from payload-supplied account hints.
* **Rollback:** unset flag (new branches skipped, events ignored as today); `source` column is additive.

### S6 — Disconnect, offboarding, reconnect, token health · flag `ES_CONNECT_ENABLED`

* **Files:** extend `DELETE /api/whatsapp/config` to unsubscribe the WABA before deleting the token (best effort, logged); webhook handler for Meta account/offboarding events (verify names) → `connection_status='needs_attention'`; `GET /config` detects revoked/expired token (`debugToken`); UI "Reconnect" (re-runs ES in reconnect mode, doc 06 §12 sources); `token_expires_at` surfaced.
* **Tests:** unsubscribe failure does not block local delete; offboarding event sets status only for the resolved account; reconnect keeps conversations.
* **Tenant isolation:** offboarding/account events resolve the account only through the cross-checked resolver (`phone_number_id` + WABA); a payload for another account's number is ignored.
* **Migration impact:** none (uses 071 columns).
* **Rollback:** unset flag; old hard-delete behaviour remains the default.

### S7 — Throughput and disclosure (coexistence) · flag `ES_COEXISTENCE_ENABLED`

* Pacing cap of 20 mps for `coexistence=true` numbers in `broadcast-core.ts`/`broadcast-resume.ts`; in-product explanation of what changes with coexistence; consent text (needs legal drafts live, tracker R3).
* **Tests:** pacing unit tests; copy parity across 4 locales.
* **Tenant isolation:** none (per-number pacing only).
* **Migration impact:** none.
* **Rollback:** unset flag.

**Order and dependencies:** S0 (anytime) → S1 → S2 → S3 (first end-to-end test with role users) → S4 → S5 → S6 → S7. M1 (multi-number) is independent: when it lands, only `connection-store.ts` changes.

---

## 4. Settings UI fix proposal (S0)

### 4.1 Problem (exact)

For a coexistence/SMB number: no PIN exists and `/register` must not be called (Cloud API answers "not available for SMB businesses"). Today `registered_at` is NULL, so the UI shows the amber **"Not registered — Meta will not deliver events"** banner, tells the user to **"Enter the 2-step PIN below"**, shows the PIN field, and `verify-registration` can never return `live` (F-1, F-2, F-3).

### 4.2 Derived status (single pure function)

`deriveConnectionStatus({ connectionMethod, coexistence, platformKind, registeredAt, lastRegistrationError, wabaSubscribed, phoneMetadataOk, tokenOk })`:

| Condition | UI state | Banner (en) | PIN field | "Verify with Meta" |
|---|---|---|---|---|
| `coexistence` or `platformKind = business_app` | `coexistence_live` (if WABA subscribed) / `coexistence_attention` (if not) | "Connected with the WhatsApp Business app (Coexistence). Messages sync with your phone. No PIN is needed." | **hidden** | shown; runs the coexistence check |
| Cloud API, `registered_at` set | `registered` | existing "Registered" text | shown (unchanged from today; S0 hides the PIN only for coexistence / test numbers) | shown |
| Cloud API, `registered_at` NULL, `last_registration_error` set | `registration_failed` | existing failed text + retry | shown | shown |
| Cloud API, `registered_at` NULL, no error, kind known | `awaiting_registration` | existing hint | shown | shown |
| Kind **unknown** (Graph field unavailable on this Graph version, call failed, or no config row yet) | `unknown` | neutral: "Registration status could not be determined. Click Verify with Meta." No "Meta will not deliver events" wording. | **shown, optional**, neutral wording ("only needed for a Cloud API number you are registering yourself") | shown |
| Meta test number (manual, no PIN, already pre-registered; issue #242) | `test_number` | "Test number: Meta pre-registers these. No PIN is needed." | hidden | shown |

**Rule:** the PIN field is hidden only when the number is *positively* identified as coexistence/business-app or as a Meta test number. Uncertainty never hides it, because a real Cloud API production number connected manually (path C) still needs `/register` with a PIN (issue #136). The first-time manual save (no config row yet) therefore always shows the PIN field. Component tests must cover: no-config form, unknown kind, positively identified coexistence, test number.


### 4.3 Concrete changes

1. `GET /api/whatsapp/config` returns `connection_kind` (derived from a separate best-effort Graph read; never blocks `connected`).
2. `verify-registration`: `live = phone_metadata_ok && waba_subscribed_to_app && (coexistence ? true : locally_marked_registered)`; response gains `connection_kind` and a `checks` set without `locally_marked_registered` for coexistence.
3. `whatsapp-config.tsx`: render by `deriveConnectionStatus`; hide the PIN `Input` and `pinHint` only for `coexistence_*` and `test_number`; keep it (optional) for `awaiting_registration`, `registration_failed`, `unknown` and the no-config form; replace `noRegistrationHint` for coexistence/unknown.
4. New i18n keys in **all four** locales together (parity test) — `coexistenceLive`, `coexistenceLiveDesc`, `coexistenceAttention`, `statusUnknown`, `testNumber…`.
5. `POST /config` for a manual save with no PIN: keep the current behaviour (no `/register`), but return `connection_kind` so the toast says "Connected (Coexistence — no PIN needed)" instead of `savedRegistrationSkipped` when applicable.

Note: the `dangerouslySetInnerHTML` on `pinHint`/`subscribedSince` is unchanged by this plan; it renders locale-file text only, but keep any new keys plain text.

---

## 5. Meta external approvals vs what can be built and tested now

| Item | Needs Meta? | Status (tracker T7, *supplied*) | Blocks |
|---|---|---|---|
| Business Verification | external | approved | — |
| Tech Provider status | external | selected | production onboarding of other businesses |
| **App Review → Advanced access** (`whatsapp_business_messaging`, `whatsapp_business_management`) | external | **in review** | customers outside the app's own roles cannot grant permissions in ES |
| App in **Live** mode | external (after review) | — | any non-role user; webhooks from non-role businesses |
| Access Verification (cap 10 → 200 / 7 days) | external | not started | scale only |
| ES configuration (config id: permissions, feature types incl. business-app onboarding) | owner action in Meta dashboard | unknown | S3 test needs the id |
| Coexistence enablement for our partner | external | **rejected: "partner cannot connect Business App numbers yet"** | path B real test (S4/S5/S7) |
| Public Privacy / Terms / Data-Deletion URLs | owner + counsel | drafts on HOLD | App Review, consent text |
| Webhook callback reachable over HTTPS on staging | owner/infra | staging exists | any inbound test |

**Buildable and testable now, in development mode (no approval needed):**
S0, S1 and S2 entirely with mocked Graph (CI). S3 end-to-end on **staging** using users who hold a **role on the Meta app** (admin/developer/tester) connecting **their own** business, WABA and a Meta **test number** or a spare number: this exercises code exchange, WABA subscribe and webhook delivery for path A. S4/S5 can be fully unit-tested against recorded/handwritten payloads; real coexistence payloads need Meta (F-13). S6 token-revocation and S7 pacing are pure code. Do **not** use `+91 90252 77860` for any test.

**Not testable until Meta acts:** real customers outside app roles; coexistence onboarding of a real Business-app number; Advanced-access permission dialogs; onboarding cap behaviour.

---

## 6. Test strategy summary (all slices)

* Vitest unit/integration with mocked `fetch` (no live Meta in CI). Existing 1878-test suite stays green.
* pgTAP for 070/071/072 including 080-style column classification and the cross-tenant / role matrices.
* Security assertions, repeated in every slice: no secret in any response, log line or serialised object; request-body account ids ignored; foreign/expired/replayed `state` rejected; role re-checked at finish.
* Manual staging checklist (owner-run, results recorded in the tracker with evidence): role-user path A connect → inbound message → outbound send → disconnect.

---

## 7. Open questions for the owner (max 5)

1. **Ordering vs multi-number.** Doc 06 says multi-number (M1) lands first, but M1 is unapproved, blocked on the audit, and ES is blocked behind it. May S1–S3 ship first on today's one-number-per-account `whatsapp_config` through the `connection-store` interface (one connected number per account, a clear "already connected" error otherwise), with M1 swapping the storage later?
2. **Coexistence restriction.** Will you raise the "partner cannot connect Business App numbers yet" rejection with Meta support (and share their answer), or should S4/S5/S7 stay dark and mock-tested until it is lifted?
3. **App secret / app identity.** Is there exactly one Meta app for Embedded Signup (`972901605572832`)? May we add a dedicated `META_ES_APP_SECRET` (and `META_ES_CONFIG_ID`) rather than reusing the comma-list `META_APP_SECRET` (F-4)? Has the ES configuration (config id, feature types) been created in the Meta dashboard?
4. **PIN handling for path A.** Approve generating a random 6-digit PIN server-side at registration and storing it encrypted in a new secret column (so re-registration and recovery are possible), versus not storing it and accepting that re-registration needs the customer to reset two-step verification in Meta?
5. ~~Interim audit trail~~ — decided 2026-11-28: no interim column; wait for F4. Remaining: confirm migrations may be proposed as 070/071/072 for staging-only application once Phase 1 (staging DB) is done?
