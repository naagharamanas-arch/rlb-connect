// HTTP authorization matrix against the real Next server + real Supabase stack.
//
// Principals: anon, viewer, agent, admin, owner (tenant A), otherOwner (tenant B's
// owner), apiKey (all scopes), apiKeyNoScope, otherApiKey (tenant B's key).
//
// For every route handler in matrix.json (generated from the source, and kept
// complete by src/lib/auth/fullstack-matrix-coverage.test.ts):
//   * principals that MUST be let through get anything except 401/403 (auth passed;
//     the request body is deliberately invalid or targets a non-existent id, so a
//     passing principal causes no side effect);
//   * every other principal MUST get 401/403 (or a redirect to /login);
//   * after all denied calls, tenant A's data must be byte-for-byte unchanged.
// Tenancy cases then aim tenant B's credentials at tenant A's REAL resources.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { before, describe, it } from 'node:test'

import {
  E, MARKER, NIL, RANK, adminClient, assertEphemeral, call, fill, isDenied, diffSnapshots, loadWorld, metaLogLength, readMetaLog, snapshotA,
} from './lib.mjs'

assertEphemeral()
const world = loadWorld()
const admin = adminClient()
const matrix = JSON.parse(readFileSync(new URL('./matrix.json', import.meta.url), 'utf8'))

/** Is `principal` supposed to be authorised for this case? */
function allowed(c, principal) {
  const rank = RANK[principal]
  switch (c.kind) {
    case 'role': return rank !== undefined && rank >= RANK[c.minRole]
    case 'member':
    case 'session': return rank !== undefined
    case 'apikey':
      return principal === 'apiKey' || principal === 'otherApiKey' || (principal === 'apiKeyNoScope' && c.unscoped === true)
    default: throw new Error(`unknown kind ${c.kind}`)
  }
}

let baseline

before(async () => {
  baseline = JSON.stringify(await snapshotA(admin, world))
})

describe('phase 1 — every principal that must be refused is refused', () => {
  for (const c of matrix.cases) {
    it(`${c.method} ${c.route.replace('/route.ts', '')}`, async () => {
      const failures = []
      for (const principal of matrix.principals) {
        if (allowed(c, principal)) continue
        const r = await call({ world, principal, method: c.method, path: c.path, body: c.body })
        if (!isDenied(r)) failures.push(`${principal} got ${r.status} (expected 401/403): ${r.text.slice(0, 160)}`)
      }
      assert.deepEqual(failures, [], `unauthorized access on ${c.method} ${c.path}`)
    })
  }

  it('the refused calls changed nothing in tenant A', async () => {
    assert.equal(JSON.stringify(await snapshotA(admin, world)), baseline)
  })
})

describe("tenancy — tenant B's credentials against tenant A's real resources", () => {
  for (const t of matrix.tenancy) {
    it(`${t.id}: ${t.foreign} cannot ${t.method} ${t.path.replace(/\{\{.*?\}\}/g, ':id')}`, async () => {
      const path = fill(t.path, world)
      const body = t.body === undefined ? undefined : fill(t.body, world)
      const r = await call({ world, principal: t.foreign, method: t.method, path, body })
      // Refused or rejected (4xx) — never a success, a redirect or a server error.
      assert.ok(r.status >= 400 && r.status < 500, `${t.foreign} got ${r.status}: ${r.text.slice(0, 200)}`)
      assert.ok(!r.text.includes(MARKER), `${t.foreign} received tenant A data: ${r.text.slice(0, 200)}`)
      assert.ok(!r.text.includes(world.accounts.a), `${t.foreign} response names tenant A's account id`)
    })
  }

  it("none of those calls changed tenant A's data", async () => {
    assert.equal(JSON.stringify(await snapshotA(admin, world)), baseline)
  })

  it("tenant B's request cannot create anything inside tenant A", async () => {
    const { count: msgs } = await admin.from('messages').select('id', { count: 'exact', head: true }).eq('conversation_id', world.A.conv)
    assert.equal(msgs, 1, 'a message was planted in tenant A conversation')
    const { data: hijacked } = await admin.from('messages').select('id').ilike('content_text', 'HIJACK%')
    assert.deepEqual(hijacked, [], 'a HIJACK message exists somewhere')
  })

  for (const t of matrix.tenancy.filter((x) => x.positive)) {
    it(`positive control for ${t.id}: ${t.positive.principal} CAN read it`, async () => {
      const r = await call({ world, principal: t.positive.principal, method: t.method, path: fill(t.path, world) })
      assert.ok(t.positive.status.includes(r.status), `${t.positive.principal} got ${r.status}: ${r.text.slice(0, 200)}`)
    })
  }
})

