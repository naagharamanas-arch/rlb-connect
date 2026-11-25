import { describe, it, expect, vi, beforeEach } from 'vitest'

// Shared, hoisted state the module mocks close over. Reset per test.
const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  resumeAwaitingReply: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  applyMessageStatus: vi.fn(),
  state: {
    // Result the message upsert's .select() resolves to. A genuine insert
    // returns the row; a replayed delivery conflicts and returns [].
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    firstInboundUnclaimed: true,
    firstInboundClaims: 0,
    /** Row `lookupInternalIdByMetaId` resolves for a `context.id`. */
    replyContextParent: null as { id: string } | null,
    conversation: { id: 'conv-1', unread_count: 0, account_id: 'acc-1' },
    upsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    afterCallbacks: [] as (() => Promise<void> | void)[],
    automationStarted: 0,
    automationCompleted: 0,
    /** whatsapp_config.mirror_inbound_media for the matched row (#466). */
    mirrorInboundMedia: true as boolean | undefined,
    /** Objects the inbound-media mirror pushed into chat-media. */
    storageUploads: [] as {
      bucket: string
      path: string
      options: { contentType?: string }
    }[],
    /** Error the next storage upload resolves with, if any. */
    storageUploadError: null as { message: string } | null,
    /** Row `findContactByWaUserId` resolves for a BSUID lookup (#519). */
    contactByWaUserId: null as Record<string, unknown> | null,
    /** Rows inserted into `contacts`. */
    contactInserts: [] as Record<string, unknown>[],
    /** Patches applied to an existing `contacts` row. */
    contactUpdates: [] as Record<string, unknown>[],
    whatsappConfigLookups: [] as { columns: string; value: unknown }[],
    /**
     * Rows the phone_number_id lookup on `whatsapp_config` resolves to.
     * null → the default single row, registered to WABA 'WABA-1'.
     */
    whatsappConfigRows: null as Record<string, unknown>[] | null,
    /** Rows the GET handshake's verify-token query resolves to. */
    verifyConfigs: [{ id: 'cfg-1', verify_token: 'enc-token' }] as {
      id: string
      verify_token: string | null
    }[],
    /** How many times the handshake read tenants' verify tokens. */
    verifyQueries: 0,
    /** broadcast_recipients row the status webhook targets. */
    broadcastRecipient: null as { id: string; status: string } | null,
    /** Patches applied to that broadcast_recipients row. */
    recipientUpdates: [] as Record<string, unknown>[],
  },
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb)
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      switch (table) {
        case 'whatsapp_config':
          return {
            select: (columns: string) => ({
              eq: (_column: string, value: unknown) => {
                h.state.whatsappConfigLookups.push({ columns, value })
                return Promise.resolve({
                  data: h.state.whatsappConfigRows ?? [
                    {
                      account_id: 'acc-1',
                      user_id: 'user-1',
                      access_token: 'enc',
                      waba_id: 'WABA-1',
                      mirror_inbound_media: h.state.mirrorInboundMedia,
                    },
                  ],
                  error: null,
                })
              },
              // GET handshake: select('id, verify_token').not(...)
              not: () => {
                h.state.verifyQueries++
                return Promise.resolve({ data: h.state.verifyConfigs, error: null })
              },
            }),
          }
        case 'conversations':
          // findOrCreateConversation: select().eq().eq().order().limit()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [h.state.conversation],
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
            update: () => ({
              eq: () => ({
                is: () => ({
                  select: () => {
                    h.state.firstInboundClaims++
                    const won = h.state.firstInboundUnclaimed
                    h.state.firstInboundUnclaimed = false
                    return Promise.resolve({
                      data: won ? [{ id: 'conv-1' }] : [],
                      error: null,
                    })
                  },
                }),
              }),
            }),
          }
        case 'broadcast_recipients':
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({ data: [], error: null }),
                  }),
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => ({
              eq: () => ({
                in: (_column: string, allowed: string[]) => ({
                  select: () => {
                    const row = h.state.broadcastRecipient
                    const matches = !!row && allowed.includes(row.status)
                    if (matches) h.state.recipientUpdates.push(patch)
                    return Promise.resolve({
                      data: matches ? [{ id: row!.id }] : [],
                      error: null,
                    })
                  },
                }),
              }),
            }),
          }
        case 'contacts':
          // Three chains land here, all from findOrCreateContact:
          //   findContactByWaUserId: select('*').eq().eq().maybeSingle()
          //   identity backfill:     update().eq().select().maybeSingle()
          //   create:                insert().select().single()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: h.state.contactByWaUserId,
                      error: null,
                    }),
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              h.state.contactUpdates.push(patch)
              return {
                eq: () => ({
                  select: () => ({
                    maybeSingle: () =>
                      Promise.resolve({ data: null, error: null }),
                  }),
                }),
              }
            },
            insert: (row: Record<string, unknown>) => {
              h.state.contactInserts.push(row)
              return {
                select: () => ({
                  single: () =>
                    Promise.resolve({
                      data: { id: 'contact-new', ...row },
                      error: null,
                    }),
                }),
              }
            },
          }
        case 'messages':
          return {
            // lookupInternalIdByMetaId: select('id').eq().eq().maybeSingle()
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({
                      data: h.state.replyContextParent,
                      error: null,
                    }),
                }),
              }),
            }),
            // Idempotent insert: upsert(...).select('id')
            upsert: (row: Record<string, unknown>, options: unknown) => {
              h.state.upsertCalls.push({ row, options })
              return {
                select: () =>
                  Promise.resolve({
                    data: h.state.messageUpsertResult,
                    error: null,
                  }),
              }
            },
          }
        default:
          throw new Error(`unexpected table: ${table}`)
      }
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: null, error: null })
    },
    // Service-role Storage, used by the inbound-media mirror (#466).
    storage: {
      from(bucket: string) {
        return {
          upload: (
            path: string,
            _body: unknown,
            options: { contentType?: string },
          ) => {
            h.state.storageUploads.push({ bucket, path, options })
            return Promise.resolve({ error: h.state.storageUploadError })
          },
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
          }),
        }
      },
    },
  }),
}))

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'plain-token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => ({
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  })),
  isUniqueViolation: () => false,
}))

