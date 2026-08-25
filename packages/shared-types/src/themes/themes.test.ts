import { describe, it, expect } from 'vitest'
import { BrandTokensSchema, DEFAULT_BRAND } from '../brand'
import { THEME_IDS, themes, DEFAULT_THEME_ID, resolveTheme, themeToCssVars } from './index'

describe('theme registry', () => {
  it('registers every declared id', () => {
    expect(Object.keys(themes).sort()).toEqual([...THEME_IDS].sort())
  })

  it('keys each theme by its own id', () => {
    for (const [key, theme] of Object.entries(themes)) {
      expect(theme.id).toBe(key)
    }
  })

  it('gives every theme a full, valid palette', () => {
    for (const theme of Object.values(themes)) {
      expect(() => BrandTokensSchema.parse(theme.defaultTokens)).not.toThrow()
    }
  })

  it('keeps arada identical to the shipped brand defaults', () => {
    expect(themes.arada.defaultTokens).toEqual(DEFAULT_BRAND.tokens)
    expect(themes.arada.defaultTokens).toBe(DEFAULT_BRAND.tokens)
  })

  it('gives dash5 its own palette', () => {
    expect(themes.dash5.defaultTokens.brandPrimary).toBe('#00ff9d')
    expect(themes.dash5.defaultTokens.surfaceRaised).toBe('#06262d')
  })
})

describe('resolveTheme', () => {
  it('returns the named theme', () => {
    expect(resolveTheme('dash5').id).toBe('dash5')
  })

  it('falls back to the default for undefined', () => {
    expect(resolveTheme(undefined).id).toBe(DEFAULT_THEME_ID)
  })

  it('falls back to the default for an unknown id', () => {
    expect(resolveTheme('nope').id).toBe(DEFAULT_THEME_ID)
  })
})

describe('themeToCssVars', () => {
  it('emits typography', () => {
    const css = themeToCssVars(themes.dash5)
    expect(css).toContain("--font-ui: 'Roboto Condensed', sans-serif;")
    expect(css).toContain("--font-body: 'Roboto Condensed', sans-serif;")
    expect(css).toContain('--wb-font-size-base: 13px;')
  })

  it('aliases --font-game to the heading family', () => {
    const css = themeToCssVars(themes.arada)
    expect(css).toContain(`--font-game: ${themes.arada.typography.heading};`)
  })

  it('emits density', () => {
    const css = themeToCssVars(themes.dash5)
    expect(css).toContain('--row-h: 27px;')
    expect(css).toContain('--rail-w: 225px;')
    expect(css).toContain('--radius-sm: 2px;')
  })

  it('emits no colour tokens', () => {
    const css = themeToCssVars(themes.dash5)
    expect(css).not.toContain('--brand-primary')
    expect(css).not.toContain('--surface-base')
  })
})
