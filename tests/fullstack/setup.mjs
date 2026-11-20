// Builds the test world on the ephemeral stack and writes it to FS_WORLD_FILE:
//   tenant A: owner, admin, agent, viewer   tenant B: owner
// + seeded rows in both tenants + API keys (created through the real endpoint).
import { writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

import { E, adminClient, anonClient, assertEphemeral, call, MARKER } from './lib.mjs'

assertEphemeral()
const admin = adminClient()
const password = 'Fs-' + randomBytes(12).toString('hex')

async function must(label, promise) {
  const { data, error } = await promise
  if (error) throw new Error(`${label}: ${error.message}`)
  return data
}

async function newUser(email) {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw new Error(`createUser ${email}: ${error.message}`)
  return data.user.id
}

async function profile(userId) {
  return must('profile', admin.from('profiles').select('account_id').eq('user_id', userId).single())
}

async function setMember(userId, accountId, role) {
  const { account_id: old } = await profile(userId)
  await must('set member', admin.from('profiles').update({ account_id: accountId, account_role: role }).eq('user_id', userId))
  if (old && old !== accountId) {
    await must('drop personal account', admin.from('accounts').delete().eq('id', old).eq('owner_user_id', userId))
  }
}

const ids = {
  a_owner: await newUser('fs-a-owner@test.invalid'),
  a_admin: await newUser('fs-a-admin@test.invalid'),
  a_agent: await newUser('fs-a-agent@test.invalid'),
  a_viewer: await newUser('fs-a-viewer@test.invalid'),
  b_owner: await newUser('fs-b-owner@test.invalid'),
}
const acctA = (await profile(ids.a_owner)).account_id
const acctB = (await profile(ids.b_owner)).account_id
await setMember(ids.a_admin, acctA, 'admin')
await setMember(ids.a_agent, acctA, 'agent')
await setMember(ids.a_viewer, acctA, 'viewer')

/** Seed one tenant. Mirrors supabase/tests/database seed_tenant. */
async function seed(label, owner, acct) {
  const M = label === 'a' ? MARKER : 'B-fixture'
  const phone = label === 'a' ? '+15550101' : '+15550201'
  const one = (t, row) => must(`insert ${t}`, admin.from(t).insert(row).select().single())
  const out = {}
  out.inv = (await one('account_invitations', { account_id: acct, token_hash: `inv-hash-${label}-${Date.now()}`, role: 'agent', expires_at: new Date(Date.now() + 864e5).toISOString(), created_by_user_id: owner })).id
  const contact = await one('contacts', { user_id: owner, account_id: acct, phone, name: `${M} contact` })
  out.contact = contact.id
  out.phone = phone
  out.tag = (await one('tags', { user_id: owner, account_id: acct, name: `${M} tag` })).id
  await one('contact_tags', { contact_id: out.contact, tag_id: out.tag })
  out.conv = (await one('conversations', { user_id: owner, account_id: acct, contact_id: out.contact })).id
  out.msg = (await one('messages', { conversation_id: out.conv, sender_type: 'customer', content_text: `${M} message` })).id
  await one('whatsapp_config', { user_id: owner, account_id: acct, phone_number_id: `phone-id-${label}`, access_token: 'dummy-not-a-real-token', verify_token: 'dummy-verify' })
  out.template = (await one('message_templates', { user_id: owner, account_id: acct, name: `tpl_${label}`, body_text: `${M} hello` })).id
  out.bcast = (await one('broadcasts', { user_id: owner, account_id: acct, name: `${M} broadcast`, template_name: `tpl_${label}` })).id
  await one('broadcast_recipients', { broadcast_id: out.bcast, contact_id: out.contact })
  out.auto = (await one('automations', { user_id: owner, account_id: acct, name: `${M} automation`, trigger_type: 'inbound_message' })).id
  await one('automation_steps', { automation_id: out.auto, step_type: 'send_message', position: 0 })
  out.flow = (await one('flows', { user_id: owner, account_id: acct, name: `${M} flow`, trigger_type: 'manual' })).id
  await one('flow_nodes', { flow_id: out.flow, node_key: 'start', node_type: 'start' })
  out.qr = (await one('quick_replies', { account_id: acct, user_id: owner, title: `${M} quick reply`, content_text: 'hi' })).id
  out.webhook = (await one('webhook_endpoints', { account_id: acct, url: `https://example.invalid/${label}`, secret: `whsec-dummy-${label}` })).id
  await one('ai_configs', { account_id: acct, provider: 'openai', model: 'test-model', api_key: 'dummy-not-a-real-key' })
  out.doc = (await one('ai_knowledge_documents', { account_id: acct, title: `${M} doc`, content: `${M} zebra policy` })).id
  await one('notifications', { account_id: acct, user_id: owner, title: `${M} notice` })
  return out
}
const A = await seed('a', ids.a_owner, acctA)
const B = await seed('b', ids.b_owner, acctB)
A.agentUser = ids.a_agent
A.adminUser = ids.a_admin

// Sign everyone in through the real Auth API.
const users = {}
for (const [key, name] of [['viewer', 'a_viewer'], ['agent', 'a_agent'], ['admin', 'a_admin'], ['owner', 'a_owner'], ['otherOwner', 'b_owner']]) {
  const email = `fs-${name.replace('_', '-')}@test.invalid`
  const { data, error } = await anonClient().auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign in ${email}: ${error.message}`)
  users[key] = { id: ids[name], email, session: data.session }
}

// API keys through the real endpoint (also exercises the F1 column privileges:
// the insert RETURNs only non-secret columns).
const world = { users, accounts: { a: acctA, b: acctB }, A, B, keys: {}, password }
const ALL_SCOPES = ['messages:send', 'messages:read', 'contacts:read', 'contacts:write', 'conversations:read', 'broadcasts:send', 'webhooks:manage']
async function makeKey(principal, name, scopes) {
  const res = await call({ world, principal, method: 'POST', path: '/api/account/api-keys', body: { name, scopes } })
  if (res.status !== 201 || !res.json?.plaintext) throw new Error(`create API key ${name}: ${res.status} ${res.text}`)
  return { plaintext: res.json.plaintext, id: res.json.key.id }
}
const kA = await makeKey('owner', 'fs-all', ALL_SCOPES)
const kN = await makeKey('owner', 'fs-none', [])
const kB = await makeKey('otherOwner', 'fs-b-all', ALL_SCOPES)
world.keys = { apiKey: kA.plaintext, apiKeyNoScope: kN.plaintext, otherApiKey: kB.plaintext }
world.A.apiKeyRow = kA.id

writeFileSync(E.worldFile, JSON.stringify(world))
console.log('world ready: tenants A/B, 5 users, 3 API keys')