vi.mock('@/lib/whatsapp/webhook-signature', async (importOriginal) => ({
  // Keep the real helpers (verifyTokenMatches is used by the GET handshake)
  // and stub only the HMAC check, which these tests don't sign for.
  ...(await importOriginal<typeof import('@/lib/whatsapp/webhook-signature')>()),
  verifyMetaWebhookSignature: () => true,
}))
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  isTemplateWebhookField: (field: string) =>
    field.startsWith('message_template_'),
  handleTemplateWebhookChange: vi.fn(),
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
  resumeAwaitingReply: h.resumeAwaitingReply,
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}))
vi.mock('@/lib/whatsapp/message-status-sync', () => ({
  applyMessageStatus: h.applyMessageStatus,
}))

import { deriveObjectToken } from '@/lib/storage/media-server'
import { GET, POST } from './route'
import { __resetRateLimitForTests, RATE_LIMITS } from '@/lib/rate-limit'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { findExistingContact } from '@/lib/contacts/dedupe'
import { handleTemplateWebhookChange } from '@/lib/whatsapp/template-webhook'
import { MAX_WEBHOOK_BODY_BYTES } from '@/lib/whatsapp/webhook-body'

const mockGetMediaUrl = vi.mocked(getMediaUrl)
const mockDownloadMedia = vi.mocked(downloadMedia)
const mockFindExistingContact = vi.mocked(findExistingContact)

const TEXT_MESSAGE = {
  id: 'wamid.TEST1',
  from: '15551230000',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'hello' },
}

const LEGACY_CONTACTS = [{ wa_id: '15551230000', profile: { name: 'Ada' } }]

function signedPost(body: BodyInit) {
  return new Request('http://localhost/api/whatsapp/webhook', {
    method: 'POST',
    headers: { 'x-hub-signature-256': 'sha256=stub' },
    body,
  })
}

function inboundRequest(
  message: Record<string, unknown> = TEXT_MESSAGE,
  contacts: Record<string, unknown>[] = LEGACY_CONTACTS,
) {
  const body = {
    entry: [
      {
        id: 'WABA-1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              contacts,
              messages: [message],
            },
          },
        ],
      },
    ],
  }
  return signedPost(JSON.stringify(body))
}

async function runWebhook(
  message?: Record<string, unknown>,
  contacts?: Record<string, unknown>[],
) {
  const res = await POST(inboundRequest(message, contacts))
  // Drain the after() callback exactly as the runtime would.
  for (const cb of h.state.afterCallbacks) await cb()
  return res
}

/** A message-status webhook (sent / delivered / read / failed). */
async function runStatusWebhook(status: Record<string, unknown>) {
  const body = {
    entry: [
      {
        id: 'WABA-1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              statuses: [status],
            },
          },
        ],
      },
    ],
  }
  const res = await POST(signedPost(JSON.stringify(body)))
  for (const cb of h.state.afterCallbacks) await cb()
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.messageUpsertResult = [{ id: 'msg-1' }]
  h.state.firstInboundUnclaimed = true
  h.state.firstInboundClaims = 0
  h.state.replyContextParent = null
  h.state.conversation = { id: 'conv-1', unread_count: 0, account_id: 'acc-1' }
  h.state.upsertCalls = []
  h.state.rpcCalls = []
  h.state.afterCallbacks = []
  h.state.automationStarted = 0
  h.state.automationCompleted = 0
  h.state.mirrorInboundMedia = true
  h.state.storageUploads = []
  h.state.storageUploadError = null
  h.state.contactByWaUserId = null
  h.state.contactInserts = []
  h.state.contactUpdates = []
  h.state.whatsappConfigLookups = []
  h.state.whatsappConfigRows = null
  h.state.verifyConfigs = [{ id: 'cfg-1', verify_token: 'enc-token' }]
  h.state.verifyQueries = 0
  __resetRateLimitForTests()
  h.state.broadcastRecipient = null
  h.state.recipientUpdates = []
  mockFindExistingContact.mockResolvedValue({
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  })
  mockGetMediaUrl.mockResolvedValue({
    url: 'https://lookaside.fbsbx.com/whatsapp/abc',
    mimeType: 'image/jpeg',
    fileSize: 2048,
  })
  mockDownloadMedia.mockResolvedValue({
    buffer: Buffer.alloc(2048),
    contentType: 'image/jpeg',
  })
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  h.resumeAwaitingReply.mockResolvedValue(false)
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockResolvedValue(undefined)
  h.applyMessageStatus.mockResolvedValue([])
  h.runAutomationsForTrigger.mockImplementation(() => {
    h.state.automationStarted++
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        h.state.automationCompleted++
        resolve()
      }, 0)
    })
  })
})

describe('inbound webhook: idempotent insert (#367)', () => {
  it('a genuine first delivery persists once and fans out downstream', async () => {
    await runWebhook()

    // Inserted via upsert with the (conversation_id, message_id) conflict
    // target — not a bare insert.
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].options).toMatchObject({
      onConflict: 'conversation_id,message_id',
      ignoreDuplicates: true,
    })
    // Downstream side effects ran exactly once.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
  })

  it('a replayed delivery is a no-op: no unread bump, no fan-out', async () => {
    // Upsert hits the unique index and returns no row.
    h.state.messageUpsertResult = []

    await runWebhook()

    expect(h.state.upsertCalls).toHaveLength(1)
    // None of the downstream side effects fire on a replay.
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })
})

