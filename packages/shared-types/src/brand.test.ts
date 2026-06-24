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
