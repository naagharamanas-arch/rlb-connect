import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { deriveConnectionStatus, type ConnectionKind } from '@/lib/whatsapp/connection-status'
import {
  ConnectionStatusBanner,
  PinField,
  isCustomBannerState,
} from './whatsapp-status-parts'

// A plain translator: renders the key, so assertions can say which message was chosen.
const t = (key: string) => `[${key}]`

function pinFor(kind: ConnectionKind | null, hasConfig = true) {
  // kind === null models "WA_STATUS_V2 off": the API sent no connection_kind,
  // so the page has no status view and must behave exactly as it always did.
  const view = kind
    ? deriveConnectionStatus({
        hasConfig,
        kind,
        registeredAt: null,
        lastRegistrationError: null,
        wabaSubscribed: true,
      })
    : null
  return renderToStaticMarkup(
    <PinField
      show={view ? view.showPinField : true}
      neutralHint={view?.neutralPinHint ?? false}
      value=""
      onChange={() => {}}
      t={t}
      hintHtml="<b>legacy hint</b>"
    />,
  )
}

describe('PIN field in the Settings form', () => {
  it('no config row (first-time manual save): PIN shown with the legacy hint, for any kind', () => {
    for (const kind of ['coexistence', 'test_number', 'cloud_api', 'unknown'] as const) {
      const html = pinFor(kind, false)
      expect(html).toContain('[twoStepPin]')
      expect(html).toContain('<b>legacy hint</b>')
      expect(html).not.toContain('[pinHintNeutral]')
    }
  })

  it('unknown kind: PIN stays available (optional) with neutral wording', () => {
    const html = pinFor('unknown')
    expect(html).toContain('[twoStepPin]')
    expect(html).toContain('[optional]')
    expect(html).toContain('[pinHintNeutral]')
    expect(html).not.toContain('legacy hint')
  })

  it('positively identified coexistence: PIN field is not rendered', () => {
    expect(pinFor('coexistence')).toBe('')
  })

  it('Meta test number: PIN field is not rendered', () => {
    expect(pinFor('test_number')).toBe('')
  })

  it('known Cloud API number: PIN shown with the legacy hint', () => {
    const html = pinFor('cloud_api')
    expect(html).toContain('[twoStepPin]')
    expect(html).toContain('<b>legacy hint</b>')
  })

  it('flag off (no connection_kind from the API): identical to the legacy markup, PIN shown', () => {
    const html = pinFor(null)
    expect(html).toContain('[twoStepPin]')
    expect(html).toContain('[optional]')
    expect(html).toContain('[pinPlaceholder]')
    expect(html).toContain('maxLength="6"')
    expect(html).toContain('<span><b>legacy hint</b></span>')
    expect(html).not.toContain('[pinHintNeutral]')
  })
})

describe('registration banner', () => {
  function banner(kind: ConnectionKind, wabaSubscribed: boolean | null = true) {
    const view = deriveConnectionStatus({
      hasConfig: true,
      kind,
      registeredAt: null,
      lastRegistrationError: 'stale error',
      wabaSubscribed,
    })
    if (!view.customBanner || !isCustomBannerState(view.state)) return null
    return renderToStaticMarkup(
      <ConnectionStatusBanner state={view.state} t={t} onVerify={() => {}} verifying={false} />,
    )
  }

  it('coexistence: clear status, never "Not registered" or a PIN instruction', () => {
    const html = banner('coexistence')!
    expect(html).toContain('[coexistenceLive]')
    expect(html).toContain('[coexistenceLiveDesc]')
    expect(html).not.toContain('notRegistered')
    expect(html).not.toContain('noRegistrationHint')
    expect(html).not.toContain('Pin')
  })

  it('coexistence with an unsubscribed WABA: attention message, still no PIN instruction', () => {
    const html = banner('coexistence', false)!
    expect(html).toContain('[coexistenceAttention]')
    expect(html).not.toContain('notRegistered')
  })

  it('Meta test number: explains it is pre-registered', () => {
    const html = banner('test_number')!
    expect(html).toContain('[testNumber]')
    expect(html).toContain('[testNumberDesc]')
    expect(html).not.toContain('notRegistered')
  })

  it('unknown: neutral wording, not the "Meta will not deliver events" warning', () => {
    const html = banner('unknown')!
    expect(html).toContain('[statusUnknown]')
    expect(html).not.toContain('notRegistered')
  })

  it('known Cloud API numbers keep the legacy banner (no custom banner)', () => {
    expect(banner('cloud_api')).toBeNull()
  })

  it('offers Verify with Meta in every custom state', () => {
    for (const kind of ['coexistence', 'test_number', 'unknown'] as const) {
      expect(banner(kind)).toContain('[verifyWithMeta]')
    }
  })
})
