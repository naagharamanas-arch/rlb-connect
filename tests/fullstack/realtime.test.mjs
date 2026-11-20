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
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'

import { MARKER, adminClient, anonClient, assertEphemeral, loadWorld, sleep, userClient } from './lib.mjs'

assertEphemeral()
const world = loadWorld()
const admin = adminClient()

const SETTLE_MS = 6000
const WAIT_MS = 15000

function subscribe(client, token, table, label) {
  const events = []
  if (token) client.realtime.setAuth(token)
  const channel = client
    .channel(`fs-${label}-${table}-${randomUUID()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => events.push(payload))
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: subscribe timed out`)), WAIT_MS)
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve() }
      // An anon / unauthorised subscription may be refused outright: that is also "no data".
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        clearTimeout(timer)
        resolve(`refused:${status}:${err?.message ?? ''}`)
      }
    })
  })
  return { label, client, channel, events, ready }
}

async function waitFor(pred, ms = WAIT_MS) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(200)
  }
  return false
}

let subs
before(async () => {
  const mk = (principal) => {
    if (principal === 'anon') return { client: anonClient(), token: null }
    const t = world.users[principal].session.access_token
    return { client: userClient(t), token: t }
  }
  subs = {}
  for (const p of ['owner', 'viewer', 'otherOwner', 'anon']) {
    const { client, token } = mk(p)
    subs[p] = subscribe(client, token, 'messages', p)
  }
  await Promise.all(Object.values(subs).map((s) => s.ready))
  await sleep(1500)
})

after(async () => {
  for (const s of Object.values(subs ?? {})) {
    try { await s.client.removeChannel(s.channel) } catch { /* ignore */ }
    try { s.client.realtime.disconnect() } catch { /* ignore */ }
  }
})

const received = (p, type, id) => subs[p].events.some((e) => e.eventType === type && (e.new?.id === id || e.old?.id === id))

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
      const deletes = subs[p].events.filter((e) => e.eventType === 'DELETE')
      for (const e of deletes) {
        const keys = Object.keys(e.old ?? {})
        assert.deepEqual(keys.filter((k) => k !== 'id'), [], `${p} received more than the primary key in a DELETE: ${keys.join(',')}`)
        assert.ok(!JSON.stringify(e).includes(MARKER), `${p} saw tenant A content in a DELETE`)
      }
      // Reported, not assumed: whether the bare id of a foreign deleted row arrived at all.
      console.log(`[realtime] DELETE of a tenant A message delivered to ${p}: ${deletes.length > 0 ? 'YES (primary key only)' : 'no'}`)
    }
  })
})

describe('postgres_changes on a user-scoped table', () => {
  it("a tenant A notification is not delivered to tenant B or anon", async () => {
    const mine = subscribe(userClient(world.users.owner.session.access_token), world.users.owner.session.access_token, 'notifications', 'owner-notif')
    const theirs = subscribe(userClient(world.users.otherOwner.session.access_token), world.users.otherOwner.session.access_token, 'notifications', 'other-notif')
    const anon = subscribe(anonClient(), null, 'notifications', 'anon-notif')
    await Promise.all([mine.ready, theirs.ready, anon.ready])
    await sleep(1500)
    const { data, error } = await admin.from('notifications')
      .insert({ account_id: world.accounts.a, user_id: world.users.owner.id, title: `${MARKER} realtime notice` }).select('id').single()
    assert.equal(error, null)
    assert.ok(await waitFor(() => mine.events.some((e) => e.new?.id === data.id)), 'positive control: the recipient never received it')
    await sleep(SETTLE_MS)
    assert.equal(theirs.events.some((e) => e.new?.id === data.id), false, 'tenant B received a tenant A notification')
    assert.equal(anon.events.some((e) => e.new?.id === data.id), false, 'anon received a tenant A notification')
    for (const s of [mine, theirs, anon]) {
      try { await s.client.removeChannel(s.channel); s.client.realtime.disconnect() } catch { /* ignore */ }
    }
  })
})