describe('API sends and deletes stay inside the caller account', () => {
  const digits = (s) => String(s).replace(/\D/g, '')

  it("tenant B's key sending to a number that is a tenant A contact is delivered through B only and touches nothing of A", async () => {
    // The v1 send takes a PHONE NUMBER (not a conversation id): B may message any number, and
    // that must resolve to B's OWN contact/conversation and B's own WhatsApp credentials.
    // Snapshot of tenant A taken right before THIS call, so only B's effect is measured (earlier
    // positive controls legitimately touch A, e.g. api_keys.last_used_at when A's own key is used).
    const aBefore = await snapshotA(admin, world)
    const before = metaLogLength()
    const text = `hello from tenant B ${Date.now()}`
    const r = await call({
      world, principal: 'otherApiKey', method: 'POST', path: '/api/v1/messages',
      body: { to: world.A.phone, type: 'text', text },
    })
    assert.ok(r.status >= 200 && r.status < 300, `B's send got ${r.status}: ${r.text.slice(0, 200)}`)

    // Meta (stubbed) saw exactly one send, with B's number id and a bearer token, to the number.
    const seen = readMetaLog(before)
    const sends = seen.filter((e) => e.kind === 'meta' && e.method === 'POST')
    assert.equal(sends.length, 1, `expected one Meta send, saw ${JSON.stringify(seen)}`)
    assert.match(sends[0].url, /\/phone-id-b\/messages/, "B's send must use B's phone number id")
    assert.ok(sends[0].hasBearer, 'B token was not decrypted and presented')
    assert.equal(digits(sends[0].body.to), digits(world.A.phone))
    assert.ok(!seen.some((e) => String(e.url).includes('phone-id-a')), "tenant A's WhatsApp number was used")
    assert.ok(!seen.some((e) => e.kind === 'blocked'), 'an external request was attempted and blocked')

    // Data: the number now has TWO contacts, one per account; A's is the original, untouched.
    // (compare on the normalised digits: the app stores a created contact's phone without the '+')
    const { data: contacts } = await admin.from('contacts').select('id, account_id, name').eq('phone_normalized', digits(world.A.phone))
    assert.equal(contacts.length, 2)
    assert.deepEqual(contacts.map((c) => c.account_id).sort(), [world.accounts.a, world.accounts.b].sort())
    assert.equal(contacts.find((c) => c.account_id === world.accounts.a).id, world.A.contact)
    const bContact = contacts.find((c) => c.account_id === world.accounts.b)
    const { data: bConv } = await admin.from('conversations').select('id, account_id').eq('contact_id', bContact.id)
    assert.equal(bConv.length, 1)
    assert.equal(bConv[0].account_id, world.accounts.b)
    const { data: bMsgs } = await admin.from('messages').select('id').eq('conversation_id', bConv[0].id).eq('content_text', text)
    assert.equal(bMsgs.length, 1, "the message is not in B's own conversation")

    // Nothing in tenant A changed: no message, no conversation, no contact edit.
    const aAfter = await snapshotA(admin, world)
    assert.deepEqual(diffSnapshots(aBefore, aAfter), [], "tenant B's send changed tenant A data")
    assert.equal(JSON.stringify(aAfter), JSON.stringify(aBefore))
    const { data: planted } = await admin.from('messages').select('id').eq('content_text', text).eq('conversation_id', world.A.conv)
    assert.deepEqual(planted, [])
  })

  it("positive control: tenant A's key sends through A's own number (so the stub and fixtures are not vacuous)", async () => {
    const before = metaLogLength()
    const r = await call({
      world, principal: 'apiKey', method: 'POST', path: '/api/v1/messages',
      body: { to: world.B.phone, type: 'text', text: 'hello from tenant A' },
    })
    assert.ok(r.status >= 200 && r.status < 300, `A's send got ${r.status}: ${r.text.slice(0, 200)}`)
    const sends = readMetaLog(before).filter((e) => e.kind === 'meta' && e.method === 'POST')
    assert.equal(sends.length, 1)
    assert.match(sends[0].url, /\/phone-id-a\/messages/)
  })

  it('DELETE of a knowledge document: 404 for another tenant (and the row survives); 200 then 404 for its own admin', async () => {
    const { data: doc, error } = await admin.from('ai_knowledge_documents')
      .insert({ account_id: world.accounts.a, title: `${MARKER} delete-me`, content: 'x' }).select('id').single()
    assert.equal(error, null)
    const foreign = await call({ world, principal: 'otherOwner', method: 'DELETE', path: `/api/ai/knowledge/${doc.id}` })
    assert.equal(foreign.status, 404, `tenant B got ${foreign.status}: ${foreign.text}`)
    assert.equal(foreign.json?.success, undefined, 'a 404 must not claim success')
    const { data: still } = await admin.from('ai_knowledge_documents').select('id').eq('id', doc.id)
    assert.equal(still.length, 1, "tenant B's delete removed tenant A's document")

    const own = await call({ world, principal: 'admin', method: 'DELETE', path: `/api/ai/knowledge/${doc.id}` })
    assert.equal(own.status, 200, `A admin got ${own.status}: ${own.text}`)
    const { data: gone } = await admin.from('ai_knowledge_documents').select('id').eq('id', doc.id)
    assert.equal(gone.length, 0)
    const again = await call({ world, principal: 'admin', method: 'DELETE', path: `/api/ai/knowledge/${doc.id}` })
    assert.equal(again.status, 404)
  })
})

