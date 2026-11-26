# Privacy Policy — DRAFT (not for publication)

> **DRAFT.** Built only from functionality verified in the repository.
> Every `[CONFIRM: …]` is missing business or legal information. No
> retention periods, compliance claims, certifications or data-sharing
> promises have been written. Counsel must review before publishing.

**Product:** RLB Connect, offered under the public-facing brand RLB
Solutions
**Proprietor (legal person responsible):** KANAGALAKSHMI, sole proprietor.
The business name on the GST certificate is RAMANALAKSHMI. "RLB Solutions"
and "RLB Connect" are a brand and a product name, not separate companies.
Constitution: proprietorship.
**GST-registered principal place of business:** 415/2A, Arasan Nagar,
Gokulam Colony, Anupparpalayam, Tiruppur, Tamil Nadu - 641652.
**GSTIN:** 33HCLPK7484J1ZX (owner-supplied; not yet verified against the
certificate image)
[CONFIRM: any other registration number]
**Website:** https://www.rlbsolutions.in
**Contact for support and privacy / data requests:** info@rlbsolutions.in
(owner-confirmed as working and monitored; no separate privacy address is
used at present)
**Last updated:** [CONFIRM: date of publication]

## 1. Who this applies to
RLB Connect is a WhatsApp CRM used by businesses ("workspaces") and their
team members. [CONFIRM with counsel: whether the proprietor (trading as
RLB Solutions) acts as a
processor on behalf of each workspace for customer data, as an independent
controller for account/billing data, or both.]

## 2. Information the software stores (verified in the codebase)
**Account and team information:** name, email address, optional profile
photo, role in the workspace, workspace name, invitation records.

**Customer data entered or received by a workspace:** contact records
(phone number, name, email, avatar link, tags, custom fields, notes),
WhatsApp conversations and messages including media files received or
sent, pipeline/deal records, broadcast and template records, automation
and flow definitions and run logs, quick replies, notifications.

**Integration credentials:** WhatsApp Business access tokens and webhook
verify tokens, outbound-webhook signing secrets and, if the workspace
enables AI features, the workspace's own AI-provider API key(s). These are
encrypted by the application (AES-256-GCM) before they are stored.
Public-API keys are stored only as hashes.

**Media files:** pictures, documents and voice notes sent or received in
WhatsApp conversations are, by default, copied into the workspace's file
storage (a workspace administrator can turn this off for inbound media).
Profile photos are stored in a separate avatar store.

**Usage records:** AI request usage counts per workspace; team-member
presence information; automation/flow execution logs.

[CONFIRM: any additional data — billing/payment details (none exist in the
code today), support records, server logs kept by the host.]

## 3. How information is used and where it goes (verified data flows)
- **Supabase** (database, authentication, file storage, realtime) stores
  the data above. [CONFIRM: production project, hosting region, plan,
  sub-processor terms.]
- **Application server:** the application runs on a virtual private
  server (Contabo). [CONFIRM: whether the hosting provider is to be listed
  as a sub-processor and the data-centre location. Web-server access logs
  exist; their content and retention are unverified.]
- **Meta / WhatsApp Business Platform:** messages, templates and
  delivery events are exchanged with Meta's API to send and receive
  WhatsApp messages. Meta's own terms and privacy policy govern their
  handling.
- **AI providers (optional):** only if a workspace administrator enables
  AI features with their own key, conversation text and knowledge-base
  content selected for a reply are sent to the provider they configured
  (OpenAI, Anthropic, or an OpenAI-compatible endpoint they specify).
- **Workspace-configured webhooks:** if a workspace configures outbound
  webhooks or automation webhook steps, event data is sent to the URL
  they specify.
- **Agency access:** where a workspace has authorised an agency, assigned
  agency staff can access that workspace's data according to the
  permissions granted. [CONFIRM: wording once the agency model is built.]
