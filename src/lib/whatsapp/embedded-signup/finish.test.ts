import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MetaApiError } from '@/lib/whatsapp/meta-api'
import { finishEmbeddedSignup, type FinishDeps, type FinishInput, type FinishResult } from './finish'
import { createSession } from './session'
import { memoryConnectionStore, memoryStore } from './test-support'

const APP_ID = '972901605572832'
const TOKEN = 'EAAB-business-token-SECRET'
const CODE = 'single-use-code-SECRET'
const T0 = new Date('2026-11-28T10:00:00Z')

function metaErr(code = 100, message = 'bad') {
  return new MetaApiError(message, { code, subcode: 2, fbtraceId: 'tr1', httpStatus: 400 })
}

async function setup(opts: {
  mode?: 'new_number' | 'coexistence'
  overrides?: Partial<FinishDeps['meta']>
  admin?: boolean
  claimed?: boolean
  claimError?: boolean
  kindFacts?: { isOnBizApp: boolean | null; platformType: string | null; accountMode: string | null }
} = {}) {
  const sessions = memoryStore()
  const connections = memoryConnectionStore()
  const created = await createSession({
    store: sessions, accountId: 'acct-A', userId: 'user-1',
    mode: opts.mode ?? 'new_number', consent: true, now: T0,
  })
  if (!created.ok) throw new Error('setup')
  const meta = {
    exchangeCodeForToken: vi.fn(async () => ({ accessToken: TOKEN, tokenType: 'bearer', expiresInSeconds: null })),
    debugToken: vi.fn(async () => ({
      appId: APP_ID, isValid: true, type: 'USER', scopes: [], expiresAt: 0,
      granularScopes: [{ scope: 'whatsapp_business_management', targetIds: ['111'] }],
    })),
    getWabaPhoneNumberDetails: vi.fn(async () => [{ id: '555', platformType: null }]),
    getPhoneConnectionKind: vi.fn(async () =>
      opts.kindFacts ?? { isOnBizApp: false, platformType: 'CLOUD_API', accountMode: 'LIVE' }),
    subscribeWabaToApp: vi.fn(async () => undefined),
    registerPhoneNumber: vi.fn(async () => ({ success: true, alreadyRegistered: false })),
    ...opts.overrides,
  } as unknown as FinishDeps['meta']
  const deps: FinishDeps = {
    sessions, connections, meta,
    isStillAdmin: async () => opts.admin ?? true,
    isClaimedByOtherAccount: vi.fn(async () => ({
      claimed: opts.claimed ?? false,
      error: opts.claimError ? { message: 'x' } : null,
    })),
    generatePin: () => '123456',
    now: () => new Date(T0.getTime() + 1000),
  }
  const input: FinishInput = { state: created.state, code: CODE, callerUserId: 'user-1' }
  return { deps, input, sessions, connections, meta: meta as unknown as Record<string, ReturnType<typeof vi.fn>> }
}

function noSecrets(value: unknown) {
  const s = JSON.stringify(value)
  expect(s).not.toContain(TOKEN)
  expect(s).not.toContain(CODE)
  expect(s).not.toContain('123456')
}

beforeEach(() => vi.stubEnv('META_APP_ID', APP_ID))
afterEach(() => vi.unstubAllEnvs())

