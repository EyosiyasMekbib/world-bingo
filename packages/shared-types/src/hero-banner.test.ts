import { describe, expect, it } from 'vitest'
import {
  HeroBannerCreateFieldsSchema,
  HeroBannerUpdateSchema,
  heroBannerImageProblem,
  isExternalHeroBannerLink,
  isValidHeroBannerLink,
} from './hero-banner'

describe('heroBannerImageProblem', () => {
  it('accepts the exact desktop and mobile sizes', () => {
    expect(heroBannerImageProblem('desktop', 1440, 300)).toBeNull()
    expect(heroBannerImageProblem('mobile', 780, 452)).toBeNull()
  })

  it('accepts the existing 1x mobile art and a 2x desktop export', () => {
    expect(heroBannerImageProblem('mobile', 390, 226)).toBeNull()
    expect(heroBannerImageProblem('desktop', 2880, 600)).toBeNull()
  })

  it('rejects the wrong shape', () => {
    expect(heroBannerImageProblem('desktop', 1500, 600)).toMatch(/1440×300/)
    expect(heroBannerImageProblem('mobile', 1440, 300)).toMatch(/780×452/)
  })

  it('rejects a right-shaped image that is too small to stay sharp', () => {
    expect(heroBannerImageProblem('desktop', 720, 150)).toMatch(/at least 1440px/)
  })

  it('rejects unreadable dimensions', () => {
    expect(heroBannerImageProblem('desktop', 0, 0)).toMatch(/dimensions/)
  })
})

describe('hero banner links', () => {
  it('allows site paths and https URLs only', () => {
    expect(isValidHeroBannerLink('/games')).toBe(true)
    expect(isValidHeroBannerLink('/play/atlasv/keno')).toBe(true)
    expect(isValidHeroBannerLink('https://example.com/promo')).toBe(true)
    expect(isValidHeroBannerLink('//evil.com')).toBe(false)
    expect(isValidHeroBannerLink('javascript:alert(1)')).toBe(false)
    expect(isValidHeroBannerLink('http://example.com')).toBe(false)
    expect(isValidHeroBannerLink('games')).toBe(false)
  })

  it('rejects backslash tricks that browsers resolve off-site', () => {
    expect(isValidHeroBannerLink('/\\evil.com')).toBe(false)
    expect(isValidHeroBannerLink('/\\/evil.com')).toBe(false)
    expect(isValidHeroBannerLink('/games\\x')).toBe(false)
    expect(isValidHeroBannerLink('https://good.com\\@evil.com')).toBe(false)
  })

  it('tells external links apart', () => {
    expect(isExternalHeroBannerLink('https://example.com')).toBe(true)
    expect(isExternalHeroBannerLink('/games')).toBe(false)
  })

  it('treats an empty multipart link as no link', () => {
    expect(HeroBannerCreateFieldsSchema.parse({ linkUrl: '' })).toEqual({ altText: '', linkUrl: null })
    expect(HeroBannerUpdateSchema.parse({ linkUrl: '  ' })).toEqual({ linkUrl: null })
  })

  it('rejects an unsafe link in an update', () => {
    expect(HeroBannerUpdateSchema.safeParse({ linkUrl: 'javascript:alert(1)' }).success).toBe(false)
  })
})
