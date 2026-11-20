// Realtime tenant isolation against the real Realtime server.
//
// Four live subscribers on postgres_changes: tenant A owner, tenant A viewer,
// tenant B owner and anon. A change in tenant A (made with the service role, as the
// webhook / engines do) must reach A's members and nobody else.
//
// INSERT and UPDATE are RLS-filtered per subscriber by Realtime: a foreign or anon
// subscriber receiving one is a hard failure. DELETE events carry only what the
// table's replica identity logs; the test asserts a foreign subscriber can learn
// AT MOST the primary key (never content, account or contact data) and reports
// whether even that arrived, so the exposure stays measured rather than assumed.
//
// DIAGNOSTICS: every subscriber logs its channel status transitions, server "system"
// messages and any event carrying an `errors` array. A positive control that fails
// therefore says WHY (e.g. the socket joined as anon: "Error 401: Unauthorized").
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'

import { MARKER, adminClient, anonClient, assertEphemeral, loadWorld, realtimeUserClient, sleep } from './lib.mjs'

assertEphemeral()
const world = loadWorld()
const admin = adminClient()

const SETTLE_MS = 6000
const WAIT_MS = 15000
const READY_MS = 20000

const all = []

function diag(label, ...args) {
  console.log(`[realtime:${label}]`, ...args)
}

function subscribe(client, table, label) {
  const events = []
  const sub = { label, table, client, events, statuses: [], systems: [], ready: null, channel: null }
  sub.channel = client
    .channel(`fs-${label}-${table}-${randomUUID()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
      events.push(payload)
      if (payload.errors) diag(label, `${payload.eventType} event carried errors:`, JSON.stringify(payload.errors))
    })
    .on('system', {}, (payload) => {
      sub.systems.push(payload)
      diag(label, 'system:', payload.status, payload.extension, payload.message)
    })
  sub.ready = new Promise((resolve) => {
    let subscribed = false
    let pgReady = false
    const finish = (outcome) => { clearTimeout(timer); resolve(outcome) }
    const timer = setTimeout(() => {
      diag(label, 'NOT READY after', READY_MS, 'ms; statuses=', sub.statuses.join('>'), 'systems=', JSON.stringify(sub.systems))
      resolve('timeout')
    }, READY_MS)
    sub.channel.on('system', {}, (p) => {
      if (p.extension === 'postgres_changes' && p.status === 'ok') pgReady = true
      if (p.status === 'error') finish(`refused:${p.message}`)
      if (subscribed && pgReady) finish('ready')
    })
    sub.channel.subscribe((status, err) => {
      sub.statuses.push(status)
      diag(label, 'status:', status, err ? `error=${err.message ?? JSON.stringify(err)}` : '')
      if (status === 'SUBSCRIBED') { subscribed = true; if (pgReady) finish('ready') }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') finish(`refused:${status}`)
    })
  })
  all.push(sub)
  return sub
}

async function waitFor(pred, ms = WAIT_MS) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(200)
  }
  return false
}

const clientFor = async (principal) =>
  principal === 'anon' ? anonClient() : realtimeUserClient(world.users[principal].session.access_token)

let subs
before(async () => {
  subs = {}
  for (const p of ['owner', 'viewer', 'otherOwner', 'anon']) subs[p] = subscribe(await clientFor(p), 'messages', p)
  const outcomes = await Promise.all(Object.values(subs).map((s) => s.ready))
  diag('setup', 'outcomes:', JSON.stringify(Object.fromEntries(Object.keys(subs).map((p, i) => [p, outcomes[i]]))))
  // The three signed-in subscribers MUST be fully subscribed: an authenticated client that
  // is refused or never becomes ready would make every positive control meaningless.
  for (const p of ['owner', 'viewer', 'otherOwner']) {
    assert.equal(outcomes[Object.keys(subs).indexOf(p)], 'ready', `${p} subscriber was not ready: ${subs[p].statuses.join('>')}`)
  }
})

after(async () => {
  for (const s of all) {
    try { await s.client.removeChannel(s.channel) } catch { /* ignore */ }
    try { s.client.realtime.disconnect() } catch { /* ignore */ }
  }
})

/** An event that carries DATA for `id` (events carrying only an `errors` array never match). */
const received = (p, type, id) =>
  subs[p].events.some((e) => e.eventType === type && !e.errors && (e.new?.id === id || e.old?.id === id))

describe('postgres_changes on messages', () => {
  let msgId
  const text = `${MARKER} realtime`

  it("INSERT in tenant A reaches A's members and no one else", async () => {
    const { data, error } = await admin.from('messages')
      .insert({ conversation_id: world.A.conv, sender_type: 'customer', content_text: text }).select('id').single()
    assert.equal(error, null)
    msgId = data.id
    assert.ok(await waitFor(() => received('owner', 'INSERT', msgId)), 'positive control: tenant A owner never received the INSERT')
    assert.ok(await waitFor(() => received('viewer', 'INSERT', msgId)), 'positive control: tenant A viewer never received the INSERT')
    await sleep(SETTLE_MS)
    assert.equal(received('otherOwner', 'INSERT', msgId), false, "tenant B received tenant A's INSERT")
    assert.equal(received('anon', 'INSERT', msgId), false, "anon received tenant A's INSERT")
    for (const p of ['otherOwner', 'anon']) {
      assert.ok(!JSON.stringify(subs[p].events).includes(MARKER), `${p} saw tenant A content`)
    }
  })

  it("UPDATE in tenant A reaches A's members and no one else", async () => {
    const { error } = await admin.from('messages').update({ content_text: `${text} edited` }).eq('id', msgId)
    assert.equal(error, null)
    assert.ok(await waitFor(() => received('owner', 'UPDATE', msgId)), 'positive control: tenant A owner never received the UPDATE')
    await sleep(SETTLE_MS)
    assert.equal(received('otherOwner', 'UPDATE', msgId), false, "tenant B received tenant A's UPDATE")
    assert.equal(received('anon', 'UPDATE', msgId), false, "anon received tenant A's UPDATE")
  })

  it("a tenant B change reaches B and not A (the reverse direction)", async () => {
    const { data, error } = await admin.from('messages')
      .insert({ conversation_id: world.B.conv, sender_type: 'customer', content_text: 'B-fixture realtime' }).select('id').single()
    assert.equal(error, null)
    assert.ok(await waitFor(() => received('otherOwner', 'INSERT', data.id)), 'positive control: tenant B owner never received its own INSERT')
    await sleep(SETTLE_MS)
    assert.equal(received('owner', 'INSERT', data.id), false, "tenant A received tenant B's INSERT")
    assert.equal(received('viewer', 'INSERT', data.id), false, "tenant A viewer received tenant B's INSERT")
  })

  it('DELETE: a foreign subscriber learns at most the primary key', async () => {
    const { error } = await admin.from('messages').delete().eq('id', msgId)
    assert.equal(error, null)
    assert.ok(await waitFor(() => received('owner', 'DELETE', msgId)), 'positive control: tenant A owner never received the DELETE')
    await sleep(SETTLE_MS)
    for (const p of ['otherOwner', 'anon']) {
      const deletes = subs[p].events.filter((e) => e.eventType === 'DELETE' && !e.errors)
      for (const e of deletes) {
        const keys = Object.keys(e.old ?? {})
        assert.deepEqual(keys.filter((k) => k !== 'id'), [], `${p} received more than the primary key in a DELETE: ${keys.join(',')}`)
        assert.ok(!JSON.stringify(e).includes(MARKER), `${p} saw tenant A content in a DELETE`)
      }
      // Reported, not assumed: whether the bare id of a foreign deleted row arrived at all.
      console.log(`[realtime] DELETE of a tenant A message delivered to ${p}: ${deletes.length > 0 ? 'YES (primary key only)' : 'no'}`)
      // Verified platform behaviour, surfaced (not hidden): Realtime does not RLS-filter DELETE
      // events, so the bare primary key of a deleted row reaches subscribers of any tenant.
      if (deletes.length > 0) {
        console.log(`::warning title=Realtime DELETE exposure::${p} received the primary key of another tenant's deleted row (no content, no account id). Known Realtime behaviour: DELETE events are not RLS-filtered.`)
      }
    }
  })
})

