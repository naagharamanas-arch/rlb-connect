# Privacy Policy — DRAFT (not for publication)

> **DRAFT.** Built only from functionality verified in the repository.
> Every `[CONFIRM: …]` is missing business or legal information. No
> retention periods, compliance claims, certifications or data-sharing
> promises have been written. Counsel must review before publishing.

**Product:** RLB Connect, a product of RLB Solutions ([CONFIRM: legal
entity name, registration number, registered address])
**Contact for privacy requests:** [CONFIRM: privacy email]
**Last updated:** [CONFIRM]

## 1. Who this applies to
RLB Connect is a WhatsApp CRM used by businesses ("workspaces") and their
team members. [CONFIRM with counsel: whether RLB Solutions acts as a
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

**Integration credentials:** WhatsApp Business access tokens and, if the
workspace enables AI features, the workspace's own AI-provider API key.
These are stored encrypted. Public-API keys are stored only as hashes.

**Usage records:** AI request usage counts per workspace; team-member
presence information; automation/flow execution logs.

[CONFIRM: any additional data — billing/payment details (none exist in the
code today), support records, server logs kept by the host.]

## 3. How information is used and where it goes (verified data flows)
- **Supabase** (database, authentication, file storage, realtime) stores
  the data above. [CONFIRM: hosting region, plan, sub-processor terms.]
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
- [CONFIRM: email provider for sign-up/reset messages; payment provider,
  once chosen; any other sub-processors.]

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
[CONFIRM: retention periods for messages, contacts, logs, backups and
deleted workspaces; how a workspace or a person requests deletion/export;
response times.] *The software does not currently enforce any automatic
retention schedule.*

## 6. Security
Technical measures present in the software include encrypted storage of
integration credentials, hashed API keys, signed webhook verification,
row-level access controls in the database, and HTTP security headers.
[CONFIRM before publishing: operational practices, certifications (none are
claimed), incident process.]

## 7. Your rights and contact
[CONFIRM: rights applicable to your jurisdictions and how to exercise
them; supervisory authority; data-protection officer if required.]

## 8. Children
[CONFIRM: minimum age.]

## 9. Changes
[CONFIRM: how users are notified of changes.]

## 10. Open-source notice
RLB Connect is derived from the MIT-licensed WACRM project by Arnas
Donauskas; see NOTICE.md.
