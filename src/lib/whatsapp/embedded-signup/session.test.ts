import { describe, expect, it } from 'vitest'
import {
  SESSION_TTL_MS,
  claimSession,
  createSession,
  generateState,
  hashState,
} from './session'
import { memoryStore } from './test-support'

const T0 = new Date('2026-11-28T10:00:00Z')
const admin = async () => true

async function start(store = memoryStore(), mode: 'new_number' | 'coexistence' = 'new_number') {
  const r = await createSession({
    store,
    accountId: 'acct-A',
    userId: 'user-1',
    mode,
    consent: true,
    now: T0,
  })
  if (!r.ok) throw new Error('setup')
  return { store, state: r.state, session: r.session }
}

describe('state generation', () => {
  it('is random, url-safe and only its SHA-256 is stored', async () => {
    const a = generateState()
    const b = generateState()
    expect(a.state).not.toBe(b.state)
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.stateHash).toBe(hashState(a.state))
    expect(a.stateHash).toMatch(/^[0-9a-f]{64}$/)
    const { store, state } = await start()
    expect(JSON.stringify(store.rows)).not.toContain(state)
  })
})

describe('createSession', () => {
  it('binds account + user, pending, 10 minute TTL', async () => {
    const { session } = await start()
    expect(session).toMatchObject({
      accountId: 'acct-A',
      userId: 'user-1',
      status: 'pending',
      mode: 'new_number',
      completedSteps: [],
      usedAt: null,
    })
    expect(session.expiresAt.getTime()).toBe(T0.getTime() + SESSION_TTL_MS)
  })

  it('refuses coexistence without consent and records consent when given', async () => {
    const store = memoryStore()
    expect(
      await createSession({ store, accountId: 'a', userId: 'u', mode: 'coexistence', consent: false }),
    ).toEqual({ ok: false, reason: 'consent_required' })
    expect(store.rows).toHaveLength(0)
    const { session } = await start(store, 'coexistence')
    expect(session.consentAt).toEqual(T0)
  })
})

describe('claimSession', () => {
  const at = (ms: number) => new Date(T0.getTime() + ms)

  it('claims a valid session once and moves it to exchanging', async () => {
    const { store, state } = await start()
    const r = await claimSession({
      store, state, callerUserId: 'user-1', isStillAdmin: admin, now: at(1000),
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.session.status).toBe('exchanging')
      expect(r.session.accountId).toBe('acct-A')
    }
  })

  it('rejects an unknown or empty state', async () => {
    const { store } = await start()
    for (const state of ['', 'nope']) {
      expect(
        await claimSession({ store, state, callerUserId: 'user-1', isStillAdmin: admin, now: at(1) }),
      ).toEqual({ ok: false, reason: 'not_found' })
    }
  })

  it('rejects an expired session', async () => {
    const { store, state } = await start()
    expect(
      await claimSession({
        store, state, callerUserId: 'user-1', isStillAdmin: admin, now: at(SESSION_TTL_MS),
      }),
    ).toEqual({ ok: false, reason: 'expired' })
  })

  it('rejects a replay and a double click (second claim loses)', async () => {
    const { store, state } = await start()
    const args = { store, state, callerUserId: 'user-1', isStillAdmin: admin, now: at(1) }
    expect((await claimSession(args)).ok).toBe(true)
    expect(await claimSession(args)).toEqual({ ok: false, reason: 'replayed' })
  })

  it('exactly one of two concurrent finishes wins', async () => {
    const { store, state } = await start()
    const args = { store, state, callerUserId: 'user-1', isStillAdmin: admin, now: at(1) }
    const results = await Promise.all([claimSession(args), claimSession(args)])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })

  it('rejects a foreign user and does NOT burn the owner’s session', async () => {
    const { store, state } = await start()
    expect(
      await claimSession({
        store, state, callerUserId: 'user-2', isStillAdmin: admin, now: at(1),
      }),
    ).toEqual({ ok: false, reason: 'foreign_user' })
    // legitimate user can still finish
    expect(
      (await claimSession({
        store, state, callerUserId: 'user-1', isStillAdmin: admin, now: at(2),
      })).ok,
    ).toBe(true)
  })

  it('rejects when the role was downgraded between start and finish, without burning it', async () => {
    const { store, state } = await start()
    let allowed = false
    const isStillAdmin = async () => allowed
    expect(
      await claimSession({ store, state, callerUserId: 'user-1', isStillAdmin, now: at(1) }),
    ).toEqual({ ok: false, reason: 'role_revoked' })
    allowed = true
    expect((await claimSession({ store, state, callerUserId: 'user-1', isStillAdmin, now: at(2) })).ok).toBe(true)
  })

  it('re-checks the role against the SESSION’S account, not any caller-supplied one', async () => {
    const { store, state } = await start()
    const seen: Array<[string, string]> = []
    await claimSession({
      store, state, callerUserId: 'user-1', now: at(1),
      isStillAdmin: async (a, u) => (seen.push([a, u]), true),
    })
    expect(seen).toEqual([['acct-A', 'user-1']])
  })

  it('never leaks the raw state in the stored row or the result', async () => {
    const { store, state } = await start()
    const r = await claimSession({
      store, state, callerUserId: 'user-1', isStillAdmin: admin, now: at(1),
    })
    expect(JSON.stringify(r)).not.toContain(state)
    expect(JSON.stringify(store.rows)).not.toContain(state)
  })
})
