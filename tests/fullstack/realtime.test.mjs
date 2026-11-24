// Realtime tenant isolation against the real Realtime server.
//
// Four live subscribers on postgres_changes: tenant A owner, tenant A viewer,
// tenant B owner and anon. A change in tenant A (made with the service role, as the
// webhook / engines do) must reach A's members and nobody else.
//
// INSERT and UPDATE are RLS-filtered per subscriber by Realtime: a foreign or anon
// subscriber receiving one is a hard failure.
//
// DELETE: Realtime never RLS-filters DELETE events, so migration 065 stops publishing
// them. NO subscriber of ANY kind (the tenant itself included) may ever receive a DELETE
// event. The app's legitimate "something was deleted" needs are served by deletion
// signals: INSERTs into public.realtime_deletions, which ARE RLS-filtered. The owning
// tenant receives them, a foreign tenant and anon never do, and a deleted notification
// reaches only the notified user.
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
let dels
before(async () => {
  subs = {}
  dels = {}
  for (const p of ['owner', 'viewer', 'otherOwner', 'anon']) subs[p] = subscribe(await clientFor(p), 'messages', p)
  // Deletion-signal subscribers (the replacement for DELETE events).
  for (const p of ['owner', 'viewer', 'otherOwner', 'anon']) dels[p] = subscribe(await clientFor(p), 'realtime_deletions', `del-${p}`)
  const outcomes = await Promise.all([...Object.values(subs), ...Object.values(dels)].map((s) => s.ready))
  for (const [i, p] of ['owner', 'viewer', 'otherOwner'].entries()) {
    assert.equal(outcomes[4 + i], 'ready', `${p} deletion-signal subscriber was not ready: ${dels[p].statuses.join('>')}`)
  }
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

  /** True when `p` received the deletion signal for (table, id). */
  const signalFor = (p, table, id) =>
    dels[p].events.some((e) => !e.errors && e.new?.table_name === table && e.new?.old_row?.id === id)
  const deleteEventsAnywhere = () =>
    all.flatMap((x) => x.events.map((e) => ({ who: x.label, e }))).filter(({ e }) => e.eventType === 'DELETE')

  it('DELETE: no subscriber of any kind receives a DELETE event; the owning tenant receives a deletion signal instead', async () => {
    const { error } = await admin.from('messages').delete().eq('id', msgId)
    assert.equal(error, null)
    // The replacement works: both members of tenant A are told which message went away.
    assert.ok(await waitFor(() => signalFor('owner', 'messages', msgId)), 'positive control: tenant A owner never received the deletion signal')
    assert.ok(await waitFor(() => signalFor('viewer', 'messages', msgId)), 'positive control: tenant A viewer never received the deletion signal')
    await sleep(SETTLE_MS)
    // ... and nobody else is: no cross-tenant signal, none for anon.
    assert.equal(signalFor('otherOwner', 'messages', msgId), false, 'tenant B received a tenant A deletion signal')
    assert.equal(signalFor('anon', 'messages', msgId), false, 'anon received a tenant A deletion signal')
    for (const p of ['otherOwner', 'anon']) {
      assert.ok(!JSON.stringify(dels[p].events).includes(MARKER), `${p} saw tenant A data in a deletion signal`)
    }
    // The leak itself: no DELETE event reaches ANYONE (not even the owner: they are not published).
    const deletes = deleteEventsAnywhere()
    assert.deepEqual(deletes.map(({ who }) => who), [], `DELETE events were delivered: ${JSON.stringify(deletes).slice(0, 300)}`)
    // The signal itself carries identifiers only.
    const sig = dels.owner.events.find((e) => e.new?.table_name === 'messages' && e.new?.old_row?.id === msgId)
    assert.deepEqual(Object.keys(sig.new.old_row).sort(), ['conversation_id', 'id'], 'the signal must hold identifiers only')
  })

  it('DELETE of a tenant B row: tenant A and anon receive neither a DELETE event nor a signal (reverse direction)', async () => {
    const { data, error } = await admin.from('messages')
      .insert({ conversation_id: world.B.conv, sender_type: 'customer', content_text: 'B-fixture delete me' }).select('id').single()
    assert.equal(error, null)
    assert.ok(await waitFor(() => received('otherOwner', 'INSERT', data.id)), 'positive control: B received its own INSERT')
    const { error: delErr } = await admin.from('messages').delete().eq('id', data.id)
    assert.equal(delErr, null)
    assert.ok(await waitFor(() => signalFor('otherOwner', 'messages', data.id)), 'positive control: tenant B owner never received its own deletion signal')
    await sleep(SETTLE_MS)
    for (const p of ['owner', 'viewer', 'anon']) {
      assert.equal(signalFor(p, 'messages', data.id), false, `${p} received a tenant B deletion signal`)
    }
    assert.deepEqual(deleteEventsAnywhere().map(({ who }) => who), [])
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

  it('a deleted notification is signalled to the notified user only (not a teammate, tenant B or anon) and never as a DELETE event', async () => {
    const { data, error } = await admin.from('notifications')
      .insert({ account_id: world.accounts.a, user_id: world.users.owner.id, title: `${MARKER} to delete` }).select('id').single()
    assert.equal(error, null)
    const { error: delErr } = await admin.from('notifications').delete().eq('id', data.id)
    assert.equal(delErr, null)
    const has = (p) => dels[p].events.some((e) => !e.errors && e.new?.table_name === 'notifications' && e.new?.old_row?.id === data.id)
    assert.ok(await waitFor(() => has('owner')), 'positive control: the notified user never received the deletion signal')
    await sleep(SETTLE_MS)
    assert.equal(has('viewer'), false, 'a teammate received someone elses notification-deletion signal')
    assert.equal(has('otherOwner'), false, 'tenant B received a tenant A notification-deletion signal')
    assert.equal(has('anon'), false, 'anon received a notification-deletion signal')
    assert.deepEqual(all.flatMap((x) => x.events).filter((e) => e.eventType === 'DELETE'), [], 'a DELETE event was delivered')
  })
})
