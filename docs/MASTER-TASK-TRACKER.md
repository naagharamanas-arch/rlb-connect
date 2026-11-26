# RLB Connect — Master Task Tracker

Permanent tracker. Status values: **DONE · PARTIAL · BLOCKED · PENDING**.
Evidence marked *(supplied)* was reported by the owner and not re-verified from the repo.
Last updated: 2026-11-26. Baseline: branch `feat/wave-a-f1-tenant-test-platform`, HEAD `781401a` (local only, not pushed); `origin/main` = `ce2c592`.
Existing architecture docs (01–07) are preserved unchanged; this file only tracks status.

## Standing rules
- No Production Supabase change, migration apply, `db push`, `migration repair`, or VPS change without explicit approval.
- Never print or commit secrets. Uncommitted user work (legal drafts, docs 05–07, `supabase/staging-audits/`) must not be overwritten.
- Official Meta Cloud API + Embedded Signup + eligible Coexistence only. No unofficial WhatsApp Web/QR automation.
- Do not touch the existing WhatsApp Business App number `+91 90252 77860`.

## Phase 0 — Original roadmap (T1–T10)

| ID | Task | Status | Evidence | Depends on / remaining |
|---|---|---|---|---|
| T1 | Supabase branches audit | DONE | *(supplied)* only `main — PRODUCTION` exists in `gcdtrjbmhnvlnqqwppfp` | Finding: no staging DB exists → Phase 1 |
| T2 | VPS DB config audit | DONE | *(supplied)* app URL → `gcdtrjbmhnvlnqqwppfp` | — |
| T3 | Prod DB audit for 063/064 | DONE | *(supplied)*; `063_credential_column_privileges.sql`, `064_private_media_buckets.sql` | — |
| T4 | Git image ↔ DB reconcile | DONE | commits `4acfb84`, `5bddf01` | — |
| T5 | Migration history repair | DONE | *(supplied)* `migration list --remote` shows 063/064 applied | Do not re-run |
| T6 | Staging media runtime tests | PARTIAL | 13/13 targeted Vitest pass; staging containers healthy | Range/seek, long video, Meta media delivery, Flow `send_media`; needs a WhatsApp number; best re-run after Phase 1 |
| T7 | Meta Business Verification / Tech Provider | PARTIAL | *(supplied)* verification approved, Tech Provider selected, App Review in review, 0 required actions | Advanced Access pending; Coexistence test rejected ("partner cannot connect Business App numbers yet"); Access Verification not started; owner action |
| T8 | Multi-number decisions D1–D9 | PARTIAL | `07-multi-number-design-spec.md` §5 has recommended defaults | Not approved; needs owner approval (after Phase 1) |
| T9 | Multi-number migration M1 | PENDING | No `whatsapp_wabas`/`whatsapp_numbers` in `supabase/migrations/` (last = 065) | T8 + Phase 1 + read-only data audit + explicit approval |
| T10 | Embedded Signup + Coexistence | BLOCKED | No ES code in `src` | T9, Advanced Access, Coexistence restriction |

## Phase 1 — Safe development environment (CURRENT)

| ID | Task | Status | Evidence / notes | Depends on |
|---|---|---|---|---|
| P1.1 | Create separate Staging Supabase project | PENDING | Owner action in dashboard; details in "Phase 1 plan" below | Owner approval of region/plan |
| P1.2 | Staging env file with new project's keys only | PENDING | Config list below | P1.1 |
| P1.3 | Apply migrations 001–065 to staging DB only | PENDING | Needs CLI linked to the **staging** ref; explicit approval | P1.1 |
| P1.4 | Staging storage buckets verified (`chat-media`, `flow-media` private; `avatars` public) | PENDING | Created/updated by migrations; verify after P1.3 | P1.3 |
| P1.5 | Prove staging ↔ production credential separation | PENDING | Checklist below | P1.2 |
| P1.6 | Rebuild staging image with staging `NEXT_PUBLIC_*` and redeploy | PENDING | `NEXT_PUBLIC_*` are baked at build time (`deploy/compose.app.yml`, `publish-image.yml`); VPS change needs approval | P1.2 |
| P1.7 | Check migration 065 state on production (read-only) | PENDING | 065 in repo; production DB state never verified | owner approval for read-only query |
| P1.8 | Read-only production NULL-`waba_id` audit | PENDING | Required before M1 backfill (doc 07 §6) | owner approval |

## Phase 2 — Release hygiene (not started)
| ID | Task | Status | Notes |
|---|---|---|---|
| R1 | Push `781401a` (webhook hardening) | PENDING | Needs owner approval; deploy to staging after P1.6 |
| R2 | Graph API v21.0 → v23/v24 | PENDING | After Meta test-number smoke test |
| R3 | Legal pages live (Privacy/Terms/Data Deletion) | BLOCKED | Drafts on HOLD; GSTIN unchecked; required for App Review |

## Phase 3 — Multi-number and onboarding (see docs 06, 07)
| ID | Task | Status |
|---|---|---|
| M1–M6 | Multi-number expand → backfill → FKs → dual-read → switch → contract | PENDING (= T9 and follow-ups) |
| ES-1…ES-10 | Signup sessions, Embedded Signup UI, finish endpoint, Coexistence webhooks, disconnect, token lifecycle, throughput, copy, tests | PENDING / BLOCKED (= T10) |
| UI | Settings → WhatsApp Accounts → Connect WhatsApp (Cloud API / Coexistence chooser, progress, retry, disconnect) | PENDING |