describe('secrets never leave the server (checked while the seeded credentials still exist)', () => {
  it('no read endpoint returns a stored credential, in plaintext or as ciphertext', async () => {
    const s = world.A.secrets
    const secrets = [...Object.values(s.plain), ...Object.values(s.cipher), world.keys.apiKey]
    const reads = [
      ['owner', '/api/ai/config'], ['viewer', '/api/ai/config'], ['owner', '/api/whatsapp/config'], ['viewer', '/api/whatsapp/config'],
      ['admin', '/api/account/api-keys'], ['viewer', '/api/account/api-keys'], ['owner', '/api/whatsapp/config/verify-registration'],
      ['owner', '/api/whatsapp/health'],
    ]
    for (const [principal, path] of reads) {
      const r = await call({ world, principal, path })
      assert.ok(r.status < 500, `${principal} ${path} -> ${r.status}`)
      for (const secret of secrets) assert.ok(!r.text.includes(secret), `${principal} ${path} leaked a credential`)
    }
    const hooks = await call({ world, path: '/api/v1/webhooks', headers: { authorization: `Bearer ${world.keys.apiKey}` } })
    assert.equal(hooks.status, 200)
    assert.ok(!hooks.text.includes(s.plain.webhookSecret), '/api/v1/webhooks leaked a signing secret')
  })

  it('positive control: the same endpoints do return the NON-secret facts (the check above is not vacuous)', async () => {
    const ai = await call({ world, principal: 'owner', path: '/api/ai/config' })
    assert.equal(ai.status, 200)
    assert.equal(ai.json?.configured, true)
    assert.equal(ai.json?.has_key, true)
    assert.equal(ai.json?.api_key, undefined)
    const keys = await call({ world, principal: 'admin', path: '/api/account/api-keys' })
    assert.equal(keys.status, 200)
    assert.ok(keys.text.includes('fs-all'), 'the key list should name the key')
  })
})

describe('phase 2 — every principal that may pass authentication does', () => {
  for (const c of matrix.cases) {
    it(`${c.method} ${c.route.replace('/route.ts', '')}`, async () => {
      const failures = []
      for (const principal of matrix.principals) {
        if (!allowed(c, principal)) continue
        const r = await call({ world, principal, method: c.method, path: c.path, body: c.body })
        if (isDenied(r)) failures.push(`${principal} was refused (${r.status}) on ${c.method} ${c.path}: ${r.text.slice(0, 160)}`)
        if (r.status >= 500) console.warn(`::warning::${principal} ${c.method} ${c.path} -> ${r.status}`)
      }
      assert.deepEqual(failures, [])
    })
  }
})

