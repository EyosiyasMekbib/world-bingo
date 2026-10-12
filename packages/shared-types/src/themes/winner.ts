import type { ThemeDefinition } from './types'

/**
 * Black chrome, charcoal panels, signal-yellow primary and a red accent. The
 * values are sampled from the reference design, so keep them literal rather
 * than nudging them toward something "nicer".
 */
export const winner: ThemeDefinition = {
  id: 'winner',
  name: 'Winner',
  defaultTokens: {
    surfaceBase: '#141414',
    surfaceRaised: '#242424',
    surfaceOverlay: '#333333',
    surfaceBorder: 'rgba(255, 255, 255, 0.1)',
    brandPrimary: '#fff203',
    brandPrimaryDim: '#d9ce00',
    brandPrimaryGlow: 'rgba(255, 242, 3, 0.25)',
    accentPrimary: '#e62733',
    accentDim: '#b81d27',
    accentGlow: 'rgba(230, 39, 51, 0.3)',
    statusSuccess: '#32ac4e',
    statusError: '#e62733',
    statusWarning: '#ff9f1a',
    statusInfo: '#3b9ae1',
    textPrimary: '#ffffff',
    textSecondary: 'rgba(255, 255, 255, 0.62)',
    textDisabled: '#6e6e6e',
    textOnBrand: '#000000',
    cartelaUnmarkedBg: '#333333',
    cartelaMarkedBg: '#fff203',
    cartelaMarkedText: '#000000',
    cartelaFreeBg: '#e62733',
    cartelaFreeText: '#ffffff',
    numberCalledGlow: 'rgba(255, 242, 3, 0.6)',
    winnerGlow: 'rgba(255, 242, 3, 0.8)',
    ballB: '#fff203',
    ballI: '#e62733',
    ballN: '#3b9ae1',
    ballG: '#32ac4e',
    ballO: '#ff9f1a',
  },
  typography: {
    ui: "'Roboto Condensed', sans-serif",
    body: "'Roboto Condensed', sans-serif",
    heading: "'Roboto Condensed', sans-serif",
    googleHref:
      'https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@400;500;700;800&display=swap',
    baseSize: '14px',
  },
  density: {
    utilH: '64px',
    navH: '84px',
    rowH: '48px',
    controlH: '44px',
    inputH: '44px',
    railW: '280px',
    asideW: '340px',
    radiusSm: '4px',
    radiusMd: '4px',
    radiusLg: '6px',
    borderW: '1px',
  },
}
