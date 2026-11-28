# 05 — Execution decisions

> Status: **proposal — items marked ⚠ need the owner's approval.**
> Companion to [02](./02-hybrid-saas-target-architecture.md),
> [03](./03-risks-decisions-roadmap.md) and
> [04](./04-master-plan-and-infrastructure.md). Nothing here changes those
> documents or any code. The strategy stays **complete product, no
> disposable MVP**: every deferral below is a *timing* choice (decide later,
> same end state), never a scope cut.
>
> No business, legal or compliance fact is assumed. Where a fact is needed
> and unknown it is written as an **input requested** (§6). Cost impact is
> qualitative (None / Low / Medium / High, with what drives it) because no
> vendor has been selected and no load figures exist.

## 1. How decisions were classified

| Class | Rule |
|---|---|
| **Must decide now** | blocks the start of Wave A or one of its parallel streams, **or** is expensive/irreversible to change later, **or** has external lead time that would otherwise delay launch |
| **Can safely defer** | has a named gate (a point in the plan) before which a decision is needed, and the work before that gate is unaffected whichever option is chosen |
| **Already decided** | settled by the owner's brief, an approved earlier instruction, or a frozen decision in doc 04 §7 — not asked again |

## 2. Already decided (not re-asked)

### 2.1 From the owner's instructions
| Item | Source |
|---|---|
| Product identity: RLB Connect by RLB Solutions; AI-powered WhatsApp CRM | Phase 1 brief |
| Hybrid model: agency-managed **and** self-service, one platform/codebase/shared multi-tenant architecture | strategy brief |
| **Single multi-tenant deployment** (this resolves the "per-client deployments" half of D11) | same brief ("ONE platform, ONE codebase") |
| Roles to model: Platform Super Admin; Agency Admin/Staff; Business Admin/Manager/Agent | strategy brief |
| Agency staff only reach explicitly authorised client workspaces | strategy brief |
| Complete product, no MVP/rebuild; infrastructure provisioned on measured demand; no unnecessary Kubernetes/microservices; stateless web; separate worker | strategy brief |
| Keep MCP functionality; keep existing languages unless approved otherwise | Phase 1 restrictions |
| Preserve MIT licence and upstream attribution | all briefs |
| Phase 0.5 security bump (Next 16.4.6, shadcn → dev) | approved and committed |
| **Billing deferral:** billing-provider selection, payment-gateway account setup, subscription pricing, plan limits and payment integration are finalised **during Billing Module (M11/M12) implementation**, not now. Billing stays a planned core module of the complete architecture. No development time is spent on gateway selection/integration before then. | owner decision, recorded 2026-11-20 (see item 8 below) |

### 2.2 Frozen architecture (doc 04 §7)
A1 row-based tenancy on `accounts` · A2 Postgres/RLS, one helper ·
A3 one codebase, web + worker from one image · A4 **Postgres-backed job
queue** (settles **D17**) · A5 stateless web · A6 agency = consent link +
capped per-person assignment, no implicit cross-tenant roles · A7 platform
admins have no RLS bypass, support via logged time-boxed grants ·
A8 server-side entitlements · A9 append-only audit · A10 no Kubernetes /
microservices · A11 expand → migrate → contract.

### 2.3 Resolved by the target architecture — ratified by approving the baseline (item ⚠ 1)
These were open in doc 03; the architecture already contains the answer, so
they are not asked separately:

| Old ID | Resolution | Where |
|---|---|---|
| D2 Agency Admin implicit access | **No** — explicit, audited self-assignment | A6; doc 02 §8 |
| D3 Who can revoke an agency link | Business always; agency may end its own side | doc 02 §8 |
| D4 Agency staff & WhatsApp credentials | Only if the client grants that person `admin`; default cap `manager` | doc 02 §6, §9b |
| D10 Agency staff also a business user elsewhere | **Yes** (multi-membership) | doc 02 §5, F2 |
| D11 (hosting *model*) | Single RLB-operated multi-tenant deployment | §2.1 |
| D17 Queue technology | Postgres first; Redis/managed queue only by ADR on measured contention | A4 |
| DB behavioural-test tooling | `supabase test db` (pgTAP) via the Supabase CLI already used in `migrations.yml` — **no new npm dependency**. *Verify in F1; if insufficient we return with a dependency request.* | doc 04 §9 |
| Worker queue access | Claim/lease via SQL functions called with the existing `supabase-js`; any direct Postgres driver would be a new dependency and needs separate approval | A4 |

