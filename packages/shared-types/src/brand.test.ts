import { describe, it, expect } from 'vitest'
import {
  BrandConfigSchema,
  BrandConfigUpdateSchema,
  DEFAULT_BRAND,
  brandTokensToCss,
} from './brand'

describe('BrandConfigSchema', () => {
  it('accepts DEFAULT_BRAND', () => {
    expect(() => BrandConfigSchema.parse(DEFAULT_BRAND)).not.toThrow()
  })

  it('rejects an unknown token key', () => {
    const bad = { ...DEFAULT_BRAND, tokens: { ...DEFAULT_BRAND.tokens, notAToken: '#fff' } }
    expect(() => BrandConfigSchema.parse(bad)).toThrow()
  })

  it('rejects an invalid color value', () => {
    const bad = { ...DEFAULT_BRAND, tokens: { ...DEFAULT_BRAND.tokens, brandPrimary: 'teal' } }
    expect(() => BrandConfigSchema.parse(bad)).toThrow()
  })

  it('rejects an empty displayName', () => {
    expect(() => BrandConfigSchema.parse({ ...DEFAULT_BRAND, displayName: '' })).toThrow()
  })
})

describe('BrandConfigUpdateSchema', () => {
  it('accepts a partial tokens-only payload', () => {
    expect(() =>
      BrandConfigUpdateSchema.parse({ tokens: { brandPrimary: '#ffffff' } }),
    ).not.toThrow()
  })

  it('rejects an unknown top-level key', () => {
    expect(() =>
      BrandConfigUpdateSchema.parse({ unknownField: 'x' }),
    ).toThrow()
  })

  it('rejects a token-level unknown key', () => {
    expect(() =>
      BrandConfigUpdateSchema.parse({ tokens: { notAToken: '#fff' } }),
    ).toThrow()
  })

  it('accepts a root-relative upload path for logoUrl', () => {
    expect(() =>
      BrandConfigUpdateSchema.parse({ logoUrl: '/uploads/abc123.png' }),
    ).not.toThrow()
  })

  it('accepts an absolute URL for faviconUrl and rejects a bare word', () => {
    expect(() =>
      BrandConfigUpdateSchema.parse({ faviconUrl: 'https://cdn.example.com/f.ico' }),
    ).not.toThrow()
    expect(() => BrandConfigUpdateSchema.parse({ logoUrl: 'notaurl' })).toThrow()
  })
})

describe('brandTokensToCss', () => {
  it('maps a token to its CSS variable', () => {
    const css = brandTokensToCss(DEFAULT_BRAND.tokens)
    expect(css).toContain('--brand-primary: #f59e0b;')
  })

  it('emits both aliases for text tokens', () => {
    const css = brandTokensToCss(DEFAULT_BRAND.tokens)
    expect(css).toContain('--text-primary: #f1f5f9;')
    expect(css).toContain('--wb-text-primary: #f1f5f9;')
  })
})

describe('themeId on the brand contract', () => {
  it('defaults DEFAULT_BRAND to arada', () => {
    expect(DEFAULT_BRAND.themeId).toBe('arada')
  })

  it('accepts a known theme id', () => {
    expect(() => BrandConfigSchema.parse({ ...DEFAULT_BRAND, themeId: 'dash5' })).not.toThrow()
  })

  it('rejects an unknown theme id', () => {
    expect(() => BrandConfigSchema.parse({ ...DEFAULT_BRAND, themeId: 'nope' })).toThrow()
  })

  it('defaults themeId when the field is absent', () => {
    const { themeId, ...withoutTheme } = DEFAULT_BRAND
    expect(BrandConfigSchema.parse(withoutTheme).themeId).toBe('arada')
  })

  it('accepts a themeId-only update payload', () => {
    expect(() => BrandConfigUpdateSchema.parse({ themeId: 'dash5' })).not.toThrow()
  })

  it('rejects an unknown themeId in an update payload', () => {
    expect(() => BrandConfigUpdateSchema.parse({ themeId: 'nope' })).toThrow()
  })

  it('does not inject a themeId default into an unrelated partial save', () => {
    // .partial() + .default() would silently reset every deployment's theme
    // whenever someone saved only a display name. It must stay absent.
    expect(BrandConfigUpdateSchema.parse({ displayName: 'X' }).themeId).toBeUndefined()
  })
})
