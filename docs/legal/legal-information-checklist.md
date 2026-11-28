# Legal information checklist (owner input required)

Nothing below has been invented. Each unchecked item is a placeholder in
the drafts (`[CONFIRM: …]`). Have qualified counsel review the drafts
before publication; they are **not** legal advice.


## Business identity
- [x] Legal proprietor: KANAGALAKSHMI (proprietorship) — owner-confirmed
- [x] GST certificate trade/business name: RAMANALAKSHMI — owner-confirmed
- [x] Public brand RLB Solutions; product RLB Connect; website https://www.rlbsolutions.in. Neither is a separate incorporated entity
- [x] GST-registered principal business address: 415/2A, Arasan Nagar, Gokulam Colony, Anupparpalayam, Tiruppur, Tamil Nadu - 641652 — owner-confirmed
- [ ] GSTIN: **33HCLPK7484J1ZX** — **owner-supplied 2026-11-25; NOT yet verified against the certificate image.** Recorded in the Privacy, Terms and Data Deletion drafts with that caveat. Only a format/checksum check was done here (valid 15-character GSTIN; state code 33 = Tamil Nadu; the embedded PAN type "P" is consistent with an individual proprietor). The certificate PDF (`Ramanalakshmi GST Certificate.pdf`) is an image-only scan that could not be opened in the 2026-11-25 session. Tick this only after the number is compared with the certificate
- [ ] Verify the business name, proprietor name, principal address and GSTIN in the drafts against the GST certificate exactly (the address was supplied by the owner in chat; none of these has been checked against the certificate image)
- [ ] Any other registration number (e.g. Udyam, shop/establishment), if held
- [ ] Operating address, if different from the GST principal address
- [ ] Authorised signatory for the Terms (assumed the proprietor; confirm)
- [ ] Check the names against the proprietor's identity document (spelling, order)
- [ ] Copyright line wording (e.g. "© KANAGALAKSHMI (RLB Solutions)"); no code/LICENSE change made

## Contacts
- [x] `info@rlbsolutions.in` is working and monitored; it is the primary support and privacy/data-request contact. No separate privacy address is needed now
- [ ] Security-report and conduct emails (`.github/SECURITY.md`, `CODE_OF_CONDUCT.md` still hold placeholders)
- [ ] Phone number (optional) · [ ] Data-protection officer / grievance officer, if one is required (counsel)
- [ ] Production domain (also feeds `NEXT_PUBLIC_SITE_URL`)

## Commercial terms (owner-confirmed 2026-11-25; not recorded elsewhere in the repo)
- [x] Prices (INR, GST additional), monthly / annual prepaid: Starter ₹699 / ₹6,990 · Growth ₹1,799 / ₹17,990 · Business ₹3,499 / ₹34,990 · Agency ₹6,999 / ₹69,990 (Agency includes 5 workspaces)
- [x] First 25 customers: founding pricing for their first 12 months
- [x] Annual prepaid billing with automatic annual renewal; Dodo Payments gateway (not implemented)
- [x] **Free trial (owner-approved 2026-11-25; Terms §7.2, on HOLD):** 14 days; no payment card required to start; no automatic payment or automatic paid-plan conversion at expiry; if no paid plan is purchased, the workspace becomes READ-ONLY; data is not deleted immediately; the customer can choose a plan and pay to reactivate the same workspace, with no new account or data migration
- [ ] Read-only details: exactly what is allowed (view, export, delete) and blocked (send, broadcasts, automations, inbound processing, integrations, API); how long a read-only workspace is kept before deletion; notice before deletion (no period stated; do not invent)
- [ ] Whether a paid workspace whose renewal is cancelled also becomes read-only at the end of its paid period (assumed; not confirmed)
- [x] Meta/WhatsApp usage charges are separate pass-through charges
- [x] RLB-managed AI uses prepaid credits and overage; bring-your-own AI keys are customer-paid
- [x] **Refund and cancellation policy (owner-approved 2026-11-25; Terms §7.1, on HOLD, counsel review pending):** customers may cancel the next annual renewal; access continues to the end of the already-paid period (subject to the actual billing implementation); no pro-rata refund for voluntary mid-term cancellation; exceptions for duplicate charges (refund/adjustment after verification), incorrect billing (refund/adjust confirmed overcharges) and material service failures (individual review and remedy); automatic annual renewal unless cancelled before the renewal date with clear notice; statutory consumer rights preserved; no "all payments non-refundable" claim
- [ ] **Deliberately not set (do not invent):** cancellation notice deadline, refund processing time, renewal-notice timing, and the cancellation method (product, email or Dodo)
- [ ] Confirm "access through the paid period" against the real Dodo Payments behaviour once integrated
- [ ] **Failed-payment policy for paid subscriptions** (separate from the trial rule): grace period, retry/notice, what happens to the workspace and data after it, and any reactivation fee or terms
- [ ] Price after the 12-month founding period; counting rule for "first 25"
- [ ] Per-plan limits (members, contacts, messages, AI) and extra-workspace rules for Agency
- [ ] Managed-AI credit price, expiry and overage rate
- [ ] Dodo Payments' role (merchant of record or processor); how Meta charges are billed and shown; price-change notice
- [ ] Service levels / support hours, if any (none promised in the draft)
- [ ] Acceptable-use rules, WhatsApp/Meta policy pass-through
- [ ] Liability cap, warranty disclaimer, governing law, venue
- [ ] Agency terms (reseller/partner agreement) separate from customer ToS?
- NOTE: verified 2026-11-25: the `accounts` table has only id, name, owner and timestamps; there is no trial, plan, subscription or workspace read-only state in the code or migrations (read-only exists only as the per-user `viewer` role). Billing, plans, trial, read-only mode, auto-renewal, Dodo Payments, limits and AI credits are **not implemented**; the Terms commercial section is on HOLD until they are. Nothing may imply they are live.

