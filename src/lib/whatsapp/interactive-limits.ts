/**
 * Meta limits for interactive messages, hard-coded so violations fail at
 * build/save time rather than as a 400 from the Meta API mid-conversation. See:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages
 *
 * CLIENT-SAFE: constants only, no imports. Browser components and the pre-flight
 * validators import the limits from HERE; `meta-api.ts` (which signs private media
 * and talks to Meta, and is therefore server-only) re-exports them for the senders.
 * Importing `meta-api.ts` from a `"use client"` module would drag server-only
 * storage code into the browser bundle, which the build now refuses.
 */
export const INTERACTIVE_LIMITS = {
  maxButtons: 3,
  buttonTitleMaxLength: 20,
  maxListSections: 10,
  maxListRowsTotal: 10,
  listRowTitleMaxLength: 24,
  listRowDescriptionMaxLength: 72,
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
} as const
