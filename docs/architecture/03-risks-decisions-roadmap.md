# 03 — Risks, unresolved decisions and development roadmap

> Status: Phase 1 deliverable, **proposal for review**. Nothing here is
> implemented. Phase 2 must not start until the architecture in
> [02](./02-hybrid-saas-target-architecture.md) is approved.

## 1. Unresolved decisions (need an owner answer)

| ID | Decision | Recommendation | Blocks |
|---|---|---|---|
| D1 | Role naming: keep enum `owner/admin/agent/viewer` and relabel + add `manager`, or replace with `business_admin/manager/agent` and drop `viewer`? | Keep enum, add `manager`, relabel in UI; keep `viewer` (read-only stakeholders) | roles migration |
| D2 | May Agency Admins read client data without per-person assignment? | No — explicit self-assignment (audited) | agency RLS |
| D3 | Who can revoke an agency link — client only, agency only, or both? | Client always can; agency can end its own side | link design |
| D4 | Can agency staff ever see/connect WhatsApp credentials? | Only if the client grants `admin` to that person; cap default `manager` | credential isolation |
| D5 | Platform support access to tenant data: never, break-glass, or client-approved grant? | Time-boxed grant approved by client, break-glass only with logged reason | super-admin console |
| D6 | Billing provider and who is billed for agency-managed clients (client, agency, or RLB wholesale)? | Decide before any billing code; model supports `billing_mode` | billing |
| D7 | Will RLB become a Meta **Tech Provider** (needed for Embedded Signup)? Timeline? | Start the Meta business verification early (external lead time) | self-service WhatsApp connect |
| D8 | Plan catalogue, limits, trial length, behaviour on non-payment (read-only vs blocked) | Business input needed; do not guess | entitlements |
| D9 | Audit-log retention and data-retention/deletion on cancellation | Business/legal input needed | audit + legal pages |
| D10 | Is a user allowed to be both agency staff **and** a business user in another workspace? | Yes (multi-membership makes it natural) | membership model |
| D11 | Hosting model: single RLB-operated deployment vs per-client deployments for some customers | Single multi-tenant deployment (this document assumes it) | everything |
| D12 | Supabase plan/region and backup/PITR policy for production | Owner input needed | deploy |
| D13 | Keep all four languages (en/pt/es/ko)? | Keep (no removal without approval); ko particles need native review | i18n |
| D14 | Final logo, colours, domain, support emails | Owner supplies; placeholders in place | branding, legal |

## 2. Risk register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Cross-tenant data leak via a missed policy, service-role call or join | Med | **Critical** | L1–L9 isolation layers; **matrix test first**; deny-by-default; two-person review on every migration |
| R2 | Multi-membership refactor breaks existing single-account users | Med | High | Expand/contract; dual-read with equality tests; staged flags |
| R3 | Agency access creeps beyond intent (implicit grants, stale assignments) | Med | High | explicit grants, expiry, cap, live link check, client-visible access list, audit |
| R4 | One leaked `ENCRYPTION_KEY` exposes every tenant's WhatsApp token and AI key | Low–Med | **Critical** | key versioning → envelope encryption; admin-only column reads; secret manager |
| R5 | Meta platform constraints (Tech Provider, template/pricing changes, `v21.0` aging) | High | Med | start verification early; central API-version constant; contract tests |
| R6 | Billing bugs lock out paying customers / allow abuse | Med | High | server-side entitlement checks, idempotent provider webhooks, grace period, manual override |
| R7 | Legal exposure: privacy promises or compliance claims not backed by practice | Med | High | no claims without confirmation; counsel review; processor/controller roles defined before launch |
| R8 | Upstream drift: deep rebrand/refactor makes merging WACRM updates hard | High | Med | decide D-upstream (merge vs fork); keep upstream-touching edits small; track upstream issues |
| R9 | In-memory rate limiter ineffective when scaled out | Med | Med | shared store before multi-instance deploy |
| R10 | MCP/root typecheck relies on an accidental transitive dependency | Low | Low | give `mcp-server` its own install or exclude from root tsconfig (Phase 2 task) |
| R11 | Super-admin account compromise | Low | **Critical** | MFA, no tenant-data RLS bypass, grants + audit, alerting |
| R12 | Scope: this is multi-month engineering; "secure" requires external review | High | Med | phase gates, pen test before launch |

## 3. Updated development roadmap

> **Superseded by [04-master-plan-and-infrastructure.md](./04-master-plan-and-infrastructure.md)**
> (complete-product strategy: one master plan, dependency-ordered waves,
> progressive infrastructure). The phase table below is kept only as the
> earlier draft; decisions D1–D14 and risks R1–R12 in this file remain
> valid, and D15–D21 are in doc 04.

Each phase ends with lint, typecheck, tests, build and the cross-tenant
matrix (from phase 3 on); no phase merges without them.

| Phase | Theme | Key outputs | Depends on |
|---|---|---|---|
| **1** *(this)* | Identity, legal, architecture | Branding edits, About page, NOTICE, legal **drafts**, architecture docs | — |
| **2** | Branding completion + safe hardening | Final logo/assets (D14), README/docs rewrite, remove Hostinger referral, publish legal pages after owner confirmation, fix invite fallback (F8), `middleware→proxy`, MCP install fix (R10), secrets-read fix F1/F2 *(DB change — needs your approval)* | D14, legal inputs |
| **3** | Isolation foundation | **Cross-tenant test harness** (real Postgres in CI), `account_id` on child tables + composite FKs, `has_account_access`, service-role wrapper + ban rule | approval of 02 |
| **4** | Multi-workspace membership | `account_memberships`, relax owner uniqueness, new invite redemption, workspace-in-route context + switcher, `manager` role | 3 |
| **5** | Audit log | `audit_logs`, writers at the listed actions, tenant audit screen | 4 |
| **6** | Agency layer | agencies, members, links, assignments, agency console, capped access, offboarding | 4, 5, D2–D4 |
| **7** | Plans, entitlements, billing | plan tables, enforcement points, provider integration, billing portal | D6, D8 |
| **8** | Self-service onboarding + WhatsApp connect | wizard, trial, Embedded Signup (if D7), key versioning | 4, 7 |
| **9** | Platform admin console | tenants list, suspend, support-access grants, usage dashboards | 5, D5 |
| **10** | Production readiness | distributed rate limit, backups/PITR, monitoring, pen test, compliance review, deploy runbooks | all |

Ordering note: audit logging (5) is placed **before** the agency layer (6)
on purpose — cross-tenant access should never exist without a record of it.
Phases 7–9 can be reordered by commercial priority.

## 4. What Phase 1 changed in the repository

See the final report. In short: branding strings/metadata, an About page,
`NOTICE.md`, contact-address placeholders in `.github`, and documentation
under `docs/architecture/` and `docs/legal/`. **No** database, auth,
WhatsApp, API, dependency or environment changes.
