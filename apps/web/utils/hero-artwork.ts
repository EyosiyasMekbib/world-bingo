import type { ThemeId } from '@world-bingo/shared-types'

export type HeroAction = 'games' | 'aviator' | 'rooms' | 'deposit' | 'predictions' | 'promotions'

export interface HeroArtwork {
  id: string
  cta: string
  action: HeroAction
  /**
   * The banner is the whole slide — no gradient, no text overlay. Sized ~2.47:1.
   * A separate mobile crop is optional; without one the desktop file is used at
   * every width rather than pointing a <source> at a crop that does not exist.
   */
  image: { desktop: string; mobile?: string; alt: string }
}

/**
 * Artwork banners, keyed by the deployment they were drawn for.
 *
 * Every brand ships from this one codebase and picks its identity at runtime
 * (`GET /brand` → `themeId`), but artwork has its brand baked into the pixels —
 * a banner announcing one brand's domain is simply wrong on another, not merely
 * off-palette. So the artwork is keyed by theme rather than shown to everyone.
 *
 * `Record<ThemeId, …>` is deliberate: adding a theme is a type error here until
 * someone says what that brand's hero should show. Empty is a valid answer — the
 * coded slides in the lobby carry the hero on their own.
 *
 * Files live in apps/web/public/ads/hero/.
 */
const ARTWORK_BY_THEME: Record<ThemeId, HeroArtwork[]> = {
  arada: [],
  // The dash banners were drawn green with dash1.games in the pixels; winner
  // runs on the coded slides until it has artwork of its own.
  winner: [],
}

/**
 * Artwork for the active brand. A theme id that predates its entry here — or an
 * unrecognised one off the wire — yields nothing rather than another brand's
 * banners, so the failure mode is a plain coded hero, never a mislabelled one.
 */
export function heroArtworkFor(themeId: ThemeId): HeroArtwork[] {
  return ARTWORK_BY_THEME[themeId] ?? []
}

export interface HeroTone {
  /** Slide background. */
  gradient: string
  /** Watermark colour. */
  accent: string
}

/**
 * Coded-slide colours for brands the stock tones fight. The lobby's slides are
 * green, blue and amber so they read as different things on arada; on a red
 * brand that rainbow looks like someone else's site. Keyed by slide id — a
 * slide with no entry keeps its own tone.
 */
const TONES_BY_THEME: Partial<Record<ThemeId, Record<string, HeroTone>>> = {
  // Black into the brand red, after the reference's cashback banner. Each slide
  // ends on a different red so the carousel still visibly moves.
  winner: {
    predictions: {
      gradient: 'linear-gradient(105deg,#0a0a0a 0%,#3d070d 48%,#9e0f1a 100%)',
      accent: '#fff203',
    },
    aviator: {
      gradient: 'linear-gradient(105deg,#0a0a0a 0%,#2b0508 40%,#a3111c 78%,#e62733 100%)',
      accent: '#fff203',
    },
    bingo: {
      gradient: 'linear-gradient(105deg,#0a0a0a 0%,#45070e 50%,#c41a26 100%)',
      accent: '#fff203',
    },
    bonus: {
      gradient: 'linear-gradient(105deg,#140203 0%,#6b0b14 45%,#e62733 100%)',
      accent: '#fff203',
    },
    // /games only.
    tournaments: {
      gradient: 'linear-gradient(105deg,#0a0a0a 0%,#3a0509 45%,#b3121e 100%)',
      accent: '#fff203',
    },
  },
}

/** The brand's tone for a coded slide, or undefined to keep the slide's own. */
export function heroToneFor(themeId: ThemeId, slideId: string): HeroTone | undefined {
  return TONES_BY_THEME[themeId]?.[slideId]
}
