import { describe, expect, it } from 'vitest'
import { createWhatsAppConfigStore, type UpsertConnectionInput } from './connection-store'

type Op = { op: string; table: string; payload?: Record<string, unknown>; filters: Array<[string, unknown]> }

/** Fake supabase-js chain over one whatsapp_config row (or none). */
function fakeAdmin(opts: { existing?: Record<string, unknown> | null; error?: boolean } = {}) {
  const ops: Op[] = []
  const admin = {
    from(table: string) {
      const cur: Op = { op: 'select', table, filters: [] }
      const b = {
        select(cols?: string) {
          cur.payload = cols ? { cols } : undefined
          return b
        },
        eq(c: string, v: unknown) {
          cur.filters.push([c, v])
          return b
        },
        update(p: Record<string, unknown>) {
          cur.op = 'update'
          cur.payload = p
          return b
        },
        insert(p: Record<string, unknown>) {
          cur.op = 'insert'
          cur.payload = p
          return b
        },
        async maybeSingle() {
          ops.push({ ...cur })
          return { data: opts.existing ?? null, error: opts.error ? { message: 'db' } : null }
        },
        then(res: (v: unknown) => unknown) {
          ops.push({ ...cur })
          return Promise.resolve({ error: opts.error ? { message: 'db' } : null }).then(res)
        },
      }
      return b
    },
  }
  return { admin: admin as never, ops }
}

const TOKEN = 'EAAB-secret-business-token'
const input: UpsertConnectionInput = {
  accountId: 'acct-A',
  connectedBy: 'user-1',
  phoneNumberId: '555',
  wabaId: '999',
  accessToken: TOKEN,
  status: 'connected',
  registeredAt: null,
  subscribedAppsAt: '2026-11-28T10:00:00Z',
}
const enc = (s: string) => `ENC(${s.length})`

describe('createWhatsAppConfigStore', () => {
  it('getByAccount selects ONLY non-secret columns and never returns a token', async () => {
    const { admin, ops } = fakeAdmin({
      existing: {
        account_id: 'acct-A', phone_number_id: '555', waba_id: '999',
        status: 'connected', registered_at: null, subscribed_apps_at: 'x',
        access_token: 'SHOULD-NOT-APPEAR',
      },
    })
    const out = await createWhatsAppConfigStore({ admin, encrypt: enc }).getByAccount('acct-A')
    const cols = String((ops[0].payload as { cols: string }).cols)
    expect(cols).not.toMatch(/access_token|verify_token/)
    expect(out).toEqual({
      accountId: 'acct-A', phoneNumberId: '555', wabaId: '999',
      status: 'connected', registeredAt: null, subscribedAppsAt: 'x',
    })
    expect(JSON.stringify(out)).not.toContain('SHOULD-NOT-APPEAR')
  })

  it('getByAccount returns null when absent; throws a generic error on DB failure', async () => {
    const s1 = createWhatsAppConfigStore({ admin: fakeAdmin().admin, encrypt: enc })
    expect(await s1.getByAccount('a')).toBeNull()
    const s2 = createWhatsAppConfigStore({ admin: fakeAdmin({ error: true }).admin, encrypt: enc })
    await expect(s2.getByAccount('a')).rejects.toThrow('connection store read failed')
  })

  it('inserts a new row with the token ENCRYPTED, keyed by the given account', async () => {
    const { admin, ops } = fakeAdmin({ existing: null })
    await createWhatsAppConfigStore({ admin, encrypt: enc }).upsertConnection(input)
    const ins = ops.find((o) => o.op === 'insert')!
    expect(ins.payload).toMatchObject({
      account_id: 'acct-A', user_id: 'user-1', phone_number_id: '555', waba_id: '999',
      status: 'connected', registered_at: null, subscribed_apps_at: '2026-11-28T10:00:00Z',
    })
    expect(ins.payload!.access_token).toBe(enc(TOKEN))
    expect(JSON.stringify(ins.payload)).not.toContain(TOKEN)
    expect(ins.payload).not.toHaveProperty('verify_token')
  })

  it('updates an existing row, scoped to the account, leaving verify_token alone', async () => {
    const { admin, ops } = fakeAdmin({ existing: { id: 'row1' } })
    await createWhatsAppConfigStore({ admin, encrypt: enc }).upsertConnection(input)
    const upd = ops.find((o) => o.op === 'update')!
    expect(upd.filters).toContainEqual(['account_id', 'acct-A'])
    expect(upd.payload).not.toHaveProperty('verify_token')
    expect(upd.payload).not.toHaveProperty('account_id')
    expect(ops.some((o) => o.op === 'insert')).toBe(false)
  })

  it('maps pending_setup to disconnected with no connected_at (071 not applied)', async () => {
    const { admin, ops } = fakeAdmin({ existing: null })
    await createWhatsAppConfigStore({ admin, encrypt: enc }).upsertConnection({
      ...input, status: 'pending_setup',
    })
    const p = ops.find((o) => o.op === 'insert')!.payload!
    expect(p.status).toBe('disconnected')
    expect(p.connected_at).toBeNull()
  })

  it('write failure throws a generic message without the token', async () => {
    const { admin } = fakeAdmin({ existing: { id: 'r' }, error: true })
    const e = await createWhatsAppConfigStore({ admin, encrypt: enc })
      .upsertConnection(input).catch((x) => x)
    expect(String(e.message)).not.toContain(TOKEN)
  })

  it('markStatus is interface-only in S1 and writes nothing', async () => {
    const { admin, ops } = fakeAdmin({ existing: { id: 'r' } })
    const out = await createWhatsAppConfigStore({ admin, encrypt: enc }).markStatus('acct-A', 'needs_attention')
    expect(out).toEqual({ ok: false, reason: 'not_supported_until_071' })
    expect(ops).toHaveLength(0)
  })
})
