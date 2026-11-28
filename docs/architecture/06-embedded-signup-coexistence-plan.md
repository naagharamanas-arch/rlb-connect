# 06 — WhatsApp onboarding plan: Embedded Signup + Coexistence

Status: **PLAN ONLY — no code, no migrations, nothing applied.** Written 2026-11-25.
Owner approval: the hybrid direction (official Cloud API + Embedded Signup + eligible Coexistence; no unofficial WhatsApp Web automation) was approved earlier; the owner confirmed on 2026-11-25 that this plan should be written.

**Owner decisions recorded 2026-11-25:**
1. **Multi-number is built BEFORE Embedded Signup / Coexistence** (resolves ES-1 and open question 4 in section 10). Option 2 in section 7 (`whatsapp_numbers`) is therefore the working direction; its detailed design still needs owner approval before any migration.
2. **The Meta external clock starts now** (Business Verification, then Tech Provider, then App Review). See section 2a.

Meta-specific API names, field names and limits below come from Meta's public
developer documentation as summarised in a web search on 2026-11-25. Meta changes
these often. **Every Meta detail marked (verify) must be re-read in the current Meta
docs before implementation.**

## 1. Goal

Let a customer connect WhatsApp to RLB Connect in a few clicks, without pasting
tokens, through Meta's official flows:

| Path | Who it is for | Experience |
|---|---|---|
| A. Embedded Signup (new or existing API number) | Customer with no WhatsApp Business app on the number | "Connect WhatsApp" → Meta popup → login, pick/create business + WABA + number, verify → connected |
| B. Coexistence | Customer already using the **WhatsApp Business app** on that number | Same popup; customer **scans a QR code with their WhatsApp Business app**; the number then works in the app **and** in RLB Connect |
| C. Manual token connect (existing) | Fallback, power users, agencies | Existing Settings screen (kept) |

Out of scope and **rejected**: unofficial WhatsApp Web / QR-session libraries
(account-ban risk, Meta ToS violation, no support path).

## 2. External critical path (not code; start first)

These are outside our control and gate production use of paths A and B.

1. **Meta Business Verification** for the RLB Solutions business. App Review cannot start before it.
2. **Tech Provider** status for the Meta app (currently app `972901605572832`, Development mode).
3. **App Review → Advanced access** for `whatsapp_business_messaging` and `whatsapp_business_management`. Until approved, these permissions do not appear in Embedded Signup and customers cannot grant them. Review needs videos: a message sent from our app and received in WhatsApp, and a template being created in our app.
4. **Access Verification** (raises onboarding cap). Default cap is **10 new business customers per rolling 7 days**; after verification + App Review + Access Verification it rises to **200** (verify).
5. Live **Privacy Policy, Terms, Data Deletion** URLs (legal drafts exist in `docs/legal/`, all on HOLD).
6. An **Embedded Signup configuration** in the Meta app (configuration ID, permissions, feature types).

Until 1–3 are done we can build and test only with Meta test numbers / the
developer-mode app, with our own business as the only customer.

## 2a. Meta kickoff checklist (owner actions; nothing here is done yet)

Start in this order. Each step is performed by the owner in Meta Business Suite / Meta for Developers; Claude cannot do it for you.

| # | Step | Notes / known risks |
|---|---|---|
| 1 | Confirm the **Meta Business portfolio** that owns app `972901605572832` is the RLB Solutions business | One portfolio must own the app and be the one verified |
| 2 | Start **Business Verification** (Business Settings → Security Center) | Needs legal business name, address, phone, email, website; Meta may ask for documents |
| 3 | Make the **legal name consistent** across portfolio, documents and website | Project records show proprietor name KANAGALAKSHMI and GST name RAMANALAKSHMI. A name mismatch is a likely cause of rejection, so decide which documents prove which name before submitting. GSTIN is still not checked against the certificate. |
| 4 | Use a **real website and domain email** (rlbsolutions.in, info@rlbsolutions.in) | Verification and App Review look at the site |
| 5 | Publish **Privacy Policy, Terms, Data Deletion** URLs | Required for App Review. The drafts in `docs/legal/` are on HOLD, so they need owner and counsel sign-off first. This can become the real bottleneck. |
| 6 | Apply to become a **Tech Provider** for the app | Only possible after step 2 completes |
| 7 | Prepare **App Review** assets: video of a message sent from our app and received in WhatsApp; video of creating a template in our app | Needs a working staging app with a Meta test number |
| 8 | Request Advanced access: `whatsapp_business_messaging`, `whatsapp_business_management` | Gates Embedded Signup for customers |
| 9 | Start **Access Verification** | Raises onboarding cap from 10 to 200 per rolling 7 days |

