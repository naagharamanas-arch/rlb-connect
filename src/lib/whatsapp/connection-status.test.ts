import { describe, expect, it } from 'vitest'
import {
  classifyPhoneKind,
  deriveConnectionStatus,
  isConnectionKind,
  requiresLocalRegistration,
  type ConnectionKind,
} from './connection-status'

describe('classifyPhoneKind — positive identification only', () => {
  it('is coexistence only when is_on_biz_app is true', () => {
    expect(classifyPhoneKind({ isOnBizApp: true, platformType: 'CLOUD_API' })).toBe('coexistence')
    expect(classifyPhoneKind({ isOnBizApp: true })).toBe('coexistence')
  })

  it('is a test number for a SANDBOX account_mode (case-insensitive)', () => {
    expect(classifyPhoneKind({ accountMode: 'SANDBOX' })).toBe('test_number')
    expect(classifyPhoneKind({ accountMode: 'sandbox' })).toBe('test_number')
  })

  it('is cloud_api only when explicitly NOT on the business app and on CLOUD_API', () => {
    expect(classifyPhoneKind({ isOnBizApp: false, platformType: 'CLOUD_API' })).toBe('cloud_api')
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', {}],
    ['all null', { platformType: null, isOnBizApp: null, accountMode: null }],
    ['platform only', { platformType: 'CLOUD_API' }],
    ['not on biz app but other platform', { isOnBizApp: false, platformType: 'ON_PREMISE' }],
    ['LIVE mode only', { accountMode: 'LIVE' }],
  ])('anything else is unknown: %s', (_name, raw) => {
    expect(classifyPhoneKind(raw as never)).toBe('unknown')
  })

  it('coexistence wins over a sandbox hint (never ask a business-app number for a PIN)', () => {
    expect(classifyPhoneKind({ isOnBizApp: true, accountMode: 'SANDBOX' })).toBe('coexistence')
  })
})

describe('isConnectionKind / requiresLocalRegistration', () => {
  it('guards the wire value', () => {
    for (const k of ['coexistence', 'test_number', 'cloud_api', 'unknown']) {
      expect(isConnectionKind(k)).toBe(true)
    }
    expect(isConnectionKind('business_app')).toBe(false)
    expect(isConnectionKind(undefined)).toBe(false)
    expect(isConnectionKind(null)).toBe(false)
  })

  it('local registration is required for everything except coexistence and test numbers', () => {
    const table: Record<ConnectionKind, boolean> = {
      coexistence: false,
      test_number: false,
      cloud_api: true,
      unknown: true,
    }
    for (const [k, want] of Object.entries(table)) {
      expect(requiresLocalRegistration(k as ConnectionKind)).toBe(want)
    }
  })
})

const base = {
  hasConfig: true,
  registeredAt: null,
  lastRegistrationError: null,
  wabaSubscribed: true as boolean | null,
}

describe('deriveConnectionStatus', () => {
  it('first-time manual save (no config row): PIN always shown, no custom banner — whatever the kind', () => {
    for (const kind of ['coexistence', 'test_number', 'cloud_api', 'unknown'] as const) {
      const v = deriveConnectionStatus({ ...base, hasConfig: false, kind })
      expect(v).toEqual({
        state: 'no_config',
        customBanner: false,
        showPinField: true,
        neutralPinHint: false,
      })
    }
  })

  it('coexistence: hides the PIN and the "Not registered" banner, live when subscribed', () => {
    const v = deriveConnectionStatus({ ...base, kind: 'coexistence' })
    expect(v.state).toBe('coexistence_live')
    expect(v.customBanner).toBe(true)
    expect(v.showPinField).toBe(false)
  })

  it('coexistence with the WABA not subscribed needs attention, still no PIN', () => {
    const v = deriveConnectionStatus({ ...base, kind: 'coexistence', wabaSubscribed: false })
    expect(v.state).toBe('coexistence_attention')
    expect(v.showPinField).toBe(false)
  })

  it('coexistence with an unchecked subscription (null) is not flagged as a fault', () => {
    expect(deriveConnectionStatus({ ...base, kind: 'coexistence', wabaSubscribed: null }).state).toBe(
      'coexistence_live',
    )
  })

  it('coexistence is unaffected by a stale registration error', () => {
    const v = deriveConnectionStatus({
      ...base,
      kind: 'coexistence',
      lastRegistrationError: 'not available for SMB businesses',
    })
    expect(v.state).toBe('coexistence_live')
    expect(v.showPinField).toBe(false)
  })

  it('Meta test number: hides the PIN, custom banner', () => {
    const v = deriveConnectionStatus({ ...base, kind: 'test_number' })
    expect(v).toEqual({
      state: 'test_number',
      customBanner: true,
      showPinField: false,
      neutralPinHint: false,
    })
  })

  it('unknown kind: neutral banner, PIN stays available (optional, neutral wording)', () => {
    const v = deriveConnectionStatus({ ...base, kind: 'unknown' })
    expect(v).toEqual({
      state: 'unknown',
      customBanner: true,
      showPinField: true,
      neutralPinHint: true,
    })
  })

  it('known cloud_api keeps today’s legacy behaviour in all three states', () => {
    const registered = deriveConnectionStatus({ ...base, kind: 'cloud_api', registeredAt: '2026-01-01' })
    const failed = deriveConnectionStatus({ ...base, kind: 'cloud_api', lastRegistrationError: 'x' })
    const awaiting = deriveConnectionStatus({ ...base, kind: 'cloud_api' })
    expect(registered.state).toBe('registered')
    expect(failed.state).toBe('registration_failed')
    expect(awaiting.state).toBe('awaiting_registration')
    for (const v of [registered, failed, awaiting]) {
      expect(v.customBanner).toBe(false)
      expect(v.showPinField).toBe(true)
      expect(v.neutralPinHint).toBe(false)
    }
  })

  it('the PIN is hidden ONLY for coexistence and test numbers', () => {
    const hidden: string[] = []
    for (const kind of ['coexistence', 'test_number', 'cloud_api', 'unknown'] as const) {
      for (const wabaSubscribed of [true, false, null]) {
        if (!deriveConnectionStatus({ ...base, kind, wabaSubscribed }).showPinField) hidden.push(kind)
      }
    }
    expect(new Set(hidden)).toEqual(new Set(['coexistence', 'test_number']))
  })
})
