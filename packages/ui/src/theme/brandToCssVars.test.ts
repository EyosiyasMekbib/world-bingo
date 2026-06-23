// packages/ui/src/theme/brandToCssVars.test.ts
import { describe, expect, it } from 'vitest'
import { brandToCssVars } from './brandToCssVars'
import type { BrandTheme } from './types'

const theme: BrandTheme = {
  id: 'test',
  name: 'Test Brand',
  colors: {
    surfaceBase: '#000', surfaceRaised: '#111', surfaceBorder: '#222',
    brandPrimary: '#f5a623', brandPrimaryDim: '#c8851a', accent: '#1d4a8a',
    textPrimary: '#fff', textSecondary: '#aaa', textOnBrand: '#000',
    statusSuccess: '#0f0', statusError: '#f00', statusWarning: '#ff0', statusInfo: '#00f',
    cartelaUnmarkedBg: '#1a2', cartelaMarkedBg: '#2b3',
    ballB: '#1', ballI: '#2', ballN: '#3', ballG: '#4', ballO: '#5',
  },
  fonts: { heading: 'Oswald', ui: 'Barlow Condensed', body: 'Inter', googleHref: 'https://x' },
  logo: { full: '/logo.svg', mark: '/mark.svg' },
  manifest: { themeColor: '#000', backgroundColor: '#000', shortName: 'TB' },
}

describe('brandToCssVars', () => {
  it('maps brand color to --brand-primary', () => {
    expect(brandToCssVars(theme)['--brand-primary']).toBe('#f5a623')
  })
  it('maps fonts to --font-heading/--font-ui/--font-body with fallback', () => {
    const vars = brandToCssVars(theme)
    expect(vars['--font-heading']).toBe("'Oswald', sans-serif")
    expect(vars['--font-ui']).toBe("'Barlow Condensed', sans-serif")
    expect(vars['--font-body']).toBe("'Inter', sans-serif")
  })
  it('produces a flat record of string CSS values', () => {
    const vars = brandToCssVars(theme)
    expect(Object.values(vars).every((v) => typeof v === 'string')).toBe(true)
  })
})