describe('path A (new / Cloud API number)', () => {
  it('connects: exchange, verify, persist token, subscribe, register with server PIN, final write', async () => {
    const t = await setup()
    const r = await finishEmbeddedSignup(t.deps, t.input)
    expect(r).toEqual({
      ok: true, status: 'connected', coexistence: false, alreadyConnected: false,
      steps: ['exchange_code', 'debug_token', 'verify_number', 'persist_token', 'subscribe_waba', 'register', 'persist'],
    })
    expect(t.meta.registerPhoneNumber).toHaveBeenCalledWith({ phoneNumberId: '555', accessToken: TOKEN, pin: '123456' })
    expect(t.connections.writes.map((w) => w.status)).toEqual(['pending_setup', 'connected'])
    expect(t.connections.writes[1]).toMatchObject({
      accountId: 'acct-A', connectedBy: 'user-1', phoneNumberId: '555', wabaId: '111',
    })
    expect(t.connections.writes[1].registeredAt).not.toBeNull()
    expect(t.sessions.rows[0].status).toBe('connected')
    noSecrets(r)
    noSecrets(t.sessions.rows)
  })

  it('exchanges the code before any other Meta call and only once', async () => {
    const t = await setup()
    await finishEmbeddedSignup(t.deps, t.input)
    expect(t.meta.exchangeCodeForToken).toHaveBeenCalledTimes(1)
    expect(t.meta.exchangeCodeForToken).toHaveBeenCalledWith({ code: CODE })
    expect(t.meta.exchangeCodeForToken.mock.invocationCallOrder[0]).toBeLessThan(
      t.meta.debugToken.mock.invocationCallOrder[0],
    )
  })
})

describe('coexistence invariant', () => {
  const biz = { isOnBizApp: true, platformType: null, accountMode: null }

  it('NEVER calls registerPhoneNumber for a coexistence number; registered_at stays null', async () => {
    const t = await setup({ mode: 'coexistence', kindFacts: biz })
    const r = await finishEmbeddedSignup(t.deps, t.input)
    expect(r.ok && r.coexistence).toBe(true)
    expect(t.meta.registerPhoneNumber).not.toHaveBeenCalled()
    expect(t.connections.writes[1].registeredAt).toBeNull()
    expect(t.connections.writes[1].status).toBe('connected')
    expect(r.ok && r.steps).not.toContain('register')
  })

  it('Meta overrides the browser: a new_number session on a Business-app number still never registers', async () => {
    const t = await setup({ mode: 'new_number', kindFacts: biz })
    const r = await finishEmbeddedSignup(t.deps, t.input)
    expect(r.ok && r.coexistence).toBe(true)
    expect(t.meta.registerPhoneNumber).not.toHaveBeenCalled()
  })

  it('a coexistence session Meta does not confirm fails closed, before persisting anything', async () => {
    const t = await setup({ mode: 'coexistence' })
    const r = await finishEmbeddedSignup(t.deps, t.input)
    expect(r).toMatchObject({ ok: false, reason: 'coexistence_not_confirmed', resumable: false })
    expect(t.connections.writes).toHaveLength(0)
    expect(t.meta.registerPhoneNumber).not.toHaveBeenCalled()
  })

  it('re-classifies to coexistence (no failure, no retry) when /register refuses an SMB number', async () => {
    const t = await setup({
      overrides: {
        registerPhoneNumber: vi.fn(async () => {
          throw metaErr(100, 'Registration is not available for SMB businesses')
        }) as never,
      },
    })
    const r = await finishEmbeddedSignup(t.deps, t.input)
    expect(r.ok && r.coexistence).toBe(true)
    expect(t.meta.registerPhoneNumber).toHaveBeenCalledTimes(1)
    expect(t.connections.writes[1].registeredAt).toBeNull()
  })
})

