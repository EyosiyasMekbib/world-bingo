// packages/ui/src/theme/brandToCssVars.ts
import type { BrandTheme } from './types'

export function brandToCssVars(theme: BrandTheme): Record<string, string> {
  const c = theme.colors
  return {
    '--surface-base': c.surfaceBase,
    '--surface-raised': c.surfaceRaised,
    '--surface-border': c.surfaceBorder,
    '--brand-primary': c.brandPrimary,
    '--brand-primary-dim': c.brandPrimaryDim,
    '--accent-primary': c.accent,
    '--text-primary': c.textPrimary,
    '--wb-text-primary': c.textPrimary,
    '--text-secondary': c.textSecondary,
    '--wb-text-secondary': c.textSecondary,
    '--text-on-brand': c.textOnBrand,
    '--wb-text-on-brand': c.textOnBrand,
    '--status-success': c.statusSuccess,
    '--status-error': c.statusError,
    '--status-warning': c.statusWarning,
    '--status-info': c.statusInfo,
    '--cartela-unmarked-bg': c.cartelaUnmarkedBg,
    '--cartela-marked-bg': c.cartelaMarkedBg,
    '--ball-b': c.ballB,
    '--ball-i': c.ballI,
    '--ball-n': c.ballN,
    '--ball-g': c.ballG,
    '--ball-o': c.ballO,
    '--font-heading': `'${theme.fonts.heading}', sans-serif`,
    '--font-ui': `'${theme.fonts.ui}', sans-serif`,
    '--font-body': `'${theme.fonts.body}', sans-serif`,
    '--font-game': `'${theme.fonts.heading}', sans-serif`,
  }
}