describe('inbound webhook: atomic unread bump (#369)', () => {
  it('increments unread through the DB-side RPC, not a read-modify-write', async () => {
    await runWebhook()

    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.state.rpcCalls[0]).toMatchObject({
      name: 'bump_conversation_on_inbound',
      args: { p_conversation_id: 'conv-1' },
    })
  })
})

describe('inbound webhook: template quick-reply buttons (#478)', () => {
  // A customer tapping a QUICK_REPLY button on a broadcast template.
  // `context.id` points at the template message we sent — which the
  // broadcast path never wrote to `messages`, so the parent lookup
  // legitimately misses and the reply is stored unquoted.
  const templateButtonTap = {
    id: 'wamid.BTN1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'button',
    button: { text: 'Yes, interested', payload: 'YES_INTERESTED' },
    context: { id: 'wamid.BROADCAST1' },
  }

  it('stores the tap as an interactive reply, not an unsupported message', async () => {
    await runWebhook(templateButtonTap)

    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Yes, interested',
      interactive_reply_id: 'YES_INTERESTED',
      reply_to_message_id: null,
    })
  })

  it('routes the tap to flows and fires the interactive_reply trigger', async () => {
    await runWebhook(templateButtonTap)

    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          kind: 'interactive_reply',
          reply_id: 'YES_INTERESTED',
          reply_title: 'Yes, interested',
          meta_message_id: 'wamid.BTN1',
        },
      }),
    )
    const triggers = h.runAutomationsForTrigger.mock.calls.map(
      (call) => (call[0] as { triggerType: string }).triggerType,
    )
    expect(triggers).toContain('interactive_reply')
    // The AI auto-reply must stay out of it — a button tap is not a
    // free-text question.
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('falls back to the label when the template button carries no payload', async () => {
    await runWebhook({
      ...templateButtonTap,
      button: { text: 'Track my order' },
    })

    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Track my order',
      interactive_reply_id: 'Track my order',
    })
  })
})

describe('inbound webhook: unsupported messages keep Meta’s reason', () => {
  // Meta sends `type: 'unsupported'` with no content and an `errors[0]`
  // saying why — the only account of what the customer sent, since there
  // is no endpoint to fetch the original afterwards.
  const unsupported = {
    id: 'wamid.UNSUP1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'unsupported',
    errors: [
      {
        code: 131051,
        title: 'Unsupported message type',
        message: 'Message type is not currently supported.',
        error_data: { details: 'Message type is not currently supported.' },
      },
    ],
  }

  it('stores the reason in the text and in the error columns', async () => {
    await runWebhook(unsupported)

    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_text:
        '[Unsupported message type: unsupported — Message type is not currently supported.]',
      error_code: 131051,
      error_title: 'Unsupported message type',
      error_details: 'Message type is not currently supported.',
      // Inbound rows stay 'delivered' so the thread's delivery-failure
      // banner — which gates on status 'failed' — is not triggered.
      status: 'delivered',
    })
  })

  it('falls back to the bare placeholder when Meta sends no errors', async () => {
    await runWebhook({ ...unsupported, errors: undefined })

    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_text: '[Unsupported message type: unsupported]',
      error_code: null,
      error_title: null,
      error_details: null,
    })
  })

  it('leaves the error columns null for an ordinary text message', async () => {
    await runWebhook()

    expect(h.state.upsertCalls[0].row).toMatchObject({
      error_code: null,
      error_title: null,
      error_details: null,
    })
  })
})

describe('inbound webhook: inbound media is mirrored (#466)', () => {
  const IMAGE_MESSAGE = {
    id: 'wamid.IMG1',
    from: '15551230000',
    timestamp: '1700000000',
    type: 'image',
    image: { id: '1234567890123456', mime_type: 'image/jpeg', caption: 'hi' },
  }

  it('stores a durable bucket URL instead of the expiring proxy path', async () => {
    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.storageUploads).toHaveLength(1)
    expect(h.state.storageUploads[0].bucket).toBe('chat-media')
    const token = deriveObjectToken('acc-1', '1234567890123456')
    expect(h.state.storageUploads[0].path).toBe(
      `account-acc-1/inbound/${token}-image-1700000000.jpg`,
    )
    expect(h.state.upsertCalls[0].row).toMatchObject({
      // Private bucket: a media reference, never a public URL.
      media_url: `/api/media/chat-media/account-acc-1/inbound/${token}-image-1700000000.jpg`,
      // Meta's MIME type used to be discarded outright (`void mediaType`).
      media_type: 'image/jpeg',
    })
  })

  it('falls back to the proxy URL when the upload is refused', async () => {
    h.state.storageUploadError = { message: 'mime type not supported' }

    await runWebhook(IMAGE_MESSAGE)

    // The message still lands, and it still lands with a usable URL —
    // the mirror failing must never cost us the message.
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
      media_type: 'image/jpeg',
    })
  })

  it('falls back to the proxy URL when the download from Meta throws', async () => {
    mockDownloadMedia.mockRejectedValueOnce(new Error('Media download failed: 404'))

    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
    })
  })

  it('skips media larger than the bucket accepts, without downloading it', async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/big',
      mimeType: 'application/pdf',
      fileSize: 40 * 1024 * 1024,
    })

    await runWebhook({
      id: 'wamid.DOC1',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '999',
        mime_type: 'application/pdf',
        filename: 'huge.pdf',
      },
    })

    expect(mockDownloadMedia).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/999',
      media_type: 'application/pdf',
    })
  })

  it("names the object after a document's own filename", async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://lookaside.fbsbx.com/whatsapp/doc',
      mimeType: 'application/pdf',
      fileSize: 4096,
    })
    mockDownloadMedia.mockResolvedValue({
      buffer: Buffer.alloc(4096),
      contentType: 'application/pdf',
    })

    await runWebhook({
      id: 'wamid.DOC2',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'document',
      document: {
        id: '1234567890123456',
        mime_type: 'application/pdf',
        filename: 'invoice.pdf',
        caption: 'have a look',
      },
    })

    expect(h.state.storageUploads[0].path).toBe(
      `account-acc-1/inbound/${deriveObjectToken('acc-1', '1234567890123456')}-invoice.pdf`,
    )
  })

  it('does not mirror when the account has opted out', async () => {
    h.state.mirrorInboundMedia = false

    await runWebhook(IMAGE_MESSAGE)

    expect(mockDownloadMedia).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: '/api/whatsapp/media/1234567890123456',
      // Still recorded — the MIME type costs nothing and makes the
      // download name right even for proxied media.
      media_type: 'image/jpeg',
    })
  })

  it('mirrors when the column is absent, e.g. a row read before migration 039', async () => {
    h.state.mirrorInboundMedia = undefined

    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.storageUploads).toHaveLength(1)
  })

  it('leaves text messages alone', async () => {
    await runWebhook()

    expect(mockGetMediaUrl).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({ media_type: null })
  })
})