Dependencies inside our own work: steps 5 and 7 need the staging app stable and the legal pages live, which in turn depends on the Supabase branch reconciliation and 063/064 state.

## 3. Meta facts that shape the design (verify at build time)

- **Embedded Signup v2 was scheduled for deprecation on 8 or 15 Oct 2026** (Meta's
  pages disagree). That date has passed: **build against v4**.
- Coexistence requires the customer's **WhatsApp Business app version 2.24.17 or later**, a Solution Partner or **Tech Provider**, a working webhook, and **session logging** in the Embedded Signup integration.
- Coexistence limits: numbers used in both the app and Cloud API have a **fixed 20 messages/second** throughput; **group chats are not synced**; broadcast lists become **read-only**; disappearing messages, view-once, live location are turned off for 1:1 chats; calls, catalogs and channels are not supported on Cloud API.
- Country eligibility is per Meta's changelog; **numbers with an India dialing code are supported** for coexistence per the changelog (verify the full current list before promising it).
- A WABA that was originally created through the developer app cannot be onboarded through the Embedded Signup flow.
- Offboarded coexistence clients can be reconnected through a documented flow (verify).

## 4. Current state of the repository (facts)

| Fact | Evidence |
|---|---|
| One WhatsApp number per RLB account | `017_account_sharing.sql:312-326` (`whatsapp_config_account_id_key`) |
| A phone number can belong to one config only | `013_whatsapp_config_phone_number_id_unique.sql` |
| `waba_id` is nullable text; token encrypted in `access_token` | `001_initial_schema.sql:190-196`; `src/lib/crypto` usage in config routes |
| Token / verify token unreadable by browsers; read only via server helper | `063_credential_column_privileges.sql`; `src/lib/credentials/server.ts` |
| Manual connect: verify number, register (PIN), subscribe WABA to app | `docs/multi-waba.md`; `src/app/api/whatsapp/config/route.ts` |
| Webhook routes by `phone_number_id`, with WABA cross-check | `src/lib/whatsapp/webhook-routing.ts` (commit `781401a`, **not pushed**) |
| Several apps' secrets accepted | `META_APP_SECRET` comma list; `META_APP_ID` single value |
| Graph version constant | `src/lib/whatsapp/meta-api.ts:36` (v21.0; bump planned separately) |
| Planned in roadmap, not started | `04-master-plan-and-infrastructure.md` M8; `05-execution-decisions.md` ⚠7 |

## 5. Target user flows

### 5.1 Connect (path A/B)
1. Settings → WhatsApp → **Connect with WhatsApp** (admin/owner only).
2. Server creates a short-lived, single-use **signup session** bound to the account and user, returns an opaque `state` (never the account id from the browser).
3. Browser loads Meta's JS SDK and opens the Embedded Signup popup with our configuration ID and `state` in the extras.
4. Customer chooses: new number, existing API number, or **existing WhatsApp Business app number (coexistence)** and scans the QR in their app.
5. Popup returns an authorization **code** to the browser and a session event with `waba_id` and `phone_number_id` (verify event shape).
6. Browser posts `{code, state, waba_id, phone_number_id}` to our API. **The server does everything else.**
7. UI shows progress and final status (connected / needs attention).

### 5.2 Server steps after the popup (in one idempotent job)
1. Look up the signup session by `state`; reject if missing, expired, used, or the logged-in user/account differs. Mark used.
2. Exchange the `code` for a business token server-side with the app secret (never in the browser).
3. Verify with Graph that the WABA and phone number belong to this token (do not trust browser-sent ids).
4. Refuse if `phone_number_id` is already claimed by another account (existing rule).
5. Subscribe the WABA to our app, register the number if required, register webhook fields (coexistence adds echo/state-sync fields — verify names).
6. Encrypt and store the token; store connection method and status; derive display facts only.
7. For coexistence: start history/contacts sync handling as Meta delivers it (verify behaviour and time window).
8. Write an audit event for the connection (who, when, method) — there is no audit log in the product yet, so this depends on the audit-log work or a minimal table.

### 5.3 Disconnect / offboarding
- Customer-initiated disconnect: unsubscribe app from WABA, delete stored token, keep message history per retention policy.
- Meta-initiated (user removed the app, coexistence offboarded): handle the relevant webhook, mark connection `needs_attention`, show reconnect.

## 6. Security requirements

- Authorisation: only account admin/owner can start or finish a connection (`requireRole('admin')` pattern already used).
- Account id comes from the session, never the request body. `state` is single-use, short TTL, bound to user + account (CSRF/replay).
- Token exchange, token storage and all token reads happen server-side through `src/lib/credentials/server.ts`-style access; no secret ever reaches the browser or logs.
- New credential-bearing columns must be classified in migration 063's scheme; `080_credential_columns.test.sql` fails closed on an unclassified column.
- Webhook handling keeps signature verification and the `phone_number_id`/WABA cross-check from `781401a`.
- Rate-limit the start and finish endpoints; log without payload content.
- Do not store the customer's Meta user token beyond what is needed; document what is stored.