## Phase 4 — Master-plan items outside T1–T10 (doc 04; none dropped)
| ID | Item | Status | Evidence |
|---|---|---|---|
| F1 | Test and CI platform | DONE | pgTAP suites `supabase/tests/database/*`, `fullstack-authz.yml`, `migrations.yml`; 1878 Vitest tests pass |
| F2 | Tenancy core (`account_memberships`, `manager`, `/w/<id>`) | PARTIAL | Only credential-column fix (063) exists |
| F3 | Job queue + worker | PENDING | Interim `scheduler` container only |
| F4 | Audit log | PENDING | no `audit_logs` table |
| F5 | Observability | PARTIAL | `/api/health/live`, `/ready`, env validation exist; structured logs / error tracking not evidenced |
| M2/M14 | Agency layer and dashboard | PENDING | — |
| M13 | Super Admin | PENDING | — |
| M11/M12 | Billing and entitlements | PENDING (deferred by owner) | Provider undecided; "Dodo" not mentioned in repo — owner to confirm |
| — | AI usage ledger | PARTIAL | legacy `ai_usage_log` only |
| M6, M15, M16, M18, Wave D | Leads, reporting v2, hardening, backup/restore, load/pen test | PENDING | — |

## Phase 1 plan: Staging Supabase

**Exact configuration changes (staging app only):**
1. `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — new project's values; baked into the image at build time, so a **new staging image build** is required.
2. `SUPABASE_SERVICE_ROLE_KEY` — new project's key, in `/srv/rlb/staging/app.env` only.
3. `ENCRYPTION_KEY` — generate a **new** 64-hex key for staging (never reuse production's). Existing encrypted tokens do not transfer, which is fine for a fresh database.
4. `AUTOMATION_CRON_SECRET` — new value. `META_APP_SECRET` / `META_APP_ID` — same Meta app unless the owner decides otherwise.
5. Supabase Auth → URL configuration: Site URL `https://staging.rlbsolutions.in` and redirect allow-list on the **new** project. Create the SMTP/email settings equivalent if auth emails are needed.

**Migration and storage setup:**
- Migrations `001`–`065` are applied in filename order to the new project only, after approval. `supabase/ci/*` is for ephemeral CI databases and is never run on a hosted project.
- Hazard: re-running `061` after `063` re-grants table SELECT (doc 07 §2). Apply in order, once.
- Hazard: the CLI is currently linked to the production ref (the migration repair was run against it). Run `supabase unlink` then `supabase link --project-ref <STAGING_REF>` and verify with `supabase projects list` before any `db push`. Use a separate working directory or checked ref each time.
- After apply: check `storage.buckets` public flags and run `supabase/staging-audits/01–03` (read-only) against staging.

**Separation checks (P1.5):**
- Staging and production project refs differ; compare refs only, never print keys.
- `app.env` on the VPS contains no production ref, URL or key, and the staging image was built with the staging URL.
- `ENCRYPTION_KEY` differs between environments (compare hashes, not values).
- Production env files are not mounted into any `rlb-staging` container.
- A test signup on staging creates a row in the staging DB and none in production.

## Change log
- 2026-11-26: tracker created from the existing audit report; Phase 1 opened. No external changes made.

## Status update — 2026-11-27 (appended; rows above are historical)
**Owner decisions recorded (27 Nov 2026, in chat):**
- Z1 dependency order approved: tenancy → audit → worker → billing; doc 05 frozen decisions A1–A11 and §2.3 resolutions ratified.
- Billing deferred per doc 05 item 8; payment-provider (incl. Dodo) work not started until the Billing Module.
- Uncommitted docs 05–07, this tracker, legal drafts and staging-audits to be committed locally to the feature branch; no push.

**Wave 0 — runtime evidence (owner-run read-only commands on VPS, 26 Nov 2026 ~18:55 UTC):**
- Image OCI revision = a29f3697a9cf70d7ecd7e83a76a0d85db0768b3e = repo HEAD = PR #2 head. RUNTIME VERIFIED.
- Running image digest sha256:224fe692839a... ; rlb-staging-app-1 healthy. RUNTIME VERIFIED.
- Runtime NEXT_PUBLIC_SUPABASE_URL host = seaovyepglxfiqmjjpmw (staging). RUNTIME VERIFIED.
- Production ref (gcdtrjbmhnvlnqqwppfp): 0 matches in /srv/rlb/staging/app.env and 0 in .next; positive control: staging ref in 30 .next files. VERIFIED.
- Scheduler: /api/automations/cron and /api/flows/cron return 200 every ~60s. RUNTIME VERIFIED.
- CI on a29f369: lint/typecheck/test/build, HTTP/Realtime/Storage authz, build-and-push all success. PR #2 open, mergeable clean.
- OPEN: production-stack-untouched listing; staging signup + DB write smoke test (owner-run, then read-only SQL).
- Supersedes: P1.1–P1.6 above are done on staging per owner evidence; HEAD is a29f369 (pushed), not 781401a.
