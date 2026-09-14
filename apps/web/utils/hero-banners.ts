import {
  HERO_BANNER_SPEC,
  isExternalHeroBannerLink,
  isValidHeroBannerLink,
  type HeroBannerVariant,
} from '@world-bingo/shared-types'

/** One query drives both the <source> pick and the box ratio, so they never disagree. */
export const HERO_BANNER_MOBILE_MEDIA = `(max-width: ${HERO_BANNER_SPEC.mobileMaxWidthPx}px)`

/**
 * The lobby holds a placeholder until GET /hero-banners settles. A hung request
 * must not hold it forever, so it gives up and the coded slides take over.
 */
export const HERO_BANNER_FETCH_TIMEOUT_MS = 4000

const DEFAULT_LINK_LABEL = 'Open banner'

/** CSS `aspect-ratio` value for a variant's upload spec, e.g. `1440 / 300`. */
export function heroBannerAspectRatio(variant: HeroBannerVariant): string {
  const { width, height } = HERO_BANNER_SPEC[variant]
  return `${width} / ${height}`
}

export type HeroBannerLink =
  | { kind: 'none' }
  | { kind: 'internal'; to: string }
  | { kind: 'external'; href: string }

/** What a banner click does. Anything the shared validator rejects is simply not clickable. */
export function heroBannerLink(linkUrl: unknown): HeroBannerLink {
  if (typeof linkUrl !== 'string' || !isValidHeroBannerLink(linkUrl)) return { kind: 'none' }
  if (isExternalHeroBannerLink(linkUrl)) return { kind: 'external', href: linkUrl }
  return { kind: 'internal', to: linkUrl }
}

export interface HeroBannerSlide {
  id: string
  desktopImageUrl: string
  mobileImageUrl: string
  altText: string
  link: HeroBannerLink
  /** Accessible name for the click target, which has no text of its own. */
  linkLabel: string
}

// Root-relative upload paths (STORAGE_PROVIDER=local) or absolute http(s) URLs
// from an object store. Whitespace is refused because srcset splits on it.
function isImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || /\s/.test(value)) return false
  if (value.startsWith('/')) return !value.startsWith('//') && !value.startsWith('/\\')
  return /^https?:\/\/[^/\\]/i.test(value)
}

/**
 * Turns a GET /hero-banners body into renderable slides, in the order served.
 * Malformed items are dropped rather than failing the whole hero, and a
 * duplicate id is dropped because slide ids key the carousel dots.
 */
export function parseHeroBanners(body: unknown): HeroBannerSlide[] {
  const items = body && typeof body === 'object' ? (body as { items?: unknown }).items : undefined
  if (!Array.isArray(items)) return []

  const seen = new Set<string>()
  const slides: HeroBannerSlide[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const { id, desktopImageUrl, mobileImageUrl, altText, linkUrl } = item as Record<string, unknown>
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    if (!isImageUrl(desktopImageUrl) || !isImageUrl(mobileImageUrl)) continue
    seen.add(id)
    const alt = typeof altText === 'string' ? altText.trim() : ''
    slides.push({
      id,
      desktopImageUrl,
      mobileImageUrl,
      altText: alt,
      link: heroBannerLink(linkUrl),
      linkLabel: alt || DEFAULT_LINK_LABEL,
    })
  }
  return slides
}

export type HeroBannerMode =
  | { kind: 'loading' }
  | { kind: 'banners'; slides: HeroBannerSlide[] }
  | { kind: 'fallback' }

/** What the previous visit settled on, remembered per browser. */
export type SettledHeroBannerMode = 'banners' | 'fallback'
export const HERO_BANNER_MODE_STORAGE_KEY = 'wb_hero_banner_mode'

export function parseStoredHeroBannerMode(value: unknown): SettledHeroBannerMode | null {
  return value === 'banners' || value === 'fallback' ? value : null
}

/**
 * Which hero the lobby shows.
 *
 * `fetched` is null until the request settles; a failed request settles to [].
 * While it is pending, a browser whose last visit found no banners shows the
 * built-in slides at once instead of a placeholder that then reflows into them.
 * Any usable banner replaces the built-in slides outright. Banners whose image
 * failed to load (`broken`) drop out, and once none are left the built-in
 * slides return — the hero is never an empty box.
 */
export function resolveHeroBannerMode(
  fetched: readonly HeroBannerSlide[] | null,
  broken: ReadonlySet<string>,
  lastSettled: SettledHeroBannerMode | null = null,
): HeroBannerMode {
  if (fetched === null) return lastSettled === 'fallback' ? { kind: 'fallback' } : { kind: 'loading' }
  const slides = fetched.filter((s) => !broken.has(s.id))
  return slides.length > 0 ? { kind: 'banners', slides } : { kind: 'fallback' }
}