- **Email:** sign-up confirmation and password-reset emails are sent
  through Supabase Auth. [CONFIRM: whether a custom SMTP provider is
  configured and who it is; any other sub-processors.]
- **Payments (planned, not yet built):** subscription payments are to be
  taken through Dodo Payments. [HOLD: billing is not implemented in the
  software. Do not publish this line, or any statement about payment data,
  until it is built; [CONFIRM: what payment data RLB receives and stores
  versus what stays with the payment provider, and the provider's role.]]

The code contains no advertising or third-party analytics trackers, and no
sale of data is implemented. [CONFIRM: that this remains RLB Solutions'
policy before stating it publicly.]

## 4. Cookies and local storage (verified)
- **Authentication cookies** set by Supabase to keep you signed in.
- **Browser local storage** for interface preferences (theme and mode,
  inbox panel state, flow editor view, browser-notification preference).
- Page fonts are bundled at build time and served from the application
  itself (verified: the production build contains local .woff2 files). Next.js's
  built-in image generator contains a server-side Google Fonts fetch that is
  only used for images containing text; the favicon contains none.
  [CONFIRM at launch that no end-user request reaches a font CDN.]
- [CONFIRM: cookie banner requirement for your target markets.]

## 5. Retention and deletion
Workspace members with the required role can delete individual contacts,
deals, templates, automations and similar records inside the application.
Deleting a contact also deletes its conversations and messages from the
database. [VERIFY before stating publicly: whether media files copied to
file storage are removed at the same time. The application code reviewed
does not remove them when a contact is deleted.]

The software has **no self-service function to delete a user account or an
entire workspace, and no general data export** (only a CSV export of
broadcast results). Removing a member from a workspace does not delete
their login. Deletion of an account, a workspace or a person's data is
therefore handled through a controlled, verified request to
info@rlbsolutions.in; see the Data Deletion Instructions page [CONFIRM:
URL once published].

[HOLD: the complete deletion workflow (workspace data, stored media,
credentials) is not yet implemented. Do not publish any statement that
data is deleted completely, or within a stated time, until it is built and
tested. See data-deletion-technical-spec.draft.md.]

When a free trial ends without a paid plan, the workspace is planned to
become read-only and its data is not deleted immediately. [HOLD: not
implemented; CONFIRM: how long such data is kept and what notice is given.
No period is stated here.]

[CONFIRM: retention periods for messages, contacts, logs, backups and
deleted workspaces; response times for requests.] *The software does not
currently enforce any automatic retention schedule.*

## 6. Security
Technical measures present in the software include encrypted storage of
integration credentials, hashed API keys, signed webhook verification
(inbound Meta webhooks are checked against their X-Hub-Signature-256
signature), row-level access controls in the database that scope each
workspace's data, role-based permissions (owner, admin, agent, viewer) and
HTTP security headers.

[HOLD: do not publish these two sentences until database migrations 063
and 064 are applied on the production database and verified: "Stored
WhatsApp and AI credentials cannot be read back by workspace members or by
the browser." and "Conversation media files are private and are served
only through short-lived signed links to signed-in members of the owning
workspace." Until then the chat and flow media buckets are public by
object URL and encrypted credential columns are readable by workspace
members.]

[CONFIRM before publishing: operational practices (backups, who at RLB can
access the server and database), certifications (none are claimed),
incident and breach process.]

## 7. Your rights and contact
Requests to access, correct or delete personal data can be sent to
info@rlbsolutions.in. [CONFIRM with counsel: rights applicable in your
jurisdictions (for example India's DPDP Act), grievance officer details if
required, supervisory authority, data-protection officer if required. No
compliance with GDPR, the DPDP Act or any other law is claimed in this
draft.]

## 8. Children
[CONFIRM: minimum age.]

## 9. Changes
[CONFIRM: how users are notified of changes.]

## 10. Open-source notice
RLB Connect is derived from the MIT-licensed WACRM project by Arnas
Donauskas; see NOTICE.md.