describe('postgres_changes on a user-scoped table', () => {
  it("a tenant A notification is not delivered to tenant B or anon", async () => {
    const mine = subscribe(await clientFor('owner'), 'notifications', 'owner-notif')
    const theirs = subscribe(await clientFor('otherOwner'), 'notifications', 'other-notif')
    const anon = subscribe(await clientFor('anon'), 'notifications', 'anon-notif')
    const outcomes = await Promise.all([mine.ready, theirs.ready, anon.ready])
    assert.equal(outcomes[0], 'ready', `owner notifications subscriber not ready: ${mine.statuses.join('>')}`)
    assert.equal(outcomes[1], 'ready', `tenant B notifications subscriber not ready: ${theirs.statuses.join('>')}`)
    const { data, error } = await admin.from('notifications')
      .insert({ account_id: world.accounts.a, user_id: world.users.owner.id, title: `${MARKER} realtime notice` }).select('id').single()
    assert.equal(error, null)
    assert.ok(await waitFor(() => mine.events.some((e) => !e.errors && e.new?.id === data.id)), 'positive control: the recipient never received it')
    await sleep(SETTLE_MS)
    assert.equal(theirs.events.some((e) => !e.errors && e.new?.id === data.id), false, 'tenant B received a tenant A notification')
    assert.equal(anon.events.some((e) => !e.errors && e.new?.id === data.id), false, 'anon received a tenant A notification')
  })
})