describe('credentials and identity edge cases', () => {
  it('a forged / garbage session is refused', async () => {
    const forged = { ...world.users.owner.session, access_token: 'not.a.jwt' }
    const r = await call({ world: { ...world, users: { ...world.users, owner: { ...world.users.owner, session: forged } } }, principal: 'owner', path: '/api/account/members' })
    assert.ok(isDenied(r), `status ${r.status}`)
  })

  it('the public anon key presented as a session is refused', async () => {
    const forged = { ...world.users.owner.session, access_token: E.anon }
    const r = await call({ world: { ...world, users: { ...world.users, owner: { ...world.users.owner, session: forged } } }, principal: 'owner', path: '/api/account/members' })
    assert.ok(isDenied(r), `status ${r.status}`)
  })

  it('an unknown API key is refused', async () => {
    const r = await call({ world, principal: 'anon', path: '/api/v1/me', headers: { authorization: 'Bearer wacrm_live_' + 'x'.repeat(40) } })
    assert.equal(r.status, 401)
  })

  it('a revoked API key stops working', async () => {
    const make = await call({ world, principal: 'owner', method: 'POST', path: '/api/account/api-keys', body: { name: 'fs-revoke', scopes: [] } })
    assert.equal(make.status, 201)
    const headers = { authorization: `Bearer ${make.json.plaintext}` }
    assert.equal((await call({ world, path: '/api/v1/me', headers })).status, 200)
    const del = await call({ world, principal: 'admin', method: 'DELETE', path: `/api/account/api-keys/${make.json.key.id}` })
    assert.ok(del.status < 300, `revoke -> ${del.status}`)
    assert.equal((await call({ world, path: '/api/v1/me', headers })).status, 401)
  })

  it('an expired API key stops working', async () => {
    const make = await call({ world, principal: 'owner', method: 'POST', path: '/api/account/api-keys', body: { name: 'fs-expire', scopes: [], expiresInDays: 1 } })
    assert.equal(make.status, 201)
    const headers = { authorization: `Bearer ${make.json.plaintext}` }
    assert.equal((await call({ world, path: '/api/v1/me', headers })).status, 200)
    const { error } = await admin.from('api_keys').update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', make.json.key.id)
    assert.equal(error, null)
    assert.equal((await call({ world, path: '/api/v1/me', headers })).status, 401)
  })

  it('a key without the scope is refused (403) on a scoped endpoint', async () => {
    const r = await call({ world, principal: 'apiKeyNoScope', path: '/api/v1/contacts' })
    assert.equal(r.status, 403)
  })

  it('a client-supplied account id / header cannot switch tenant', async () => {
    const r = await call({
      world, principal: 'otherOwner', path: `/api/account?account_id=${world.accounts.a}`,
      headers: { 'x-account-id': world.accounts.a },
    })
    assert.equal(r.status, 200)
    assert.ok(!r.text.includes(world.accounts.a), 'response names tenant A')
    assert.ok(!r.text.includes(MARKER))
  })

  it("the member list is scoped to the caller's own account", async () => {
    const r = await call({ world, principal: 'otherOwner', path: '/api/account/members' })
    assert.equal(r.status, 200)
    assert.ok(!r.text.includes('fs-a-'), "tenant A members are visible to tenant B")
    const a = await call({ world, principal: 'viewer', path: '/api/account/members' })
    assert.equal(a.status, 200)
    assert.ok(!a.text.includes('fs-b-owner'))
  })
})

describe('cron endpoints (shared secret)', () => {
  for (const path of ['/api/automations/cron', '/api/flows/cron']) {
    it(`${path}: refused without or with the wrong secret, accepted with the right one`, async () => {
      assert.equal((await call({ world, path })).status, 401)
      assert.equal((await call({ world, path, headers: { 'x-cron-secret': 'wrong-secret' } })).status, 401)
      const asUser = await call({ world, principal: 'owner', path })
      assert.equal(asUser.status, 401, 'a signed-in owner is not the scheduler')
      const ok = await call({ world, path, headers: { 'x-cron-secret': E.cron } })
      assert.ok(!isDenied(ok), `right secret got ${ok.status}`)
    })
  }
})

describe('Meta webhook', () => {
  it('GET handshake: no token / a wrong token never succeeds', async () => {
    const none = await call({ world, path: '/api/whatsapp/webhook' })
    assert.ok(none.status >= 400 && none.status < 500, `no params -> ${none.status}`)
    const wrong = await call({ world, path: '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc' })
    assert.equal(wrong.status, 403)
    assert.ok(!wrong.text.includes('abc'))
  })

  it('POST: unsigned and badly signed payloads are rejected and store nothing', async () => {
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] })
    for (const headers of [{}, { 'x-hub-signature-256': 'sha256=deadbeef' }, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }]) {
      const res = await fetch(E.app + '/api/whatsapp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload })
      assert.ok(res.status === 401 || res.status === 403, `got ${res.status} with ${JSON.stringify(headers)}`)
    }
  })

  it('POST: a correctly signed empty payload is accepted (positive control)', async () => {
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] })
    const sig = 'sha256=' + createHmac('sha256', E.metaSecret).update(payload).digest('hex')
    const res = await fetch(E.app + '/api/whatsapp/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: payload })
    assert.ok(res.status >= 200 && res.status < 300, `signed payload -> ${res.status}`)
  })
})

describe('public routes reveal nothing', () => {
  it('invitation peek with an unknown token returns no account data to anyone', async () => {
    for (const principal of ['anon', 'owner', 'otherOwner']) {
      const r = await call({ world, principal, path: `/api/invitations/${NIL}/peek` })
      assert.ok(r.status >= 200 && r.status < 500, `${principal} -> ${r.status}`)
      assert.ok(!r.text.includes(MARKER))
      assert.ok(!r.text.includes(world.accounts.a))
    }
  })

  it('auth callback without a code never errors the server', async () => {
    const r = await call({ world, path: '/auth/callback' })
    assert.ok(r.status < 500, `status ${r.status}`)
  })
})
