# Data Deletion Instructions — DRAFT (not for publication)

> **DRAFT. DO NOT PUBLISH the completion commitment.** The deletion
> workflow below is the owner's chosen model. The software does **not**
> yet implement complete deletion of a workspace and its stored media, so
> the 30-day completion commitment (section 2) must stay unpublished until
> the workflow is built and tested. See
> `data-deletion-technical-spec.draft.md`. Every `[CONFIRM: …]` is missing
> information. No retention period, backup timeline or erasure guarantee
> beyond the owner's stated targets is written. Counsel must review.
> This is also the page Meta asks for as the app's "User data deletion"
> instructions URL; do not enter it in Meta until it is published.

**Product:** RLB Connect, offered under the public-facing brand RLB
Solutions
**Proprietor:** KANAGALAKSHMI, sole proprietor (GST certificate business
name: RAMANALAKSHMI). RLB Solutions and RLB Connect are a brand and a
product name, not separate legal entities.
**GST-registered principal place of business:** 415/2A, Arasan Nagar,
Gokulam Colony, Anupparpalayam, Tiruppur, Tamil Nadu - 641652.
**GSTIN:** 33HCLPK7484J1ZX (owner-supplied; not yet verified against the
certificate image)
**Contact for data requests:** info@rlbsolutions.in
**Last updated:** [CONFIRM]

## 1. What you can delete yourself
Signed-in workspace members with the required role can delete individual
records inside RLB Connect: contacts, deals, message templates,
automations, flows, quick replies, tags and knowledge-base entries, and
can remove WhatsApp and AI-provider credentials in Settings.
[HOLD: deleting a contact currently removes its conversations and messages
from the database but **not** media files stored for them, and leaves some
notification text that mentions the contact's name or number. Do not state
that a contact deletion is complete until this is fixed.]

## 2. Requesting deletion of a workspace or account
There is no self-service button for deleting a whole workspace or user
account. Deletion is done through a verified request:

1. **Request.** The Workspace Owner emails **info@rlbsolutions.in** from
   the email address registered on the account, with the subject "Data
   deletion request", naming the workspace.
2. **Verification.** We verify the requester's identity and that they own
   the workspace before anything is deleted. [CONFIRM: verification
   method, e.g. confirmation reply, additional checks.]
3. **Acknowledgement.** We acknowledge the request within 2 business days.
4. **Deletion.** We delete the workspace data described in section 3.
5. **Confirmation.** We send a written confirmation when deletion is
   complete.

[HOLD] **Target completion: within 30 calendar days after verification.**
Not to be published until the deletion workflow is implemented and tested.

Requests about a person's data inside a customer's workspace: the
business that owns the workspace controls that data. [CONFIRM with counsel:
processor/controller roles and how we route such requests.]

## 3. What is deleted
On a verified workspace deletion request the intended scope is:

- workspace members' memberships and the workspace's account associations
  (a member's own login is separate: [CONFIRM: whether it is deleted at the
  owner's request or only on that person's own request]);
- contacts, conversations and messages, with their tags, notes and custom
  field values;
- WhatsApp integration credentials and tokens;
- uploaded media, avatars and attachments in file storage;
- broadcasts, templates, quick replies and automations (and their run
  logs);
- AI configuration, knowledge base and AI usage records;
- webhook endpoints and signing secrets, API keys and other integration
  settings.

## 3A. Expired trials and read-only workspaces
When a 14-day free trial ends without a paid plan, the workspace becomes
read-only; its data is not deleted immediately, and the customer can pay to
reactivate it. [HOLD: not implemented. CONFIRM: how long a read-only
workspace is kept before any deletion and what notice is given; no period is
stated here. A deletion request under section 2 can be made at any time,
including for a read-only workspace.]

## 4. What may be kept
Only records that must be kept by law, or are necessary for legitimate
security or audit purposes, subject to counsel review. [CONFIRM: exactly
which records (e.g. tax/GST invoices, a record of the deletion request
itself), and for how long. No period is stated in this draft.]

## 5. Backups
Deleted data may remain in backups until those backups expire under our
backup retention policy. [CONFIRM: the verified backup retention and
expiry policy once production backups are configured and checked. No
backup deletion timeline is stated here.]

## 6. Data held by others
Messages already delivered through WhatsApp/Meta, and data sent to an AI
provider a workspace configured, are held by those parties under their own
policies and are not deleted by RLB Connect.

## 7. Meta user data deletion
[CONFIRM: Meta also supports a "data deletion callback URL". It is not
implemented; the instructions-URL option (this page) is the planned route.]
