// packages/ui/src/theme/brands/arada.ts
import type { BrandTheme } from '../types'

export const arada: BrandTheme = {
  id: 'arada',
  name: 'Arada Bingo',
  colors: {
    surfaceBase: '#0a1628',
    surfaceRaised: '#0d1f3c',
    surfaceBorder: 'rgba(255,255,255,0.12)',
    brandPrimary: '#f5a623',
    brandPrimaryDim: '#c8851a',
    accent: '#1d4a8a',
    textPrimary: '#ffffff',
    textSecondary: 'rgba(255,255,255,0.7)',
    textOnBrand: '#0a1628',
    statusSuccess: '#1a7a4a',
    statusError: '#ef4444',
    statusWarning: '#f5a623',
    statusInfo: '#1d4a8a',
    cartelaUnmarkedBg: '#0d1f3c',
    cartelaMarkedBg: '#f5a623',
    ballB: '#f5a623',
    ballI: '#1d4a8a',
    ballN: '#7a2a8a',
    ballG: '#1a7a4a',
    ballO: '#a8521a',
  },
  fonts: {
    heading: 'Oswald',
    ui: 'Barlow Condensed',
    body: 'Inter',
    googleHref:
      'https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap',
  },
  logo: { full: '/brands/arada/logo.svg', mark: '/brands/arada/mark.svg' },
  manifest: { themeColor: '#f5a623', backgroundColor: '#0a1628', shortName: 'Arada' },
}
