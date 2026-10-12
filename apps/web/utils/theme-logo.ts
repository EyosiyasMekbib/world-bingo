import type { ThemeId } from '@world-bingo/shared-types'

/**
 * The logo a theme ships with, shown when the brand has no uploaded logo. An
 * upload from admin → Branding still wins.
 *
 * `Record<ThemeId, …>` so adding a theme is a type error here until someone
 * says what its logo is. null is a valid answer: BrandLogo falls back to the
 * display-name wordmark.
 *
 * Files live in apps/web/public/brands/<theme>/.
 */
const LOGO_BY_THEME: Record<ThemeId, string | null> = {
  arada: null,
  winner: '/brands/winner/logo.png',
}

export function themeLogoFor(themeId: string | undefined): string | null {
  return (themeId && LOGO_BY_THEME[themeId as ThemeId]) || null
}