## 3. Must decide now (⚠ need your approval)

Nine items remain (item 8 was decided by the owner — deferred). Each lists:
**Recommendation · Reason · Security/scalability · Cost · If chosen wrongly.**

### ⚠ 1. Ratify the architecture baseline (docs 02, 03 §1–2, 04) — Phase 2 gate
- **Recommendation:** approve docs 02 and 04 as the baseline, including
  A1–A11 and the resolutions in §2.3. Any requested amendments are made
  before Phase 2.
- **Reason:** you required approval of the complete Phase 1 architecture
  before Phase 2; this is that single approval. It also resolves D2, D3, D4,
  D10, D17.
- **Security/scalability:** sets the isolation model (A1, A2, A6, A7) every
  later migration is built and tested against.
- **Cost:** None directly; it fixes the scope other costs derive from.
- **If wrong:** the most expensive error in the project — A1/A2/A6 reversed
  after Wave A means redoing migrations, policies and the test matrix.
  Hence the request to review them before approving.

### ⚠ 2. Is there any live data to preserve? (greenfield or not)
- **Recommendation:** **treat RLB Connect as greenfield** (no production
  users, API keys or WhatsApp numbers to carry over) *unless you tell me
  otherwise*. Keep expand→migrate→contract (A11) but **collapse the
  compatibility window to zero**: contract steps (dropping
  `profiles.account_id/role` sync, `wacrm_live_`/`X-Wacrm-*` dual support)
  are executed before first production launch.
- **Reason:** this question was asked in the earlier plans and not answered;
  the answer decides whether permanent compatibility shims are built.
- **Security/scalability:** fewer shims = smaller attack surface and fewer
  code paths to test; greenfield removes the dual-read equality risk (R2).
- **Cost:** Low; greenfield *saves* effort (no dual-read tooling, no
  deprecation period).
- **If wrong:** if live data does exist and we assumed greenfield, we would
  need an emergency compatibility layer and a data migration plan —
  Medium–High rework. Please confirm explicitly.

### ⚠ 3. Relationship with upstream WACRM
- **Recommendation:** **hard fork** — no routine merges from upstream.
  Security fixes are watched and cherry-picked manually; attribution and
  the MIT notice stay (NOTICE.md/LICENSE).
- **Reason:** the plan rewrites authorization and membership across ~112
  files / ~680 `account_id` references and 121+ policy sites; routine merges
  would conflict constantly and quietly reintroduce single-tenant
  assumptions.
- **Security/scalability:** upside — no accidental regression of tenant
  isolation from upstream changes; downside — we own all upstream-class
  fixes (mitigated by watching upstream security advisories).
- **Cost:** Low–Medium ongoing (a periodic review of upstream releases).
- **If wrong:** if you want upstream merges, we must keep our diff small,
  which conflicts with A1/A2 and F2; choosing late forces a costly
  re-architecture or an unmergeable fork. Decide before F2 starts.

### ⚠ 4. Tenant role set (was D1)
- **Recommendation:** keep the Postgres enum values `owner`, `admin`,
  `agent`, `viewer`; **add `manager`** (between admin and agent). UI labels:
  `owner` and `admin` display as **Business Admin** (owner is the unique
  billing/ownership anchor), `manager` = Manager, `agent` = Agent,
  `viewer` = Read-only (kept for client stakeholders).
- **Reason:** Postgres enum values can be added but not removed cleanly;
  `viewer` already exists in code, policies and tests. Dropping it later is
  hard, adding a role later is easy. Your three named tenant roles are all
  present.
- **Security/scalability:** one ordinal ranking mirrored in SQL and
  `src/lib/auth/roles.ts` keeps policies simple; `manager` enables
  least-privilege for agency staff (capped at manager by default).
- **Cost:** Low (one split migration: `ADD VALUE`, then use).
- **If wrong:** removing a role later requires a type-swap migration across
  all policies; or, if `manager` semantics are wrong, a permission-matrix
  change (doc 02 §7) — Low–Medium.

