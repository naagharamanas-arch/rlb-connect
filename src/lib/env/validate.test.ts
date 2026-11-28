import { describe, expect, it } from 'vitest'
import { assertEnv, validateEnv } from './validate'

const GOOD = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  ENCRYPTION_KEY: 'a'.repeat(64),
  META_APP_SECRET: 'meta',
}

describe('validateEnv', () => {
  it('accepts a complete configuration', () => {
    expect(validateEnv(GOOD)).toEqual([])
  })

  it('reports every missing required variable', () => {
    const names = validateEnv({}).map((p) => p.name)
    expect(names).toEqual([
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'ENCRYPTION_KEY',
      'META_APP_SECRET',
    ])
  })

  it('rejects a malformed ENCRYPTION_KEY without echoing it', () => {
    const secret = 'not-hex-secret-value'
    const problems = validateEnv({ ...GOOD, ENCRYPTION_KEY: secret })
    expect(problems).toEqual([{ name: 'ENCRYPTION_KEY', problem: 'must be 64 hex characters' }])
    expect(() => assertEnv({ ...GOOD, ENCRYPTION_KEY: secret })).toThrow(/ENCRYPTION_KEY/)
    try {
      assertEnv({ ...GOOD, ENCRYPTION_KEY: secret })
    } catch (e) {
      expect(String(e)).not.toContain(secret)
    }
  })

  it('validates optional values only when set', () => {
    expect(validateEnv({ ...GOOD, NEXT_PUBLIC_SITE_URL: '' })).toEqual([])
    expect(validateEnv({ ...GOOD, NEXT_PUBLIC_SITE_URL: 'https://a.b/' })).toHaveLength(1)
    expect(validateEnv({ ...GOOD, AUTOMATION_CRON_SECRET: 'short' })).toHaveLength(1)
    expect(validateEnv({ ...GOOD, AUTOMATION_CRON_SECRET: 'x'.repeat(32) })).toEqual([])
  })
})

describe('validateEnv — Embedded Signup (only when ES_CONNECT_ENABLED=1)', () => {
  const ES_ON = { ...GOOD, ES_CONNECT_ENABLED: '1' }
  const ES_GOOD = {
    ...ES_ON,
    META_APP_ID: '972901605572832',
    META_ES_APP_SECRET: 'es-secret-value',
    META_ES_CONFIG_ID: '123456789',
  }

  it('ignores ES variables entirely while the flag is off', () => {
    expect(validateEnv(GOOD)).toEqual([])
    expect(validateEnv({ ...GOOD, ES_CONNECT_ENABLED: '0', META_APP_ID: 'junk' })).toEqual([])
  })

  it('requires the three ES variables when the flag is on', () => {
    expect(validateEnv(ES_ON).map((p) => p.name)).toEqual([
      'META_APP_ID',
      'META_ES_APP_SECRET',
      'META_ES_CONFIG_ID',
    ])
    expect(validateEnv(ES_GOOD)).toEqual([])
  })

  it('rejects non-numeric ids without echoing any value', () => {
    const problems = validateEnv({ ...ES_GOOD, META_APP_ID: 'abc', META_ES_CONFIG_ID: 'x1' })
    expect(problems.map((p) => p.name)).toEqual(['META_APP_ID', 'META_ES_CONFIG_ID'])
    expect(JSON.stringify(problems)).not.toContain('es-secret-value')
  })
})
