import { describe, it, expect } from 'vitest'
import {
  buildPersonProps,
  buildSuperProps,
  resolveReplayEnabled,
  isStandaloneDisplay,
  brandSlug,
  maskReplayNetworkRequest,
} from './posthog'

describe('buildPersonProps', () => {
  it('maps a phone user and never leaks phone or name', () => {
    const props = buildPersonProps(
      { serial: 12, telegramId: undefined, createdAt: '2026-05-01T10:00:00.000Z' } as any,
      'arada',
    )
    expect(props).toEqual({
      serial: 12,
      brand: 'arada',
      signup_method: 'phone',
      created_at: '2026-05-01T10:00:00.000Z',
    })
    expect(Object.keys(props)).not.toContain('phone')
  })

  it('marks Telegram users', () => {
    const props = buildPersonProps({ serial: 1, telegramId: '55', createdAt: new Date(0) }, 'betbawa')
    expect(props.signup_method).toBe('telegram')
    expect(props.created_at).toBe('1970-01-01T00:00:00.000Z')
  })
})

describe('buildSuperProps', () => {
  it('returns brand, locale and is_pwa', () => {
    expect(buildSuperProps({ brand: 'arada', locale: 'am', standalone: true })).toEqual({
      brand: 'arada',
      locale: 'am',
      is_pwa: true,
    })
  })
})

describe('resolveReplayEnabled', () => {
  it('defaults on', () => {
    expect(resolveReplayEnabled(undefined)).toBe(true)
    expect(resolveReplayEnabled('')).toBe(true)
    expect(resolveReplayEnabled('true')).toBe(true)
  })
  it('turns off for false-ish strings and booleans', () => {
    for (const raw of ['false', 'FALSE', '0', 'off', 'no', false]) {
      expect(resolveReplayEnabled(raw)).toBe(false)
    }
  })
})

describe('isStandaloneDisplay', () => {
  it('reads display-mode standalone', () => {
    expect(isStandaloneDisplay({ matchMedia: () => ({ matches: true }) })).toBe(true)
  })
  it('falls back to navigator.standalone', () => {
    expect(isStandaloneDisplay({ matchMedia: () => ({ matches: false }), navigator: { standalone: true } })).toBe(true)
  })
  it('is false in a plain tab', () => {
    expect(isStandaloneDisplay({ matchMedia: () => ({ matches: false }), navigator: {} })).toBe(false)
  })
  it('survives a matchMedia that throws', () => {
    expect(
      isStandaloneDisplay({
        matchMedia: () => {
          throw new Error('jsdom')
        },
      }),
    ).toBe(false)
  })
})

describe('maskReplayNetworkRequest', () => {
  const entry = (over: Record<string, unknown>) =>
    ({
      name: 'https://sports.example.com/iframe?token=abc#frag',
      entryType: 'resource',
      startTime: 10,
      duration: 5,
      ...over,
    }) as any

  it.each(['iframe', 'frame'])('strips the query and hash from an %s load', (initiatorType) => {
    const masked = maskReplayNetworkRequest(entry({ initiatorType }))

    expect(masked).toEqual(entry({ initiatorType, name: 'https://sports.example.com/iframe' }))
  })

  it('strips a relative or opaque frame url at its query too', () => {
    expect(
      maskReplayNetworkRequest(entry({ initiatorType: 'iframe', name: '/play?launch=xyz' })).name,
    ).toBe('/play')
    expect(
      maskReplayNetworkRequest(entry({ initiatorType: 'iframe', name: 'about:blank' })).name,
    ).toBe('about:blank')
  })

  it('leaves a fetch entry as it is', () => {
    const fetch = entry({
      initiatorType: 'fetch',
      name: 'https://api.example.com/games?page=2',
      method: 'GET',
      requestBody: null,
      responseBody: '{"games":[1,2,3]}',
    })

    expect(maskReplayNetworkRequest({ ...fetch })).toEqual(fetch)
  })

  it('keeps PostHog scrubbing request bodies, which a custom mask function switches off', () => {
    const masked = maskReplayNetworkRequest(
      entry({
        initiatorType: 'fetch',
        name: 'https://api.example.com/auth/login',
        requestBody: '{"phone":"0911","password":"hunter2"}',
        responseBody: '{"phone":"+251911223344"}',
      }),
    )

    expect(masked?.name).toBe('https://api.example.com/auth/login')
    expect(masked?.requestBody).not.toContain('hunter2')
    expect(masked?.responseBody).not.toContain('911223344')
  })
})

describe('brandSlug', () => {
  it('prefers the configured brand', () => {
    expect(brandSlug({ brand: 'arada', shortName: 'Whatever' })).toBe('arada')
  })
  it('falls back to the slugged short name', () => {
    expect(brandSlug({ brand: '', shortName: 'Bet Bawa' })).toBe('bet-bawa')
    expect(brandSlug({ brand: null, shortName: 'Arada' })).toBe('arada')
  })
})