### ⚠ 5. Workspace routing scheme and white-label scope
- **Recommendation:** **path-based**: `/w/<workspace_id>/…` (immutable UUID,
  verified server-side on every request). **Agency white-labelling and
  custom domains are out of launch scope** (they can be added later by
  mapping host → workspace in the proxy layer without changing the path
  scheme).
- **Reason:** doc 02 (L3) requires the workspace id to come from the route;
  path-based needs no wildcard DNS/TLS and keeps cookies simple. It
  decides where all dashboard pages live, so it must be fixed before the F2
  route restructure — every later UI stream builds on it.
- **Security/scalability:** server-side membership check per request (no
  trust in the URL); no shared "current tenant" state; works identically
  for 1 or many web replicas.
- **Cost:** Low now; subdomain-per-tenant would add wildcard DNS/TLS and
  ops (Medium).
- **If wrong:** changing URL scheme after UI work = rewriting every link
  and redirect (Medium–High, and breaks bookmarks/invites). Confirm also
  that white-label is out of launch scope; if it is in scope, say so now.

### ⚠ 6. Approve a staging environment and where to run it (was D20; settles hosting for *staging* only)
- **Recommendation:** approve (a) a **second Supabase project for staging**
  and (b) **one small host running Docker Compose** (the repo already ships
  `Dockerfile`, `docker-compose.yml`, `docs/docker.md`) for web + worker.
  **Defer the production host/vendor and Supabase production tier** to the
  Wave D load test (§4, D11/D12).
- **Reason:** the complete product must be integration-tested in staging
  from Wave A; a VPS+Compose staging is the cheapest option that matches the
  planned topology exactly; measuring on it informs production sizing,
  matching your "provision on evidence" strategy.
- **Security/scalability:** staging isolated from production data and
  secrets; same image as production so scaling later is a replica/host
  change, not a code change.
- **Cost:** Low–Medium: one extra database project and one small host;
  exact amounts depend on vendor/tier — **you approve the spend**.
- **If wrong:** skipping staging means the complete product is first
  integrated in production (High risk); over-sizing staging wastes money
  (Low).