describe('session rules', () => {
  it.each([
    ['unknown state', { state: 'nope' }, 'not_found'],
    ['empty state', { state: '' }, 'not_found'],
    ['foreign user', { callerUserId: 'user-2' }, 'foreign_user'],
  ] as const)('%s is rejected before any Meta call', async (_n, patch, reason) => {
    const t = await setup()
    const r = await finishEmbeddedSignup(t.deps, { ...t.input, ...patch })
    expect(r).toMatchObject({ ok: false, reason, step: 'session' })
    expect(t.meta.exchangeCodeForToken).not.toHaveBeenCalled()
  })

  it('role downgraded between start and finish is rejected before any Meta call', async () => {
    const t = await setup({ admin: false })
    const r = await finishEmbeddedSignup(t.deps, t.input)
    expect(r).toMatchObject({ ok: false, reason: 'role_revoked' })
    expect(t.meta.exchangeCodeForToken).not.toHaveBeenCalled()
  })

  it('expired session is rejected', async () => {
    const t = await setup()
    t.deps.now = () => new Date(T0.getTime() + 11 * 60 * 1000)
    expect(await finishEmbeddedSignup(t.deps, t.input)).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('double finish: second call is a replay and never exchanges again', async () => {
    const t = await setup()
    await finishEmbeddedSignup(t.deps, t.input)
    const r = await finishEmbeddedSignup(t.deps, t.input)
    expect(r).toMatchObject({ ok: false, reason: 'replayed' })
    expect(t.meta.exchangeCodeForToken).toHaveBeenCalledTimes(1)
  })

  it('concurrent finishes: exactly one wins and Meta is exchanged once', async () => {
    const t = await setup()
    const rs = await Promise.all([finishEmbeddedSignup(t.deps, t.input), finishEmbeddedSignup(t.deps, t.input)])
    expect(rs.filter((r) => r.ok)).toHaveLength(1)
    expect(t.meta.exchangeCodeForToken).toHaveBeenCalledTimes(1)
  })

  it('writes use the SESSION account even if the input smuggles an account id', async () => {
    const t = await setup()
    const sneaky = { ...t.input, accountId: 'acct-EVIL', account_id: 'acct-EVIL' } as FinishInput
    await finishEmbeddedSignup(t.deps, sneaky)
    expect(new Set(t.connections.writes.map((w) => w.accountId))).toEqual(new Set(['acct-A']))
    expect(t.connections.rows.has('acct-EVIL')).toBe(false)
  })
})

describe('Meta verification', () => {
  it('exchange failure: failed, not resumable, Meta ids only, no secrets', async () => {
    const t = await setup({
      overrides: { exchangeCodeForToken: vi.fn(async () => { throw metaErr(100, `bad code ${CODE}`) }) as never },
    })
    const r = await finishEmbeddedSignup(t.deps, t.input)
    expect(r).toMatchObject({
      ok: false, reason: 'meta_error', step: 'exchange_code', resumable: false,
      meta: { code: 100, subcode: 2, fbtraceId: 'tr1', httpStatus: 400 },
    })
    noSecrets(r)
    expect(t.sessions.rows[0].status).toBe('failed')
    expect(t.connections.writes).toHaveLength(0)
  })

  it.each([
    ['invalid token', { isValid: false }, 'token_invalid'],
    ['token for a different app', { appId: '42' }, 'wrong_app'],
    ['no WABA granted', { granularScopes: [] }, 'waba_not_granted'],
    ['two WABAs and no hint', {
      granularScopes: [{ scope: 'whatsapp_business_management', targetIds: ['1', '2'] }],
    }, 'waba_ambiguous'],
    ['a scope on the wrong permission only', {
      granularScopes: [{ scope: 'whatsapp_business_messaging', targetIds: ['111'] }],
    }, 'waba_not_granted'],
  ] as const)('debug_token: %s fails closed, nothing stored', async (_n, patch, reason) => {
    const base = {
      appId: APP_ID, isValid: true, type: 'USER', scopes: [], expiresAt: 0,
      granularScopes: [{ scope: 'whatsapp_business_management', targetIds: ['111'] }],
    }
    const t = await setup({ overrides: { debugToken: vi.fn(async () => ({ ...base, ...patch })) as never } })
    const r = await finishEmbeddedSignup(t.deps, t.input)
    expect(r).toMatchObject({ ok: false, reason, step: 'debug_token' })
    expect(t.connections.writes).toHaveLength(0)
    noSecrets(r)
  })

  it('a browser WABA hint that Meta did not grant is rejected', async () => {
    const t = await setup()
    const r = await finishEmbeddedSignup(t.deps, { ...t.input, hints: { wabaId: '999' } })
    expect(r).toMatchObject({ ok: false, reason: 'waba_not_granted' })
  })

  it('a phone hint that is not under the WABA is rejected; a valid hint is accepted', async () => {
    const bad = await setup()
    expect(await finishEmbeddedSignup(bad.deps, { ...bad.input, hints: { phoneNumberId: '777' } }))
      .toMatchObject({ ok: false, reason: 'phone_not_under_waba' })
    expect(bad.connections.writes).toHaveLength(0)
    const good = await setup()
    expect((await finishEmbeddedSignup(good.deps, { ...good.input, hints: { wabaId: '111', phoneNumberId: '555' } })).ok).toBe(true)
  })

  it('several numbers and no hint is ambiguous, never a guess', async () => {
    const t = await setup({
      overrides: { getWabaPhoneNumberDetails: vi.fn(async () => [{ id: '1' }, { id: '2' }]) as never },
    })
    expect(await finishEmbeddedSignup(t.deps, t.input)).toMatchObject({ ok: false, reason: 'phone_ambiguous' })
  })

  it('number claimed by another account → refused before persisting', async () => {
    const t = await setup({ claimed: true })
    const r = await finishEmbeddedSignup(t.deps, t.input)
    expect(r).toMatchObject({ ok: false, reason: 'number_claimed_elsewhere', resumable: false })
    expect(t.connections.writes).toHaveLength(0)
  })

  it('claim-check lookup error fails closed', async () => {
    const t = await setup({ claimError: true })
    expect(await finishEmbeddedSignup(t.deps, t.input)).toMatchObject({ ok: false, reason: 'claim_check_failed' })
    expect(t.connections.writes).toHaveLength(0)
  })

  it('account already connected to a different number is refused', async () => {
    const t = await setup()
    t.connections.rows.set('acct-A', {
      accountId: 'acct-A', phoneNumberId: '888', wabaId: '1', status: 'connected',
      registeredAt: null, subscribedAppsAt: null,
    })
    expect(await finishEmbeddedSignup(t.deps, t.input)).toMatchObject({
      ok: false, reason: 'already_connected_other_number',
    })
    expect(t.connections.writes).toHaveLength(0)
  })

  it('finishing a number already connected to this account is a no-op success', async () => {
    const t = await setup()
    t.connections.rows.set('acct-A', {
      accountId: 'acct-A', phoneNumberId: '555', wabaId: '111', status: 'connected',
      registeredAt: null, subscribedAppsAt: null,
    })
    const r = await finishEmbeddedSignup(t.deps, t.input)
    expect(r).toMatchObject({ ok: true, alreadyConnected: true })
    expect(t.connections.writes).toHaveLength(0)
    expect(t.meta.subscribeWabaToApp).not.toHaveBeenCalled()
  })
})

describe('resumable failures (token already stored)', () => {
  it('subscribe failure after persist: needs_attention + resumable, token never in result', async () => {
    const t = await setup({
      overrides: { subscribeWabaToApp: vi.fn(async () => { throw metaErr(200) }) as never },
    })
    const r: FinishResult = await finishEmbeddedSignup(t.deps, t.input)
    expect(r).toMatchObject({ ok: false, reason: 'meta_error', step: 'subscribe_waba', resumable: true })
    expect(t.connections.writes.map((w) => w.status)).toEqual(['pending_setup'])
    expect(t.sessions.rows[0].status).toBe('needs_attention')
    noSecrets(r)
  })

  it('register failure after persist is resumable', async () => {
    const t = await setup({
      overrides: { registerPhoneNumber: vi.fn(async () => { throw metaErr(133005, 'pin mismatch') }) as never },
    })
    expect(await finishEmbeddedSignup(t.deps, t.input)).toMatchObject({
      ok: false, step: 'register', resumable: true,
    })
  })

  it('a store failure on the first write is not resumable (no token stored)', async () => {
    const t = await setup()
    t.deps.connections = { ...t.connections, upsertConnection: async () => { throw new Error('connection store write failed') } }
    expect(await finishEmbeddedSignup(t.deps, t.input)).toMatchObject({
      ok: false, reason: 'store_error', resumable: false,
    })
  })
})