describe('inbound webhook: after() awaits automations (#368)', () => {
  it('every triggered automation settles before the after() callback resolves', async () => {
    await runWebhook()

    // first_inbound_message + new_message_received + keyword_match.
    expect(h.state.automationStarted).toBe(3)
    // If the dispatches were fire-and-forget, completed would still be 0
    // here — the callback would have resolved before the timers fired.
    expect(h.state.automationCompleted).toBe(3)
  })
})

// ============================================================
// Business-scoped user IDs (issue #519)
//
// Meta stopped sending the phone number for a customer who has adopted
// a WhatsApp username: `messages[].from` and `contacts[].wa_id` are
// both absent, and only `from_user_id` / `user_id` identify them.
//
// Before the fix, `normalizePhone(undefined)` gave '', which
// `findExistingContact` refuses to look up, so every such delivery
// inserted a NEW contact — and migration 022's unique index is partial
// (`WHERE phone_normalized <> ''`) so nothing stopped it. One contact
// and one conversation per inbound message.
// ============================================================

const USERNAME_ONLY_MESSAGE = {
  id: 'wamid.BSUID1',
  from_user_id: 'US.13491208655302741918',
  from_parent_user_id: 'US.ENT.11815799212886844830',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'does it come in another color?' },
}

const USERNAME_ONLY_CONTACTS = [
  {
    profile: { name: 'Sheena Nelson', username: 'realsheenanelson' },
    user_id: 'US.13491208655302741918',
    parent_user_id: 'US.ENT.11815799212886844830',
  },
]

describe('inbound webhook: business-scoped user IDs (#519)', () => {
  it('creates ONE contact keyed on the BSUID when Meta sends no phone', async () => {
    // Nothing on file under either key yet.
    h.state.contactByWaUserId = null
    mockFindExistingContact.mockResolvedValue(null)

    await runWebhook(USERNAME_ONLY_MESSAGE, USERNAME_ONLY_CONTACTS)

    expect(h.state.contactInserts).toHaveLength(1)
    expect(h.state.contactInserts[0]).toMatchObject({
      account_id: 'acc-1',
      phone: '',
      wa_user_id: 'US.13491208655302741918',
      wa_parent_user_id: 'US.ENT.11815799212886844830',
      wa_username: 'realsheenanelson',
      name: 'Sheena Nelson',
    })
    // The message still lands in the thread.
    expect(h.state.upsertCalls).toHaveLength(1)
  })

  it('never looks the sender up by phone when there is no phone', async () => {
    h.state.contactByWaUserId = null
    mockFindExistingContact.mockResolvedValue(null)

    await runWebhook(USERNAME_ONLY_MESSAGE, USERNAME_ONLY_CONTACTS)

    // The old code called this with '' and got null every time, which
    // is exactly how the duplicate contacts got created.
    expect(mockFindExistingContact).not.toHaveBeenCalled()
  })

  it('reuses the existing contact on the SECOND message from the same BSUID', async () => {
    // The row the first message created.
    h.state.contactByWaUserId = {
      id: 'contact-bsuid',
      name: 'Sheena Nelson',
      phone: '',
      wa_user_id: 'US.13491208655302741918',
      wa_parent_user_id: 'US.ENT.11815799212886844830',
      wa_username: 'realsheenanelson',
    }
    mockFindExistingContact.mockResolvedValue(null)

    await runWebhook(
      { ...USERNAME_ONLY_MESSAGE, id: 'wamid.BSUID2' },
      USERNAME_ONLY_CONTACTS,
    )

    expect(h.state.contactInserts).toHaveLength(0)
    // Nothing about the identity changed, so no pointless UPDATE either.
    expect(h.state.contactUpdates).toHaveLength(0)
  })

  it('backfills the BSUID onto a contact we already knew by phone', async () => {
    // Transition payload: Meta sends both keys. We match on the phone
    // and stamp the BSUID so the next phone-less message still finds
    // this row instead of forking a new one.
    mockFindExistingContact.mockResolvedValue({
      id: 'contact-1',
      name: 'Pablo',
      phone: '16505551234',
    })

    await runWebhook(
      {
        id: 'wamid.BOTH',
        from: '16505551234',
        from_user_id: 'US.13491208655302741918',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'hi' },
      },
      [
        {
          profile: { name: 'Pablo', username: 'pablomorales' },
          wa_id: '16505551234',
          user_id: 'US.13491208655302741918',
        },
      ],
    )

    expect(h.state.contactInserts).toHaveLength(0)
    expect(h.state.contactUpdates).toHaveLength(1)
    expect(h.state.contactUpdates[0]).toMatchObject({
      wa_user_id: 'US.13491208655302741918',
      wa_username: 'pablomorales',
    })
    // The number we already had is left alone.
    expect(h.state.contactUpdates[0]).not.toHaveProperty('phone')
  })

  it('fills in the phone once Meta finally discloses it', async () => {
    h.state.contactByWaUserId = {
      id: 'contact-bsuid',
      name: 'Sheena Nelson',
      phone: '',
      wa_user_id: 'US.13491208655302741918',
      wa_username: 'realsheenanelson',
    }

    await runWebhook(
      {
        ...USERNAME_ONLY_MESSAGE,
        id: 'wamid.BSUID3',
        from: '16505551234',
      },
      USERNAME_ONLY_CONTACTS,
    )

    expect(h.state.contactUpdates).toHaveLength(1)
    expect(h.state.contactUpdates[0]).toMatchObject({ phone: '16505551234' })
  })

  it('drops a delivery that carries neither key rather than inventing a contact', async () => {
    mockFindExistingContact.mockResolvedValue(null)

    const res = await runWebhook(
      {
        id: 'wamid.ANON',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'who am i' },
      },
      [{ profile: { name: 'Nobody' } }],
    )

    expect(h.state.contactInserts).toHaveLength(0)
    expect(h.state.upsertCalls).toHaveLength(0)
    // Still a 200 — Meta must not be told to retry a payload we can
    // never process.
    expect(
      (res as unknown as { init?: { status?: number } }).init?.status,
    ).toBe(200)
  })

  it('leaves the legacy phone-only payload behaving exactly as before', async () => {
    await runWebhook()

    expect(mockFindExistingContact).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      '15551230000',
    )
    expect(h.state.contactInserts).toHaveLength(0)
    expect(h.state.contactUpdates).toHaveLength(0)
    expect(h.state.upsertCalls).toHaveLength(1)
  })
})

describe('inbound webhook: contact name backfill (#519 regression guard)', () => {
  it('never overwrites an edited name with the phone number', async () => {
    // Meta sends no profile name. The display fallback would resolve to
    // the phone number, and writing that back would replace whatever an
    // agent typed on the contact — on every single inbound message.
    mockFindExistingContact.mockResolvedValue({
      id: 'contact-1',
      name: 'Ada (VIP, calls Mondays)',
      phone: '15551230000',
    })

    await runWebhook(TEXT_MESSAGE, [{ wa_id: '15551230000', profile: {} }])

    expect(h.state.contactUpdates).toHaveLength(0)
  })

  it('does adopt a username when that is all Meta gives us', async () => {
    mockFindExistingContact.mockResolvedValue({
      id: 'contact-1',
      name: '15551230000',
      phone: '15551230000',
    })

    await runWebhook(TEXT_MESSAGE, [
      { wa_id: '15551230000', profile: { username: 'ada' } },
    ])

    expect(h.state.contactUpdates[0]).toMatchObject({ name: 'ada' })
  })
})

describe('template-lifecycle webhooks: WABA id is threaded to the handler (#534)', () => {
  it('passes entry.id as wabaId so an unknown template can be stubbed for the right account', async () => {
    const value = {
      event: 'APPROVED',
      message_template_id: '4242',
      message_template_name: 'created_in_meta',
      message_template_language: 'en_US',
    }
    const body = {
      entry: [
        {
          id: 'WABA-1',
          changes: [{ field: 'message_template_status_update', value }],
        },
      ],
    }
    const req = signedPost(JSON.stringify(body))

    await POST(req)
    for (const cb of h.state.afterCallbacks) await cb()

    const mockHandle = vi.mocked(handleTemplateWebhookChange)
    expect(mockHandle).toHaveBeenCalledTimes(1)
    expect(mockHandle.mock.calls[0][0]).toEqual({
      field: 'message_template_status_update',
      value,
      wabaId: 'WABA-1',
    })
    // A template event must not fall through to the messaging branch.
    expect(h.state.upsertCalls).toHaveLength(0)
  })
})

describe('status webhook: failed statuses keep Meta\'s reason (#535)', () => {
  const FAILED_STATUS = {
    id: 'wamid.OUT1',
    status: 'failed',
    timestamp: '1700000100',
    recipient_id: '15551230000',
    errors: [
      {
        code: 131049,
        title: 'This message was not delivered to maintain healthy ecosystem engagement.',
        message: 'This message was not delivered to maintain healthy ecosystem engagement.',
        error_data: {
          details:
            'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
        },
        href: 'https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/',
      },
    ],
  }

  it('hands code, title and details to the message status sync with the status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runStatusWebhook(FAILED_STATUS)
    } finally {
      warn.mockRestore()
    }

    expect(h.applyMessageStatus).toHaveBeenCalledTimes(1)
    expect(h.applyMessageStatus.mock.calls[0][2]).toEqual({
      wamid: 'wamid.OUT1',
      status: 'failed',
      failure: {
        code: 131049,
        title: FAILED_STATUS.errors[0].title,
        details: FAILED_STATUS.errors[0].error_data.details,
      },
      statusAt: new Date(1700000100 * 1000).toISOString(),
    })
  })

  it('logs one warning line carrying the wamid, code and title', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runStatusWebhook(FAILED_STATUS)
      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0][0])
      expect(line).toContain('wamid.OUT1')
      expect(line).toContain('131049')
      expect(line).toContain(FAILED_STATUS.errors[0].title)
      expect(line).toContain(FAILED_STATUS.errors[0].error_data.details)
    } finally {
      warn.mockRestore()
    }
  })

  it('folds the reason into broadcast_recipients.error_message', async () => {
    h.state.broadcastRecipient = { id: 'rec-1', status: 'sent' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runStatusWebhook(FAILED_STATUS)
    } finally {
      warn.mockRestore()
    }

    expect(h.state.recipientUpdates).toHaveLength(1)
    expect(h.state.recipientUpdates[0].status).toBe('failed')
    const reason = String(h.state.recipientUpdates[0].error_message)
    expect(reason).toContain('131049')
    expect(reason).toContain(FAILED_STATUS.errors[0].title)
    expect(reason).toContain(FAILED_STATUS.errors[0].error_data.details)
  })

  it('a failed status with no errors array still flips status and stores no reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runStatusWebhook({ ...FAILED_STATUS, errors: undefined })
    } finally {
      warn.mockRestore()
    }
    expect(warn).not.toHaveBeenCalled()
    expect(h.applyMessageStatus.mock.calls[0][2]).toMatchObject({
      status: 'failed',
      failure: null,
    })
  })

  it('a plain delivered status updates only status — error columns untouched', async () => {
    h.state.broadcastRecipient = { id: 'rec-1', status: 'sent' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runStatusWebhook({
        id: 'wamid.OUT1',
        status: 'delivered',
        timestamp: '1700000100',
        recipient_id: '15551230000',
      })
    } finally {
      warn.mockRestore()
    }

    expect(warn).not.toHaveBeenCalled()
    expect(h.applyMessageStatus.mock.calls[0][2]).toMatchObject({
      status: 'delivered',
      failure: null,
    })
    expect(h.state.recipientUpdates).toHaveLength(1)
    expect(h.state.recipientUpdates[0]).not.toHaveProperty('error_message')
    expect(h.state.recipientUpdates[0]).not.toHaveProperty('error_code')
  })

  it('a late delivered status never regresses a recipient that is already read', async () => {
    h.state.broadcastRecipient = { id: 'rec-1', status: 'read' }
    await runStatusWebhook({
      id: 'wamid.OUT1',
      status: 'delivered',
      timestamp: '1700000100',
      recipient_id: '15551230000',
    })

    expect(h.applyMessageStatus.mock.calls[0][2]).toMatchObject({
      status: 'delivered',
    })
    expect(h.state.recipientUpdates).toHaveLength(0)
  })
})

describe('inbound webhook: automation waiting for a reply', () => {
  const triggersFired = () =>
    h.runAutomationsForTrigger.mock.calls.map(
      (call) => (call[0] as { triggerType: string }).triggerType,
    )

  it('offers the message to a waiting automation before any trigger fires', async () => {
    await runWebhook()

    expect(h.resumeAwaitingReply).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ message_text: 'hello' }),
      }),
    )
    // Nothing was waiting, so the content triggers fire as normal.
    expect(triggersFired()).toEqual(
      expect.arrayContaining(['new_message_received', 'keyword_match']),
    )
  })

  it('suppresses content triggers and AI reply when a waiting automation took it', async () => {
    h.resumeAwaitingReply.mockResolvedValue(true)

    await runWebhook()

    expect(triggersFired()).not.toContain('new_message_received')
    expect(triggersFired()).not.toContain('keyword_match')
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('leaves the message to a flow that consumed it', async () => {
    h.dispatchInboundToFlows.mockResolvedValue({ consumed: true })

    await runWebhook()

    expect(h.resumeAwaitingReply).not.toHaveBeenCalled()
  })
})

describe('inbound webhook: oversized body cap', () => {
  it('answers 413 for a body over the cap and schedules no processing', async () => {
    const before = h.state.afterCallbacks.length
    const res = (await POST(signedPost('x'.repeat(MAX_WEBHOOK_BODY_BYTES + 1)))) as unknown as {
      init?: { status?: number }
    }
    expect(res.init?.status).toBe(413)
    expect(h.state.afterCallbacks).toHaveLength(before)
  })

  it('answers 413 from the declared Content-Length alone', async () => {
    const before = h.state.afterCallbacks.length
    const req = new Request('http://localhost/api/whatsapp/webhook', {
      method: 'POST',
      headers: { 'content-length': String(MAX_WEBHOOK_BODY_BYTES + 1), 'x-hub-signature-256': 'sha256=stub' },
      body: '{}',
    })
    const res = (await POST(req)) as unknown as { init?: { status?: number } }
    expect(res.init?.status).toBe(413)
    expect(h.state.afterCallbacks).toHaveLength(before)
  })

  it('lets a body at the cap through to JSON parsing', async () => {
    const res = (await POST(signedPost('x'.repeat(MAX_WEBHOOK_BODY_BYTES)))) as unknown as {
      init?: { status?: number }
    }
    expect(res.init?.status).toBe(400)
  })
})

describe('status webhook: scoped to the receiving number', () => {
  const DELIVERED = {
    id: 'wamid.OUT1',
    status: 'delivered',
    timestamp: '1700000100',
    recipient_id: '15551230000',
  }

  it('resolves the account from metadata.phone_number_id before touching messages', async () => {
    await runStatusWebhook(DELIVERED)

    expect(h.state.whatsappConfigLookups).toEqual([
      { columns: 'account_id, waba_id', value: 'pn-1' },
    ])
    expect(h.applyMessageStatus).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      expect.objectContaining({ wamid: 'wamid.OUT1' }),
    )
  })

  it('dispatches message.status_updated to that account for each row that advanced', async () => {
    h.applyMessageStatus.mockResolvedValue([{ id: 'm1', conversation_id: 'conv-9' }])

    await runStatusWebhook(DELIVERED)

    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent.mock.calls[0].slice(1)).toEqual([
      'acc-1',
      'message.status_updated',
      {
        whatsapp_message_id: 'wamid.OUT1',
        conversation_id: 'conv-9',
        status: 'delivered',
      },
    ])
  })

  it('dispatches nothing when the status was stale and moved no row', async () => {
    await runStatusWebhook(DELIVERED)
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })
})

describe('inbound webhook: first_inbound_message fires once', () => {
  const firstInboundRuns = () =>
    h.runAutomationsForTrigger.mock.calls.filter(
      ([arg]) => arg.triggerType === 'first_inbound_message',
    ).length

  it('claims the conversation atomically so a concurrent second message does not refire it', async () => {
    await runWebhook()
    h.state.afterCallbacks = []
    await runWebhook({ ...TEXT_MESSAGE, id: 'wamid.TEST2' })

    expect(h.state.firstInboundClaims).toBe(2)
    expect(firstInboundRuns()).toBe(1)
  })

  it('does not claim on a replayed delivery', async () => {
    h.state.messageUpsertResult = []
    await runWebhook()
    expect(h.state.firstInboundClaims).toBe(0)
  })
})

// ── Cross-tenant routing: phone_number_id must agree with entry.id (WABA) ──

const CFG_WABA_A = {
  account_id: 'acc-1',
  user_id: 'user-1',
  access_token: 'enc',
  mirror_inbound_media: true,
  waba_id: 'WABA-A',
}

function entryBody(
  entryId: string | undefined,
  value: Record<string, unknown>,
  phoneNumberId = 'pn-1',
) {
  return {
    entry: [
      {
        ...(entryId === undefined ? {} : { id: entryId }),
        changes: [
          { field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, ...value } },
        ],
      },
    ],
  }
}

async function runEntry(body: unknown) {
  const res = await POST(signedPost(JSON.stringify(body)))
  for (const cb of h.state.afterCallbacks) await cb()
  return res as unknown as { init?: { status?: number }; body?: unknown }
}

const INBOUND_VALUE = { contacts: LEGACY_CONTACTS, messages: [TEXT_MESSAGE] }
const STATUS_VALUE = {
  statuses: [
    { id: 'wamid.OUT9', status: 'delivered', timestamp: '1700000100', recipient_id: '15551230000' },
  ],
}

describe('inbound webhook: WABA / phone-number cross-check', () => {
  it('routes a message whose entry.id matches the workspace stored WABA', async () => {
    h.state.whatsappConfigRows = [CFG_WABA_A]
    await runEntry(entryBody('WABA-A', INBOUND_VALUE))
    expect(h.state.upsertCalls).toHaveLength(1)
  })

  it('DROPS a message delivered for that number under a different WABA (nothing is stored or fanned out)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.state.whatsappConfigRows = [CFG_WABA_A]
    const res = await runEntry(entryBody('WABA-EVIL', INBOUND_VALUE))

    expect(res.init?.status).toBe(200) // Meta is still acknowledged: no retry storm
    expect(h.state.upsertCalls).toHaveLength(0)
    expect(h.state.contactInserts).toHaveLength(0)
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
    const logged = error.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('rejected')
    expect(logged).toContain('WABA-A')
    expect(logged).toContain('WABA-EVIL')
    // ids only: no token material in the log line
    expect(logged).not.toContain('plain-token')
  })

  it('still routes a legacy row that has no stored WABA (cannot be verified, must not be dropped)', async () => {
    h.state.whatsappConfigRows = [{ ...CFG_WABA_A, waba_id: null }]
    await runEntry(entryBody('WABA-ANY', INBOUND_VALUE))
    expect(h.state.upsertCalls).toHaveLength(1)
  })

  it('FAILS CLOSED when the envelope carries no entry.id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.state.whatsappConfigRows = [CFG_WABA_A]
    await runEntry(entryBody(undefined, INBOUND_VALUE))
    expect(h.state.upsertCalls).toHaveLength(0)
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
    expect(error.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('no entry.id')
  })

  it('with WHATSAPP_REQUIRE_STORED_WABA=1 a legacy row with no stored WABA is dropped', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('WHATSAPP_REQUIRE_STORED_WABA', '1')
    try {
      h.state.whatsappConfigRows = [{ ...CFG_WABA_A, waba_id: null }]
      await runEntry(entryBody('WABA-A', INBOUND_VALUE))
      expect(h.state.upsertCalls).toHaveLength(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('drops a message with no metadata.phone_number_id (no TypeError, no DB lookup, non-sensitive warning)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.state.whatsappConfigRows = [CFG_WABA_A]
    const lookupsBefore = h.state.whatsappConfigLookups.length
    const res = await runEntry({
      entry: [
        {
          id: 'WABA-A',
          changes: [{ field: 'messages', value: { metadata: {}, ...INBOUND_VALUE } }],
        },
      ],
    })
    expect(res.init?.status).toBe(200)
    expect(h.state.upsertCalls).toHaveLength(0)
    expect(h.state.whatsappConfigLookups).toHaveLength(lookupsBefore)
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('Inbound message without metadata.phone_number_id')
    expect(logged).toContain('WABA-A')
    expect(logged).not.toContain('plain-token')
  })

  it('drops a message with no metadata object at all (no TypeError)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.state.whatsappConfigRows = [CFG_WABA_A]
    const res = await runEntry({
      entry: [{ id: 'WABA-A', changes: [{ field: 'messages', value: { ...INBOUND_VALUE } }] }],
    })
    expect(res.init?.status).toBe(200)
    expect(h.state.upsertCalls).toHaveLength(0)
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain(
      'Inbound message without metadata.phone_number_id',
    )
  })

  it('drops a message when two configs claim the same phone_number_id (never picks one)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.state.whatsappConfigRows = [CFG_WABA_A, { ...CFG_WABA_A, account_id: 'acc-2', user_id: 'user-2' }]
    await runEntry(entryBody('WABA-A', INBOUND_VALUE))
    expect(h.state.upsertCalls).toHaveLength(0)
    expect(error.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('matched 2 configs')
  })

  it('drops a message for a phone number no workspace owns', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.state.whatsappConfigRows = []
    await runEntry(entryBody('WABA-A', INBOUND_VALUE))
    expect(h.state.upsertCalls).toHaveLength(0)
  })
})

describe('status webhook: WABA / phone-number cross-check', () => {
  it('applies a status to the workspace when the WABA matches', async () => {
    h.state.whatsappConfigRows = [CFG_WABA_A]
    await runEntry(entryBody('WABA-A', STATUS_VALUE))
    expect(h.applyMessageStatus).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      expect.objectContaining({ wamid: 'wamid.OUT9' }),
    )
  })

  it('does NOT apply a status delivered under a different WABA', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.state.whatsappConfigRows = [CFG_WABA_A]
    await runEntry(entryBody('WABA-EVIL', STATUS_VALUE))
    expect(h.applyMessageStatus).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('does NOT apply a status when the envelope has no entry.id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.state.whatsappConfigRows = [CFG_WABA_A]
    await runEntry(entryBody(undefined, STATUS_VALUE))
    expect(h.applyMessageStatus).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('drops a status with no metadata.phone_number_id, with a non-sensitive warning and no DB lookup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.state.whatsappConfigRows = [CFG_WABA_A]
    await runEntry({
      entry: [{ id: 'WABA-A', changes: [{ field: 'messages', value: { ...STATUS_VALUE } }] }],
    })
    expect(h.applyMessageStatus).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('without metadata.phone_number_id')
    expect(logged).toContain('WABA-A')
    expect(logged).not.toContain('plain-token')
  })

  it('does not apply a status when two configs claim the number', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.state.whatsappConfigRows = [CFG_WABA_A, { ...CFG_WABA_A, account_id: 'acc-2' }]
    await runEntry(entryBody('WABA-A', STATUS_VALUE))
    expect(h.applyMessageStatus).not.toHaveBeenCalled()
  })
})

describe('template webhook: tenant resolution input', () => {
  it('hands entry.id to the template handler as the WABA id (the only tenant key it may use)', async () => {
    const mockHandle = vi.mocked(handleTemplateWebhookChange)
    const body = {
      entry: [
        {
          id: 'WABA-TPL',
          changes: [
            {
              field: 'message_template_status_update',
              value: { event: 'APPROVED', message_template_id: '1' },
            },
          ],
        },
      ],
    }
    await runEntry(body)
    expect(mockHandle).toHaveBeenCalledTimes(1)
    expect(mockHandle.mock.calls[0][0]).toMatchObject({
      field: 'message_template_status_update',
      wabaId: 'WABA-TPL',
    })
  })
})

// ── GET: subscription handshake ──────────────────────────────────────────

function verifyRequest(params: Record<string, string>, ip = '203.0.113.7') {
  const url = new URL('http://localhost/api/whatsapp/webhook')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new Request(url, { headers: { 'x-real-ip': ip } })
}
const HANDSHAKE = {
  'hub.mode': 'subscribe',
  'hub.challenge': 'abc123',
  'hub.verify_token': 'plain-token',
}

describe('webhook verification handshake (GET)', () => {
  const statusOf = (r: unknown) => (r as { init?: { status?: number } }).init?.status

  it('answers the challenge when a stored verify token matches', async () => {
    const res = (await GET(verifyRequest(HANDSHAKE))) as Response
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('abc123')
  })

  it('rejects a wrong token with 403', async () => {
    h.state.verifyConfigs = [{ id: 'cfg-1', verify_token: 'enc-token' }]
    // decrypt() is mocked to always return plain-token, so present a different one
    const res = await GET(verifyRequest({ ...HANDSHAKE, 'hub.verify_token': 'nope' }))
    expect(statusOf(res)).toBe(403)
  })

  it('rejects malformed requests with 400 and never reads tenant tokens', async () => {
    const res = await GET(verifyRequest({ 'hub.mode': 'subscribe' }))
    expect(statusOf(res)).toBe(400)
    expect(h.state.verifyQueries).toBe(0)
  })

  it('reads the token-bearing configs once per handshake', async () => {
    await GET(verifyRequest(HANDSHAKE))
    expect(h.state.verifyQueries).toBe(1)
  })

  it('rate-limits per client IP and stops touching the database once limited', async () => {
    const limit = RATE_LIMITS.webhookVerify.limit
    for (let i = 0; i < limit; i++) await GET(verifyRequest(HANDSHAKE, '198.51.100.9'))
    expect(h.state.verifyQueries).toBe(limit)

    const blocked = await GET(verifyRequest(HANDSHAKE, '198.51.100.9'))
    expect(statusOf(blocked)).toBe(429)
    expect(h.state.verifyQueries).toBe(limit) // no extra DB read

    // a different client is unaffected
    const other = (await GET(verifyRequest(HANDSHAKE, '198.51.100.10'))) as Response
    expect(other.status).toBe(200)
  })
})
