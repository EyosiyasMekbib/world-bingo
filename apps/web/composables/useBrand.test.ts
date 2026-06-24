import { describe, it, expect } from 'vitest'
import { brandTokensToCss, DEFAULT_BRAND } from '@world-bingo/shared-types'
import { buildBrandStyle } from './useBrand'

describe('buildBrandStyle', () => {
  it('wraps the token CSS in a :root block', () => {
    const style = buildBrandStyle(DEFAULT_BRAND.tokens)
    expect(style.startsWith(':root {')).toBe(true)
    expect(style).toContain(brandTokensToCss(DEFAULT_BRAND.tokens))
    expect(style.trim().endsWith('}')).toBe(true)
  })
})
