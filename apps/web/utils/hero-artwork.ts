import type { ThemeId } from '@world-bingo/shared-types'

export type HeroAction = 'games' | 'rooms' | 'deposit' | 'predictions' | 'promotions'

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
 * a banner announcing dash1.games is simply wrong on arada, not merely
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
  dash5: [
    {
      id: 'multi-bonus',
      cta: 'Claim Bonus',
      action: 'deposit',
      image: { desktop: '/ads/hero/multi-bonus.webp', alt: '500% Multi Bonus' },
    },
    {
      id: 'sport-cashback',
      cta: 'See Promotions',
      action: 'promotions',
      image: { desktop: '/ads/hero/sport-cashback.webp', alt: '1000% Cashback in Sport' },
    },
    {
      id: 'we-are-back',
      cta: 'Play Now',
      action: 'games',
      image: { desktop: '/ads/hero/we-are-back.webp', alt: 'We are back — dash1.games' },
    },
  ],
}

/**
 * Artwork for the active brand. A theme id that predates its entry here — or an
 * unrecognised one off the wire — yields nothing rather than another brand's
 * banners, so the failure mode is a plain coded hero, never a mislabelled one.
 */
export function heroArtworkFor(themeId: ThemeId): HeroArtwork[] {
  return ARTWORK_BY_THEME[themeId] ?? []
}
