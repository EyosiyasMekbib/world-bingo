import { describe, expect, it } from 'vitest'
import { HERO_BANNER_SPEC } from '@world-bingo/shared-types'
import {
  HERO_BANNER_MOBILE_MEDIA,
  heroBannerAspectRatio,
  heroBannerLink,
  parseHeroBanners,
  parseStoredHeroBannerMode,
  resolveHeroBannerMode,
  type HeroBannerSlide,
} from './hero-banners'

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    desktopImageUrl: '/uploads/b1-desktop.webp',
    mobileImageUrl: '/uploads/b1-mobile.webp',
    altText: 'Weekend bonus',
    linkUrl: null,
    ...overrides,
  }
}

function slide(id: string): HeroBannerSlide {
  return {
    id,
    desktopImageUrl: `/uploads/${id}-d.webp`,
    mobileImageUrl: `/uploads/${id}-m.webp`,
    altText: '',
    link: { kind: 'none' },
    linkLabel: 'Open banner',
  }
}

describe('the banner box follows the upload spec', () => {
  it('switches to the mobile image at the spec breakpoint', () => {
    expect(HERO_BANNER_MOBILE_MEDIA).toBe(`(max-width: ${HERO_BANNER_SPEC.mobileMaxWidthPx}px)`)
  })

  it('sizes each variant to its spec ratio', () => {
    expect(heroBannerAspectRatio('desktop')).toBe(
      `${HERO_BANNER_SPEC.desktop.width} / ${HERO_BANNER_SPEC.desktop.height}`,
    )
    expect(heroBannerAspectRatio('mobile')).toBe(
      `${HERO_BANNER_SPEC.mobile.width} / ${HERO_BANNER_SPEC.mobile.height}`,
    )
  })
})

describe('banner click-through', () => {
  it('is not clickable without a link', () => {
    expect(heroBannerLink(null)).toEqual({ kind: 'none' })
    expect(heroBannerLink(undefined)).toEqual({ kind: 'none' })
    expect(heroBannerLink('')).toEqual({ kind: 'none' })
  })

  it('routes a site path in-app', () => {
    expect(heroBannerLink('/promotions?tab=bonus')).toEqual({
      kind: 'internal',
      to: '/promotions?tab=bonus',
    })
  })

  it('opens an https URL as an external link', () => {
    expect(heroBannerLink('https://example.com/offer')).toEqual({
      kind: 'external',
      href: 'https://example.com/offer',
    })
  })

  it.each([
    'javascript:alert(1)',
    'http://example.com',
    '//evil.example',
    '/\\evil.example',
    '/games now',
    'games',
    'data:text/html,hi',
  ])('refuses %s', (link) => {
    expect(heroBannerLink(link)).toEqual({ kind: 'none' })
  })
})

describe('parsing GET /hero-banners', () => {
  it('keeps banners in the order served', () => {
    const slides = parseHeroBanners({ items: [item({ id: 'a' }), item({ id: 'b' })] })
    expect(slides.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('carries the image pair, alt text and classified link', () => {
    const [s] = parseHeroBanners({ items: [item({ linkUrl: '/games' })] })
    expect(s).toEqual({
      id: 'b1',
      desktopImageUrl: '/uploads/b1-desktop.webp',
      mobileImageUrl: '/uploads/b1-mobile.webp',
      altText: 'Weekend bonus',
      link: { kind: 'internal', to: '/games' },
      linkLabel: 'Weekend bonus',
    })
  })

  it('gives a link without alt text a generic accessible label', () => {
    const [s] = parseHeroBanners({ items: [item({ altText: '  ' })] })
    expect(s.altText).toBe('')
    expect(s.linkLabel).toBe('Open banner')
  })

  it('drops an unsafe link but keeps the banner', () => {
    const [s] = parseHeroBanners({ items: [item({ linkUrl: 'javascript:alert(1)' })] })
    expect(s.link).toEqual({ kind: 'none' })
  })

  it('accepts absolute object-store image URLs', () => {
    const slides = parseHeroBanners({
      items: [item({ desktopImageUrl: 'https://cdn.example/d.webp', mobileImageUrl: 'http://minio:9000/m.webp' })],
    })
    expect(slides).toHaveLength(1)
  })

  it.each([
    ['missing id', { id: undefined }],
    ['empty id', { id: '' }],
    ['missing desktop image', { desktopImageUrl: undefined }],
    ['missing mobile image', { mobileImageUrl: '' }],
    ['non-string image', { desktopImageUrl: 42 }],
    ['javascript: image', { desktopImageUrl: 'javascript:alert(1)' }],
    ['protocol-relative image', { mobileImageUrl: '//evil.example/m.webp' }],
    ['image URL with whitespace', { mobileImageUrl: '/uploads/a b.webp' }],
  ])('drops an item with %s', (_label, overrides) => {
    expect(parseHeroBanners({ items: [item(overrides), item({ id: 'ok' })] }).map((s) => s.id)).toEqual(['ok'])
  })

  it('drops a repeated id', () => {
    const slides = parseHeroBanners({ items: [item({ id: 'a' }), item({ id: 'a', altText: 'dupe' })] })
    expect(slides).toHaveLength(1)
    expect(slides[0].altText).toBe('Weekend bonus')
  })

  it.each([null, undefined, 'oops', 42, {}, { items: null }, { items: 'x' }, [item()]])(
    'yields nothing for a malformed body (%j)',
    (body) => {
      expect(parseHeroBanners(body)).toEqual([])
    },
  )
})

describe('choosing the hero', () => {
  const none = new Set<string>()

  it('holds a placeholder until the request settles', () => {
    expect(resolveHeroBannerMode(null, none)).toEqual({ kind: 'loading' })
  })

  it('shows only the banners when there are any', () => {
    const mode = resolveHeroBannerMode([slide('a'), slide('b')], none)
    expect(mode.kind).toBe('banners')
    expect(mode.kind === 'banners' && mode.slides.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('falls back to the built-in slides when there are no banners or the request failed', () => {
    expect(resolveHeroBannerMode([], none)).toEqual({ kind: 'fallback' })
  })

  it('drops a banner whose image failed to load', () => {
    const mode = resolveHeroBannerMode([slide('a'), slide('b')], new Set(['a']))
    expect(mode.kind === 'banners' && mode.slides.map((s) => s.id)).toEqual(['b'])
  })

  it('falls back once every banner image has failed', () => {
    expect(resolveHeroBannerMode([slide('a'), slide('b')], new Set(['a', 'b']))).toEqual({
      kind: 'fallback',
    })
  })
})

describe('remembering what the last visit found', () => {
  const none = new Set<string>()

  it('shows the built-in slides at once when the last visit had no banners', () => {
    expect(resolveHeroBannerMode(null, none, 'fallback')).toEqual({ kind: 'fallback' })
  })

  it('holds the placeholder when the last visit had banners, or nothing is remembered', () => {
    expect(resolveHeroBannerMode(null, none, 'banners')).toEqual({ kind: 'loading' })
    expect(resolveHeroBannerMode(null, none, null)).toEqual({ kind: 'loading' })
  })

  it('still switches to banners that appear after a remembered fallback', () => {
    expect(resolveHeroBannerMode([slide('a')], none, 'fallback').kind).toBe('banners')
  })

  it.each([
    ['banners', 'banners'],
    ['fallback', 'fallback'],
    ['loading', null],
    [null, null],
    [42, null],
  ])('reads a stored %j as %j', (stored, expected) => {
    expect(parseStoredHeroBannerMode(stored)).toBe(expected)
  })
})
