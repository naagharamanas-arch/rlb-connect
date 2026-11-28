import { describe, expect, it } from 'vitest'
import { findPhoneClaimByOtherAccount } from './claim'

function fakeAdmin(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, ...unknown[]]> = []
  const chain = {
    select: (c: string) => (calls.push(['select', c]), chain),
    eq: (c: string, v: unknown) => (calls.push(['eq', c, v]), chain),
    neq: (c: string, v: unknown) => (calls.push(['neq', c, v]), chain),
    maybeSingle: async () => result,
  }
  return {
    admin: { from: (t: string) => (calls.push(['from', t]), chain) } as never,
    calls,
  }
}

describe('findPhoneClaimByOtherAccount', () => {
  it('queries whatsapp_config for the phone id excluding the caller account', async () => {
    const { admin, calls } = fakeAdmin({ data: null, error: null })
    const out = await findPhoneClaimByOtherAccount({ admin, phoneNumberId: 'P1', accountId: 'A1' })
    expect(out).toEqual({ claimed: false, error: null })
    expect(calls).toEqual([
      ['from', 'whatsapp_config'],
      ['select', 'account_id'],
      ['eq', 'phone_number_id', 'P1'],
      ['neq', 'account_id', 'A1'],
    ])
  })

  it('reports a claim by another account', async () => {
    const { admin } = fakeAdmin({ data: { account_id: 'A2' }, error: null })
    expect(
      await findPhoneClaimByOtherAccount({ admin, phoneNumberId: 'P1', accountId: 'A1' }),
    ).toEqual({ claimed: true, error: null })
  })

  it('surfaces a lookup error and never reports claimed on error', async () => {
    const err = { message: 'boom' }
    const { admin } = fakeAdmin({ data: { account_id: 'A2' }, error: err })
    expect(
      await findPhoneClaimByOtherAccount({ admin, phoneNumberId: 'P1', accountId: 'A1' }),
    ).toEqual({ claimed: false, error: err })
  })
})