## 7. Data model proposal (NOT applied; needs owner approval and the multi-number decision)

Decide **first** whether Phase 1B multi-number lands before this feature. Embedded Signup naturally creates several numbers per business; today there is one per account.

| Option | Description | Trade-off |
|---|---|---|
| 1. Extend `whatsapp_config` | add `connection_method`, `connection_status`, `signup_session_id`, `token_expires_at`, `coexistence boolean`, `connected_by` | Fast; keeps one number per account |
| 2. New `whatsapp_numbers` (recommended if multi-number is a product requirement) | one row per number: account, phone_number_id, waba_id, encrypted token reference, method, status, quality/tier | Right shape; touches inbox, templates, broadcasts, webhook routing, and migration of existing rows |

Plus a small `whatsapp_signup_sessions` table (account_id, user_id, state hash, expires_at, used_at) with RLS and least-privilege grants following `061`.

Every migration here must follow the project order and **must not be applied until the Supabase branch mapping and 063/064 state are reconciled** (see the reconciliation audit).

## 8. Application work breakdown (for estimation; nothing started)

| ID | Work | Depends on |
|---|---|---|
| ES-1 | Decide data model (§7) and multi-number scope | owner decision |
| ES-2 | Signup session API (create, validate, consume) + tests | ES-1 |
| ES-3 | Client component: SDK loader, popup launch, session-event capture, error states | Meta config ID |
| ES-4 | Server finish endpoint: code exchange, ownership verification, subscribe/register, store token | ES-2 |
| ES-5 | Coexistence webhook fields: message echoes, state sync, history; mapping to messages/contacts without duplicates | ES-4 |
| ES-6 | Disconnect/offboarding/reconnect flows and status UI | ES-4 |
| ES-7 | Throughput awareness (20 mps for coexistence numbers) in broadcast/pacing | ES-5 |
| ES-8 | Token lifecycle: expiry detection, refresh/rotation per Meta rules, alerts | ES-4 |
| ES-9 | Copy, i18n, help docs ("what you lose with coexistence"), consent text | legal drafts |
| ES-10 | Staging tests with Meta test numbers, then one real number | Tech Provider path |

## 9. Test plan

- Unit: signup-session lifecycle (expired/replayed/foreign state), ownership verification with mocked Graph responses, number-already-claimed, idempotent finish, secret never in responses.
- Integration (mock Graph): full finish flow, subscribe/register failures with partial-progress recovery.
- pgTAP: new tables' RLS and grants; 080-style column classification for any new secret column.
- Staging manual: Meta test number first; then a real Business-app number for coexistence including echo and history behaviour; disconnect and reconnect.
- No unofficial automation is used anywhere in tests.

## 10. Risks and open questions

| # | Item | Owner |
|---|---|---|
| 1 | Business Verification / Tech Provider / App Review timing is outside our control | RLB |
| 2 | Onboarding cap 10 → 200 per 7 days depends on Access Verification | RLB |
| 3 | Coexistence feature loss and 20 mps cap must be disclosed to customers | RLB + legal |
| 4 | Multi-number: build before or with this? | Owner decision |
| 5 | Audit-log table for connection events does not exist yet | Owner decision |
| 6 | Graph API version bump (v21.0 → v23/v24) should be done first or alongside | Owner decision |
| 7 | History sync: how much to import, retention, consent | Owner + legal |
| 8 | Production data location is unresolved (staging app may point at the production branch) | Owner; see reconciliation audit |
| 9 | Pricing/usage impact of coexistence numbers on plan limits | Commercial decisions |

## 11. Suggested order

1. Reconcile Supabase branches and 063/064 state (blocking for any migration).
2. Start the external Meta clock now (section 2a): Business Verification → Tech Provider → App Review. **Decided.**
3. **Multi-number design and build (Phase 1B) first. Decided.** Design review and owner approval come before any migration.
4. Graph version bump after a Meta test-number smoke test.
5. Build ES-2 … ES-6 on staging with test numbers; ES-5 and ES-7 for coexistence.
6. Switch on for real customers only after App Review approval and the onboarding cap is understood.

## 12. Sources (Meta developer documentation)

- Embedded Signup overview: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview
- Onboard WhatsApp Business app users (coexistence): https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/
- Become a Tech Provider: https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers
- Onboarding customers as a Tech Provider: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider/
- Embedded Signup version 4: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4/
- Reconnect offboarded coexistence clients: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/reconnect-offboarded-coexistence-clients/
- WhatsApp changelog: https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog
