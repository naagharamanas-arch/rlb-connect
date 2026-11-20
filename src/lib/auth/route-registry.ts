/**
 * Authorization registry for every HTTP route handler under src/app (route.ts).
 *
 * One entry per route file. A route that is not listed here FAILS the route-authorization
 * test, so a new endpoint cannot ship without its authentication being declared and
 * reviewed. The test also verifies each declaration against the source (the guard calls
 * really are in the file, and every exported HTTP method contains one).
 *
 *   role            requireRole(<min role>) — `roles` lists every minimum role used
 *   member          getCurrentAccount() — any signed-in member of an account
 *   apikey          requireApiKey(<scope>) — API-key Bearer auth
 *   cron            shared CRON_SECRET
 *   meta-signature  verified Meta webhook signature / verify token
 *   session         signed-in user checked inline (no account needed)
 *   public          NO authentication, by design — `reason` is mandatory
 *
 * `serviceRole: true` marks a route that uses the service-role client; such a route
 * must also carry a real guard (never `public`).
 */
export type RouteAuth = 'role' | 'member' | 'apikey' | 'cron' | 'meta-signature' | 'session' | 'public'
export type RouteRole = 'viewer' | 'agent' | 'admin' | 'owner'

export interface RouteRule {
  auth: RouteAuth[]
  roles?: RouteRole[]
  serviceRole?: boolean
  reason?: string
}

export const ROUTE_REGISTRY: Record<string, RouteRule> = {
  'api/account/api-keys/[id]/route.ts': { auth: ['role'], roles: ['admin'] },
  'api/account/api-keys/route.ts': { auth: ['role', 'member'], roles: ['admin'] },
  'api/account/invitations/[id]/route.ts': { auth: ['role'], roles: ['admin'] },
  'api/account/invitations/route.ts': { auth: ['role'], roles: ['admin'] },
  'api/account/members/[userId]/route.ts': { auth: ['role'], roles: ['admin'] },
  'api/account/members/route.ts': { auth: ['member'] },
  'api/account/route.ts': { auth: ['role', 'member'], roles: ['admin'] },
  'api/account/transfer-ownership/route.ts': { auth: ['role'], roles: ['owner'] },
  'api/ai/autoreply/[conversationId]/route.ts': { auth: ['role'], roles: ['agent'] },
  'api/ai/config/route.ts': { auth: ['role', 'member'], roles: ['admin'] , serviceRole: true},
  'api/ai/draft/route.ts': { auth: ['role'], roles: ['agent'] , serviceRole: true},
  'api/ai/knowledge/[id]/route.ts': { auth: ['role', 'member'], roles: ['admin'] , serviceRole: true},
  'api/ai/knowledge/reindex/route.ts': { auth: ['role'], roles: ['admin'] , serviceRole: true},
  'api/ai/knowledge/route.ts': { auth: ['role', 'member'], roles: ['admin'] , serviceRole: true},
  'api/ai/playground/route.ts': { auth: ['role'], roles: ['agent'] , serviceRole: true},
  'api/ai/test/route.ts': { auth: ['role'], roles: ['admin'] , serviceRole: true},
  'api/ai/usage/route.ts': { auth: ['role'], roles: ['admin'] },
  'api/automations/[id]/duplicate/route.ts': { auth: ['role'], roles: ['agent'] , serviceRole: true},
  'api/automations/[id]/route.ts': { auth: ['role', 'member'], roles: ['agent'] , serviceRole: true},
  'api/automations/cron/route.ts': { auth: ['cron'] , serviceRole: true},
  'api/automations/engine/route.ts': { auth: ['role'], roles: ['agent'] },
  'api/automations/route.ts': { auth: ['role'], roles: ['agent'] , serviceRole: true},
  'api/contacts/[id]/tags/route.ts': { auth: ['role'], roles: ['agent'] },
  'api/flows/[id]/activate/route.ts': { auth: ['role'], roles: ['agent'] , serviceRole: true},
  'api/flows/[id]/route.ts': { auth: ['role'], roles: ['agent'] , serviceRole: true},
  'api/flows/[id]/runs/route.ts': { auth: ['session'] },
  'api/flows/cron/route.ts': { auth: ['cron'] , serviceRole: true},
  'api/flows/route.ts': { auth: ['role'], roles: ['agent'] , serviceRole: true},
  'api/flows/templates/route.ts': { auth: ['session'] },
  'api/invitations/[token]/peek/route.ts': { auth: ['public'], reason: 'Invitation preview: returns a fixed-shape JSON for a secret token only; no account data without the token' },
  'api/invitations/[token]/redeem/route.ts': { auth: ['session'] },
  'api/media/[bucket]/[...path]/route.ts': { auth: ['member'] },
  'api/quick-replies/[id]/route.ts': { auth: ['role'], roles: ['agent'] , serviceRole: true},
  'api/quick-replies/route.ts': { auth: ['role', 'member'], roles: ['agent'] , serviceRole: true},
  'api/v1/broadcasts/[id]/route.ts': { auth: ['apikey'] },
  'api/v1/broadcasts/route.ts': { auth: ['apikey'] },
  'api/v1/contacts/[id]/route.ts': { auth: ['apikey'] },
  'api/v1/contacts/route.ts': { auth: ['apikey'] },
  'api/v1/conversations/[id]/messages/route.ts': { auth: ['apikey'] , serviceRole: true},
  'api/v1/conversations/[id]/route.ts': { auth: ['apikey'] },
  'api/v1/conversations/route.ts': { auth: ['apikey'] },
  'api/v1/me/route.ts': { auth: ['apikey'] },
  'api/v1/messages/route.ts': { auth: ['apikey'] },
  'api/v1/webhooks/[id]/route.ts': { auth: ['apikey'] },
  'api/v1/webhooks/route.ts': { auth: ['apikey'] },
  'api/whatsapp/broadcast/[id]/resume/route.ts': { auth: ['role'], roles: ['agent'] , serviceRole: true},
  'api/whatsapp/broadcast/route.ts': { auth: ['role'], roles: ['agent'] , serviceRole: true},
  'api/whatsapp/config/route.ts': { auth: ['role'], roles: ['admin'] , serviceRole: true},
  'api/whatsapp/config/verify-registration/route.ts': { auth: ['session'] , serviceRole: true},
  'api/whatsapp/health/route.ts': { auth: ['member'] , serviceRole: true},
  'api/whatsapp/media/[mediaId]/route.ts': { auth: ['session'] , serviceRole: true},
  'api/whatsapp/react/route.ts': { auth: ['role'], roles: ['agent'] , serviceRole: true},
  'api/whatsapp/send/route.ts': { auth: ['role'], roles: ['agent'] },
  'api/whatsapp/templates/[id]/route.ts': { auth: ['role'], roles: ['admin'] , serviceRole: true},
  'api/whatsapp/templates/submit/route.ts': { auth: ['role'], roles: ['admin'] , serviceRole: true},
  'api/whatsapp/templates/sync/route.ts': { auth: ['role'], roles: ['admin'] , serviceRole: true},
  'api/whatsapp/webhook/route.ts': { auth: ['meta-signature'] , serviceRole: true},
  'auth/callback/route.ts': { auth: ['public'], reason: 'OAuth/magic-link code exchange: establishes the session, so cannot require one' },
}
