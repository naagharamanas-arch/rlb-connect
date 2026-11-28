import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  esConnectAllowlist,
  isAccountAllowlisted,
  isEsConnectAllowedFor,
  isEsConnectEnabled,
} from './flags'

afterEach(() => vi.unstubAllEnvs())

describe('ES flags', () => {
  it('default OFF and nobody allow-listed', () => {
    expect(isEsConnectEnabled()).toBe(false)
    expect(esConnectAllowlist()).toEqual([])
    expect(isAccountAllowlisted('a1')).toBe(false)
    expect(isEsConnectAllowedFor('a1')).toBe(false)
  })

  it('only the exact value "1" enables the flag', () => {
    for (const v of ['true', 'TRUE', '0', 'yes', ' 1', '']) {
      vi.stubEnv('ES_CONNECT_ENABLED', v)
      expect(isEsConnectEnabled()).toBe(false)
    }
    vi.stubEnv('ES_CONNECT_ENABLED', '1')
    expect(isEsConnectEnabled()).toBe(true)
  })

  it('parses the allowlist, trimming and dropping empties', () => {
    vi.stubEnv('ES_CONNECT_ACCOUNT_ALLOWLIST', ' a1 , ,a2,, ')
    expect(esConnectAllowlist()).toEqual(['a1', 'a2'])
    expect(isAccountAllowlisted('a1')).toBe(true)
    expect(isAccountAllowlisted('a3')).toBe(false)
    expect(isAccountAllowlisted('')).toBe(false)
  })

  it('requires BOTH flag and allowlist; read at call time', () => {
    vi.stubEnv('ES_CONNECT_ACCOUNT_ALLOWLIST', 'a1')
    expect(isEsConnectAllowedFor('a1')).toBe(false)
    vi.stubEnv('ES_CONNECT_ENABLED', '1')
    expect(isEsConnectAllowedFor('a1')).toBe(true)
    expect(isEsConnectAllowedFor('a2')).toBe(false)
    vi.stubEnv('ES_CONNECT_ENABLED', '0')
    expect(isEsConnectAllowedFor('a1')).toBe(false)
  })
})
