import { describe, it, expect } from 'vitest'
import {
  buildPersonProps,
  buildSuperProps,
  resolveReplayEnabled,
  isStandaloneDisplay,
  brandSlug,
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

describe('brandSlug', () => {
  it('prefers the configured brand', () => {
    expect(brandSlug({ brand: 'arada', shortName: 'Whatever' })).toBe('arada')
  })
  it('falls back to the slugged short name', () => {
    expect(brandSlug({ brand: '', shortName: 'Bet Bawa' })).toBe('bet-bawa')
    expect(brandSlug({ brand: null, shortName: 'Arada' })).toBe('arada')
  })
})
