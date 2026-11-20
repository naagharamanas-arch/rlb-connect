// Shared helpers for the full-stack authorization job (tests/fullstack/*).
//
// No dependencies beyond what the app already ships (@supabase/supabase-js) and
// Node's built-ins (fetch, node:test, node:assert). Runs ONLY against the
// ephemeral Supabase stack + Next server that .github/workflows/fullstack-authz.yml
// starts on a throw-away CI runner. Refuses to run against anything else.
import { existsSync, readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

export const NIL = '00000000-0000-4000-8000-000000000000'

function need(name) {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required (set by the fullstack-authz workflow)`)
  return v
}

export const E = {
  get api() { return need('FS_API_URL') },
  get anon() { return need('FS_ANON_KEY') },
  get service() { return need('FS_SERVICE_ROLE_KEY') },
  get app() { return need('FS_APP_URL') },
  get cron() { return need('AUTOMATION_CRON_SECRET') },
  get metaSecret() { return need('META_APP_SECRET') },
  get worldFile() { return need('FS_WORLD_FILE') },
}

/** Safety: only a local ephemeral stack on a CI runner. */
export function assertEphemeral() {
  const host = new URL(E.api).hostname
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    throw new Error(`refusing to run against non-local Supabase host ${host}`)
  }
  if (process.env.FS_ALLOW_LOCAL !== '1') {
    throw new Error('set FS_ALLOW_LOCAL=1 (done by the CI workflow) to confirm this is a throw-away stack')
  }
}

const authOpts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

export const adminClient = () => createClient(E.api, E.service, authOpts)
export const anonClient = () => createClient(E.api, E.anon, authOpts)

/**
 * supabase-js client acting as a signed-in user (RLS applies) for REST and Storage.
 * `accessToken` is the supported way to hand supabase-js an externally issued JWT.
 *
 * REALTIME needs one more step — use `realtimeUserClient` below. Measured against the
 * local stack: with only an Authorization header, or only the `accessToken` option, the
 * Realtime socket joins as `anon` (visible as `claims_role = anon` in realtime.subscription)
 * and every postgres_changes event arrives as `errors: ["Error 401: Unauthorized"]`, so a
 * tenant's own events never reach it.
 */
export function userClient(accessToken) {
  return createClient(E.api, E.anon, { ...authOpts, accessToken: async () => accessToken })
}

/** A signed-in client whose Realtime socket really authenticates as the user. */
export async function realtimeUserClient(accessToken) {
  const client = userClient(accessToken)
  await client.realtime.setAuth(accessToken)
  return client
}

export function loadWorld() {
  return JSON.parse(readFileSync(E.worldFile, 'utf8'))
}

/**
 * The cookie @supabase/ssr reads: `sb-<ref>-auth-token`, base64url-encoded with the
 * `base64-` prefix, split into 3180-character chunks (`.0`, `.1`, ...).
 */
export function sessionCookie(session) {
  const name = `sb-${new URL(E.api).hostname.split('.')[0]}-auth-token`
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
  if (encoded.length <= 3180) return `${name}=${encoded}`
  const parts = []
  for (let i = 0, n = 0; i < encoded.length; i += 3180, n += 1) {
    parts.push(`${name}.${n}=${encoded.slice(i, i + 3180)}`)
  }
  return parts.join('; ')
}

export const SESSION_PRINCIPALS = ['viewer', 'agent', 'admin', 'owner', 'otherOwner']
export const KEY_PRINCIPALS = ['apiKey', 'apiKeyNoScope', 'otherApiKey']
export const RANK = { viewer: 1, agent: 2, admin: 3, owner: 4, otherOwner: 4 }

/** Headers that authenticate a principal. */
export function authHeaders(world, principal) {
  if (principal === 'anon') return {}
  if (SESSION_PRINCIPALS.includes(principal)) {
    return { cookie: sessionCookie(world.users[principal].session) }
  }
  if (KEY_PRINCIPALS.includes(principal)) {
    return { authorization: `Bearer ${world.keys[principal]}` }
  }
  throw new Error(`unknown principal ${principal}`)
}

/** One HTTP call to the app. Never follows redirects. */
export async function call({ world, principal = 'anon', method = 'GET', path, body, headers = {} }) {
  const h = { ...authHeaders(world, principal), ...headers }
  let payload
  if (body !== undefined && body !== null && method !== 'GET') {
    h['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(E.app + path, { method, headers: h, body: payload, redirect: 'manual' })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, text, json, location: res.headers.get('location') }
}

/** Denied = 401/403, or a redirect to the login page. */
export const isDenied = (r) =>
  r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400 && /\/login/.test(r.location || ''))

/** Replace {{A.x}} placeholders (strings, objects) from the world. */
export function fill(value, world) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\.(\w+)\}\}/g, (_, t, k) => {
      const v = world[t]?.[k]
      if (v === undefined) throw new Error(`unknown placeholder {{${t}.${k}}}`)
      return v
    })
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, world))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, world)]))
  }
  return value
}

/** Tables snapshotted to prove nothing in tenant A changed. */
const A_TABLES = [
  'contacts', 'tags', 'custom_fields', 'conversations', 'message_templates', 'pipelines', 'deals',
  'broadcasts', 'automations', 'flows', 'quick_replies', 'api_keys', 'account_invitations',
  'webhook_endpoints', 'ai_configs', 'ai_knowledge_documents', 'whatsapp_config', 'notifications',
]

/** Full rows of tenant A (ordered), so ANY change — including updated_at — shows. */
export async function snapshotA(admin, world) {
  const out = {}
  for (const t of A_TABLES) {
    const { data, error } = await admin.from(t).select('*').eq('account_id', world.accounts.a).order('id')
    if (error) throw new Error(`snapshot ${t}: ${error.message}`)
    out[t] = data
  }
  const { data: msgs } = await admin
    .from('messages').select('*').in('conversation_id', [world.A.conv]).order('id')
  out.messages = msgs
  const { data: profiles } = await admin
    .from('profiles').select('user_id, account_id, account_role').eq('account_id', world.accounts.a).order('user_id')
  out.profiles = profiles
  const { data: acct } = await admin.from('accounts').select('*').eq('id', world.accounts.a).single()
  out.account = acct
  return out
}

/** Names of the snapshot sections that differ (empty = identical), for readable failures. */
export function diffSnapshots(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Requests the app server tried to make to Meta (recorded by meta-stub.cjs, which also
 * blocks every other external host). `since` = number of lines already consumed.
 */
export function readMetaLog(since = 0) {
  const file = process.env.FS_META_LOG
  if (!file || !existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(since).map((l) => JSON.parse(l))
}
export const metaLogLength = () => readMetaLog().length

/** Marker string present in every tenant-A fixture; it must never appear in a foreign response. */
export const MARKER = 'ISOLATION-MARKER-A'