### ⚠ 7. Meta Tech Provider status (was D7) — start the external clock now
- **Recommendation:** **pursue Tech Provider / Embedded Signup eligibility
  now** (business verification and app review run on Meta's timeline);
  keep guided/manual credential connection as the fallback until it is
  approved. *Verify current Meta requirements when starting.*
- **Reason:** your self-service model requires business owners to connect
  their own WhatsApp account; pasting access tokens is a poor and
  error-prone onboarding experience. Approval lead time is outside our
  control and would otherwise gate launch.
- **Security/scalability:** Embedded Signup avoids customers handling raw
  tokens and enables token issuance scoped to our app (fewer leaked
  credentials); many WABAs under one Meta app is already supported by the
  `META_APP_SECRET` list.
- **Cost:** Low direct (staff time); Meta conversation charges are separate
  and unrelated to this decision. Do not assume fees without checking Meta.
- **If wrong:** not starting = self-service launch with manual connect, or a
  launch delayed by Meta review; starting needlessly = Low wasted effort.
  **Requires facts only you have:** RLB's Meta Business account status.

### 8. Billing — ✅ DECIDED by owner: deferred to the Billing Module (no longer needs approval)
- **Decision (2026-11-20):** provider selection, gateway account setup,
  subscription pricing, plan limits and payment integration are finalised
  during Billing Module (M11/M12) implementation. **Nothing is spent on
  them now.** Billing remains a planned core module; the complete-product
  strategy is unchanged.
- **Gate:** start of Billing Module implementation (Wave B in doc 04 §4).
  D6 (provider), D6b (who is billed for agency clients) and D8 (plans,
  limits, non-payment behaviour) are all decided at that gate.
- **Risk accepted by this deferral:** gateway account approval/KYC/tax
  set-up has outside lead time and now falls inside the Billing Module
  timeline; the doc 04 §9 launch gate (live-mode test transaction) still
  applies. Doc 04 §6 "start immediately" for the billing row now reads
  "start at the Billing Module gate".
- **Architecture preserved so no redesign is needed later** (no billing
  code or tables are added now):
  - A8 stands: entitlements enforced server-side from one
    `get_entitlement` source; M11/M12 stay in the dependency graph
    (F2 → M11, F3 → M11) and in Wave B.
  - Schema direction stays provider-neutral (`provider_ref` only,
    `limits jsonb`, `billing_mode self|agency`, workspace lifecycle
    `status`); these are added **with** the Billing Module.
  - Rules for work done meanwhile: do **not** hard-code limits or plan
    names anywhere; keep the future enforcement points as single code
    paths — seat check (invite create/redeem), contact create/import,
    broadcast create, WhatsApp config, AI routes, API-key/webhook-endpoint
    create — so one `requireEntitlement(accountId, key)` call can be added
    to each later; keep `ai_usage_log` as the metering source; the job
    platform (F3) must leave room for a usage-rollup job type.

### ⚠ 9. Observability vendor and its dependency (was D18)
- **Recommendation:** use a **hosted error-tracking service and a hosted
  external uptime monitor**; keep structured logs, health endpoints and
  metrics counters **vendor-neutral and dependency-free** in Wave A. If an
  error-tracking SDK is adopted it is a **new dependency — I will request
  that approval with the specific package** before adding it.
- **Reason:** F5 ("measure before scaling") is a Wave A stream and the
  whole infrastructure strategy depends on it; self-hosting an observability
  stack is an ongoing ops burden for a small start.
- **Security/scalability:** a vendor becomes a **sub-processor**; logs and
  error payloads must be scrubbed of message bodies/PII (redaction tests are
  in the plan) and the privacy draft updated; the data it holds is the
  early-warning for every scale trigger in doc 04 §8.4.
- **Cost:** Low–Medium, typically volume-based — unquantified until chosen.
- **If wrong:** no vendor = blind scaling decisions (breaks the strategy);
  wrong vendor = Low–Medium migration; PII leakage into a vendor = a
  compliance problem, hence redaction-by-default.

### ⚠ 10. Translation workflow for new UI strings (new D24)
- **Recommendation:** keep all four locales. English is the source;
  **every PR adds keys to en/pt/es/ko together** (required by the repo's
  `messages.test.ts` parity test), with pt/es/ko machine-drafted and queued
  for **native-speaker review before launch** (the Korean particle edits from
  Phase 1 are already on that list).
- **Reason:** the parity test fails CI otherwise, and an untranslated key
  renders as a raw key path in that locale. The new modules (agency console,
  billing, onboarding, admin) add many strings across all waves.
- **Security/scalability:** none direct; ICU-safety tests already guard
  malformed messages.
- **Cost:** Low–Medium (review time by native speakers; drafting cost small).
- **If wrong:** English-only strings break the parity test (blocks merges);
  dropping locales needs your approval (earlier restriction) and wastes
  existing work; shipping unreviewed translations risks poor UX/legal
  wording — mitigate with pre-launch review.

## 4. Can safely defer

Each has a **gate**: the point by which a decision is needed. Work before
the gate is unaffected by the choice.

| ID | Decision | Gate | Recommendation | Reason | Security / scalability | Cost | If chosen wrongly |
|---|---|---|---|---|---|---|---|
| D5′ | Break-glass platform support access (beyond client-approved grants; A7 already requires logging and time-boxing) | before M13 Super Admin console | Client-approved time-boxed grant by default; break-glass only for security incidents, reason logged, client notified after | A7 forbids bypass; incident response may still need it, and it changes what the Privacy Policy must say | Highest-privilege path in the system; every use audited | Low | Too loose = privacy/trust breach; too strict = unable to fix a broken tenant |
| D6b | Who is billed for agency-managed clients (client, agency, RLB wholesale) | start of M11 | Support `billing_mode = self|agency` in the schema (already designed); choose the commercial default with you | Schema supports both, so building waits on nothing | agency billing needs clear boundaries so an agency cannot see other tenants' subscription data | None–Low | Wrong default = invoice/contract rework, not schema rework |
| D8 | Plan catalogue, limits, trial length, non-payment behaviour (read-only vs blocked, grace days) | start of M11 enforcement hooks | Business decision; engine is generic (`limits jsonb`) | no code depends on actual numbers | non-payment "blocked" vs "read-only" affects customers' access to their own data — legal-sensitive | Low | Limits are configuration; wrong values change a row, not code |
| D9 | Audit-log retention and data retention/deletion on cancellation | before audit UI and legal pages (Wave C) | Build `audit_logs` with no purge job until retention is set; counsel to set periods | needs legal input; table design unaffected | immutability vs erasure requests must be reconciled by counsel | Low | Wrong period = legal exposure or storage growth (mitigated by partitioning) |
| D12 | Production Supabase tier and region | Wave D (staging data informs) | Choose after the load test; region near most customers; **region cannot be changed in place** | measured need beats guesses (your strategy) | region = data-residency question — legal input | Medium–High (largest recurring cost) | Wrong region = migration project; undersized tier = vertical upgrade (easy) |
| D11′ | Production host/vendor (staging is item 6) | Wave D | Re-use the Docker topology; choose VPS vs container PaaS using staging ops experience and team skill (D21) | no code depends on it | patching/TLS/deploy discipline is the real difference | Low–Medium | Switching host = redeploy, no code change |
| D16 | RPO/RTO and backup retention targets | before production provisioning | Set with you; verify what the chosen Supabase tier provides; add independent nightly dumps regardless | drives backup tier and drill cadence | recovery capability is a security control | Medium (higher tiers cost more) | Targets stricter than the plan allows = discover at restore time |
| D22 | Do independent agencies self-register, or are agencies created only by the Platform Super Admin? | start of M2 | **Super Admin–created only** at launch; schema stays generic so self-registration can be added later | avoids a second onboarding + billing path (agency as customer) | agency self-signup widens abuse surface (spam workspaces, trust) | Low now (saves effort) | Wanting self-registration later = additive UI/flow, no schema rework |
| D14 | Final logo, colours, domain, support emails | before Phase 2 branding completion; domain before auth-email/invite configuration | provide assets; placeholders remain | Wave A does not depend on them | domain feeds `NEXT_PUBLIC_SITE_URL` and the invite-link host allow-list (security-relevant); email domain needs SPF/DKIM | Low | late = branding delay only |
| D19 | Browser E2E test runner (new dev dependency) | start of Wave C | Approve a dev-only runner at that point; I will name the package and justify | critical journeys need E2E, but not before the UI exists | none at runtime (dev-only) | Low | no E2E = regressions in onboarding/billing journeys |
| MCP | Rename `WACRM_*`/`wacrm-mcp`; publish or keep internal | Phase 2 branding | Rename to RLB Connect names; **do not publish under the upstream author's registry namespace**; keep internal until launch (greenfield: no alias needed — see item 2) | publishing under another person's namespace is not available to RLB | tokens are per-workspace API keys (doc 02 L7) | None–Low | Low |

## 5. Tasks that can run in parallel without rework

Precondition for all: item ⚠ 1 approved. "Interface contract" is what the
stream must keep stable so others do not need to change.

### 5.1 Start immediately (independent of tenancy changes)

| Stream | Needs decision | Interface contract (prevents rework) | Rework risk |
|---|---|---|---|
| **P1 F1 test platform**: pgTAP cross-tenant matrix, CI job extending `migrations.yml` | ⚠ 1 | matrix is **data-driven from a table/RPC/storage-path list** and asserts behaviour, not policy text → survives the later policy rewrite; baseline run against today's `is_account_member` | Low |
| **P2 F3 job platform skeleton**: `jobs` table, claim/lease/retry/dead-letter SQL functions, worker entrypoint, first jobs = existing cron work | ⚠ 1, ⚠ 6 for deployment | `account_id` + opaque `concurrency_key text` (so multi-number WhatsApp later needs no schema change); job types registered in code | Low |
| **P3 F5 observability baseline**: structured logging with request id and optional `workspace_id`, `/api/health/live|ready`, metric counters, PII redaction tests | ⚠ 1 (vendor part waits on ⚠ 9) | logging context object with *optional* workspace id so F2 only fills it | Low |
| **P4 M19 staging environment + CI/CD** | ⚠ 6 | same image for web and worker; config via env only | Low |
| **P5 Independent security fixes**: `middleware→proxy`, MCP install fix, invite-link fallback (F8), CSP report review | ⚠ 1 | none beyond existing behaviour | Low |
| **P6 M20 branding/legal/i18n** | inputs §6 | keep edits in message files / static pages; avoid sidebar structure changes until F2 lands | Low (small merge-conflict risk in `sidebar.tsx`) |
| **P7 Credential-read fix (F1/F2 of doc 01)**: column privileges/view so only admins read tokens/keys | ⚠ 1 + **explicit migration approval when prepared** (DB change) | GRANT-based, independent of how policies are later rewritten | Low |

### 5.2 Parallel once the F2 *interface* exists (not the whole of F2)

The F2 interface = `has_account_access()` signature + `requireWorkspaceRole()`
signature + the `/w/<id>` route layout. Fix these first (small PR), then:

| Stream | Why it can run |
|---|---|
| F4 audit core (table + writer) | actor model is generic (`actor_type` already lists agency/platform) |
| ~~M11/M12 plan tables, `get_entitlement`, usage counters~~ — **deferred with the Billing Module (owner decision, item 8); not started now** | was keyed by `account_id`; moves into the Billing Module as a whole |
| M6 lead-management schema design | new columns on `contacts`; UI waits for the route restructure |

### 5.3 Must be sequential (parallelising creates rework)

1. **Within F2, in this order:** (a) memberships table + backfill →
   (b) `has_account_access` with `is_account_member` as a wrapper →
   (c) `account_id` on the 9 child tables + composite FKs →
   (d) **route restructure to `/w/<id>`** (mechanical, one early PR) →
   (e) invitation/redeem and `handle_new_user` rework → (f) switcher UI.
2. **No UI-heavy stream** (lead UI, reporting v2, agency console, admin
   console, billing screens) **before step (d)** — they would be rewritten
   when pages move.
3. **Agency RLS branch** only after `has_account_access` exists and the
   matrix covers membership; **agency/platform access never ships without the
   audit writer (F4)**.
4. **Broadcast/AI/automation migration to workers** only after P2 is proven
   (lease expiry, retry, kill-worker test) and per-number pacing is
   designed (M8).
5. **Billing enforcement hooks** after F2 (seat limit sits in the invite
   path) and F3 (usage rollups run as jobs).

## 6. Inputs requested (facts only you have — not approvals)

| Input | Needed for | Gate |
|---|---|---|
| Live-data statement (item ⚠ 2) and RLB's Meta Business account status (item ⚠ 7) | decisions 2, 7 | now |
| Incorporation country, target markets/currencies, invoicing needs | choosing billing provider (item 8, deferred) | Billing Module gate |
| Rough scale ranges (tenants, messages/day, largest broadcast) — **D15** | production sizing, partition timing, plan limits | start of Wave B |
| Team size and availability — **D21** | turning relative sizes in doc 04 §10 into a schedule | when scheduling |
| Legal entity details and contacts (`docs/legal/legal-information-checklist.md`) | legal pages, NOTICE, `.github` placeholders | before Phase 2 branding / launch |
| Logo, colours, domain | D14 | see §4 |

## 7. Approval ledger (for your reply)

| # | Item | Recommended answer |
|---|---|---|
| ⚠ 1 | Approve architecture baseline (docs 02, 04; A1–A11; §2.3 resolutions) | Approve |
| ⚠ 2 | Greenfield (no live data to preserve)? | Yes, greenfield; zero compat window |
| ⚠ 3 | Upstream relationship | Hard fork; cherry-pick security fixes only |
| ⚠ 4 | Role set | Keep enum, add `manager`, keep `viewer`; label owner/admin "Business Admin" |
| ⚠ 5 | Routing + white-label | `/w/<workspace_id>/…`; white-label out of launch scope |
| ⚠ 6 | Staging environment and spend | Approve 2nd Supabase project + 1 small Docker host; defer production host |
| ⚠ 7 | Meta Tech Provider | Start now; manual connect as fallback |
| 8 | Billing provider, pricing, limits, integration | ✅ Decided by owner: deferred to the Billing Module; architecture preserved (item 8) |
| ⚠ 9 | Observability | Hosted error tracking + uptime; no SDK until I request dependency approval |
| ⚠ 10 | Translation workflow | Keep 4 locales; update all together; native review before launch |
