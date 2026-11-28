import { describe, expect, it } from 'vitest';
import {
  groupTemplateOwners,
  normalizeMetaId,
  resolveTenantForPhoneNumber,
} from './webhook-routing';

describe('normalizeMetaId', () => {
  it('trims strings, stringifies numbers, and maps empty/absent to null', () => {
    expect(normalizeMetaId(' 123 ')).toBe('123');
    expect(normalizeMetaId(456)).toBe('456');
    expect(normalizeMetaId('')).toBeNull();
    expect(normalizeMetaId('   ')).toBeNull();
    expect(normalizeMetaId(null)).toBeNull();
    expect(normalizeMetaId(undefined)).toBeNull();
  });
});

describe('resolveTenantForPhoneNumber', () => {
  const rowA = { account_id: 'acc-A', waba_id: 'WABA-A' };

  it('routes a phone number whose WABA matches the stored WABA', () => {
    const r = resolveTenantForPhoneNumber([rowA], 'WABA-A');
    expect(r).toEqual({ ok: true, config: rowA, wabaVerified: true });
  });

  it('treats numeric and string WABA ids as equal', () => {
    const r = resolveTenantForPhoneNumber(
      [{ account_id: 'acc-A', waba_id: 12345 }],
      '12345',
    );
    expect(r.ok && r.wabaVerified).toBe(true);
  });

  it('REJECTS a phone number delivered under a different WABA (mismatch)', () => {
    const r = resolveTenantForPhoneNumber([rowA], 'WABA-OTHER');
    expect(r).toEqual({
      ok: false,
      reason: 'waba_mismatch',
      entryWabaId: 'WABA-OTHER',
      configWabaId: 'WABA-A',
    });
  });

  it('FAILS CLOSED on a legacy row with no stored WABA by default', () => {
    for (const waba_id of [null, undefined, '']) {
      const row = { account_id: 'acc-L', waba_id };
      expect(resolveTenantForPhoneNumber([row], 'WABA-X')).toEqual({
        ok: false,
        reason: 'config_missing_waba',
      });
    }
  });

  it('routes a legacy row with no stored WABA ONLY when allowLegacyNullWaba is set', () => {
    for (const waba_id of [null, undefined, '']) {
      const row = { account_id: 'acc-L', waba_id };
      const r = resolveTenantForPhoneNumber([row], 'WABA-X', { allowLegacyNullWaba: true });
      expect(r).toEqual({ ok: true, config: row, wabaVerified: false });
    }
  });

  it('FAILS CLOSED when the envelope carries no entry.id, even with legacy compatibility', () => {
    for (const entry of [undefined, null, '', '  ']) {
      expect(resolveTenantForPhoneNumber([rowA], entry)).toEqual({
        ok: false,
        reason: 'missing_entry_id',
      });
      expect(
        resolveTenantForPhoneNumber([{ account_id: 'acc-L', waba_id: null }], entry, {
          allowLegacyNullWaba: true,
        }),
      ).toEqual({ ok: false, reason: 'missing_entry_id' });
    }
  });

  it('a mismatch fails closed even with legacy compatibility enabled', () => {
    expect(
      resolveTenantForPhoneNumber([rowA], 'WABA-OTHER', { allowLegacyNullWaba: true }),
    ).toMatchObject({ ok: false, reason: 'waba_mismatch' });
  });

  it('reports no_config for zero rows and for a null result', () => {
    expect(resolveTenantForPhoneNumber([], 'W')).toEqual({
      ok: false,
      reason: 'no_config',
    });
    expect(resolveTenantForPhoneNumber(null, 'W')).toEqual({
      ok: false,
      reason: 'no_config',
    });
  });

  it('refuses to pick between several rows for one phone number', () => {
    const r = resolveTenantForPhoneNumber(
      [rowA, { account_id: 'acc-B', waba_id: 'WABA-A' }],
      'WABA-A',
    );
    expect(r).toEqual({ ok: false, reason: 'ambiguous_number', matches: 2 });
  });

  it('keeps extra columns on the returned config untouched', () => {
    const row = { account_id: 'acc-A', waba_id: 'W', user_id: 'u', access_token: 'enc' };
    const r = resolveTenantForPhoneNumber([row], 'W');
    expect(r.ok && r.config).toBe(row);
  });
});

describe('groupTemplateOwners', () => {
  it('returns nothing for zero rows', () => {
    expect(groupTemplateOwners([])).toEqual([]);
    expect(groupTemplateOwners(null)).toEqual([]);
    expect(groupTemplateOwners(undefined)).toEqual([]);
  });

  it('returns one owner for one row', () => {
    expect(
      groupTemplateOwners([{ account_id: 'acc-1', user_id: 'u1' }]),
    ).toEqual([{ account_id: 'acc-1', user_id: 'u1' }]);
  });

  it('collapses several rows of ONE workspace into one owner (multi-number, same WABA)', () => {
    const owners = groupTemplateOwners([
      { account_id: 'acc-1', user_id: 'u-late', created_at: '2026-03-01T00:00:00Z' },
      { account_id: 'acc-1', user_id: 'u-early', created_at: '2026-01-01T00:00:00Z' },
      { account_id: 'acc-1', user_id: 'u-mid', created_at: '2026-02-01T00:00:00Z' },
    ]);
    expect(owners).toEqual([{ account_id: 'acc-1', user_id: 'u-early' }]);
  });

  it('breaks created_at ties by lowest user_id, and ranks missing created_at last', () => {
    expect(
      groupTemplateOwners([
        { account_id: 'a', user_id: 'u-b', created_at: '2026-01-01T00:00:00Z' },
        { account_id: 'a', user_id: 'u-a', created_at: '2026-01-01T00:00:00Z' },
      ]),
    ).toEqual([{ account_id: 'a', user_id: 'u-a' }]);
    expect(
      groupTemplateOwners([
        { account_id: 'a', user_id: 'u-none' },
        { account_id: 'a', user_id: 'u-dated', created_at: '2026-01-01T00:00:00Z' },
      ]),
    ).toEqual([{ account_id: 'a', user_id: 'u-dated' }]);
  });

  it('returns several owners, sorted by account_id, when different workspaces claim the WABA', () => {
    const owners = groupTemplateOwners([
      { account_id: 'acc-2', user_id: 'u2' },
      { account_id: 'acc-1', user_id: 'u1' },
    ]);
    expect(owners.map((o) => o.account_id)).toEqual(['acc-1', 'acc-2']);
  });

  it('is order-independent (deterministic for any input ordering)', () => {
    const rows = [
      { account_id: 'acc-2', user_id: 'u2', created_at: '2026-02-01T00:00:00Z' },
      { account_id: 'acc-1', user_id: 'u1b', created_at: '2026-03-01T00:00:00Z' },
      { account_id: 'acc-1', user_id: 'u1a', created_at: '2026-01-01T00:00:00Z' },
    ];
    expect(groupTemplateOwners(rows)).toEqual(groupTemplateOwners([...rows].reverse()));
  });

  it('ignores rows without an account_id', () => {
    expect(
      groupTemplateOwners([{ account_id: '', user_id: 'u' }]),
    ).toEqual([]);
  });
});
