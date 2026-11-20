# Legal information checklist (owner input required)

Nothing below has been invented. Each unchecked item is a placeholder in
the drafts (`[CONFIRM: …]`). Have qualified counsel review the drafts
before publication; they are **not** legal advice.

## Business identity
- [ ] Registered legal entity name of "RLB Solutions" and legal form
- [ ] Registration / company number and jurisdiction
- [ ] Registered address and operating address (if different)
- [ ] Tax / VAT / GST identifier (if invoices will be issued)
- [ ] Authorised signatory for the Terms
- [ ] Who holds copyright in RLB Connect modifications (entity name for NOTICE/LICENSE line)

## Contacts
- [ ] General support email · [ ] Privacy/data-request email · [ ] Security-report email · [ ] Conduct email (`.github/SECURITY.md`, `CODE_OF_CONDUCT.md` currently hold placeholders)
- [ ] Phone number (optional) · [ ] Data-protection officer / representative (if one is required)
- [ ] Production domain (also feeds `NEXT_PUBLIC_SITE_URL`)

## Roles and data handling (for counsel to decide)
- [ ] For customer workspace data (contacts, messages): is RLB Solutions a processor, a controller, or both? Which entity signs a DPA?
- [ ] For agency-managed workspaces: roles of the agency, the client and RLB
- [ ] Applicable laws/jurisdictions (e.g. GDPR, India DPDP Act, others) — **claims are made only if you confirm they apply and are met**
- [ ] Hosting region(s), Supabase plan, backup practice
- [ ] Sub-processors actually used (Supabase, hosting provider, Meta, email/SMTP provider, payment provider, AI providers chosen by customers)
- [ ] International transfer mechanism, if any
- [ ] Data retention periods (messages, contacts, audit logs, backups, deleted workspaces)
- [ ] Deletion/export process and response time commitment
- [ ] Breach-notification process and contacts
- [ ] Security certifications held (none are claimed in the drafts)
- [ ] Cookie/consent approach (the app sets only authentication and preference storage today — see privacy draft §4 — confirm if analytics will ever be added)
- [ ] Children / age limit
- [ ] Marketing communications and opt-in rules for WhatsApp broadcasts (customer responsibility vs RLB policy)

## Commercial terms (Terms of Service)
- [ ] Plans, prices, currency, taxes
- [ ] Trial terms
- [ ] Billing cycle, renewal, cancellation, refunds
- [ ] Non-payment handling (suspension, data retention)
- [ ] Service levels / support hours, if any (none are promised in the draft)
- [ ] Acceptable-use rules, WhatsApp/Meta policy pass-through
- [ ] Liability cap, warranty disclaimer, governing law, venue
- [ ] Agency terms (reseller/partner agreement) separate from customer ToS?

## Open-source obligations (already handled; keep)
- [x] MIT License text and Arnas Donauskas copyright notice retained in `LICENSE`
- [x] `NOTICE.md` credits the upstream WACRM project
- [ ] Decide wording for the RLB Solutions copyright line once the entity name is confirmed
- [ ] Third-party licence review of dependencies before a commercial launch (not done in Phase 1)
- [ ] Meta trademark wording ("WhatsApp") reviewed