## Data deletion (owner's chosen model)
- [x] Workflow: Workspace Owner emails info@rlbsolutions.in from registered email → identity and workspace-ownership verification → acknowledgement within 2 business days → target completion 30 calendar days after verification → completion confirmation
- [x] Scope: members/associations, contacts/conversations/messages, WhatsApp credentials, media/avatars/attachments, broadcasts/templates/automations, AI usage/logs, webhook credentials and integration settings
- [x] Retain only what law requires or legitimate security/audit needs, subject to counsel
- [ ] **Not implemented:** workspace deletion, storage cleanup, contact-deletion media removal, residue cleanup, request ledger (see `data-deletion-technical-spec.draft.md`). Pre-launch requirement; owner approval needed to build
- [ ] Do not publish the 30-day commitment until implemented and tested
- [ ] Ownership-verification method
- [ ] Which records are retained, and for how long (counsel)
- [ ] Verified backup retention/expiry (needs production Supabase plan; D12/D16) — no backup deletion timeline until verified
- [ ] Whether members' logins are deleted with a workspace
- [ ] Whether to unsubscribe the Meta app on deletion; whether to offer a data export before deletion

## Roles and data handling (for counsel to decide)
- [ ] Processor, controller, or both, for customer workspace data; who signs a DPA (the proprietor)
- [ ] Roles in agency-managed workspaces (agency, client, RLB)
- [ ] Applicable laws (e.g. India DPDP Act, GDPR) — claims only if you confirm they apply and are met
- [ ] Production Supabase project, region and plan; VPS (Contabo) data-centre location
- [ ] Sub-processors actually used (Supabase, Contabo, Meta, email provider, Dodo Payments, customer-chosen AI providers)
- [ ] Email provider for auth emails (Supabase default or custom SMTP)
- [ ] International transfer mechanism, if any
- [ ] Data retention periods (messages, contacts, audit logs, backups, deleted workspaces)
- [ ] Breach-notification process and contacts
- [ ] Security certifications held (none are claimed)
- [ ] Cookie/consent approach (only authentication and preference storage today)
- [ ] Children / age limit
- [ ] Marketing/opt-in rules for WhatsApp broadcasts (customer responsibility vs RLB policy)
- [ ] How users are notified of policy changes
- [ ] **HOLD:** do not publish credential/private-media security wording until migrations 063 and 064 are applied and verified in production

## Open-source obligations (already handled; keep)
- [x] MIT License text and Arnas Donauskas copyright notice retained in `LICENSE`
- [x] `NOTICE.md` credits the upstream WACRM project
- [ ] Third-party licence review of dependencies before a commercial launch
- [ ] Meta trademark wording ("WhatsApp") reviewed
