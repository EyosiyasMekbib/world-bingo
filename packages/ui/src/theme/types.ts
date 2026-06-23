// packages/ui/src/theme/types.ts
export interface BrandColors {
  surfaceBase: string
  surfaceRaised: string
  surfaceBorder: string
  brandPrimary: string
  brandPrimaryDim: string
  accent: string
  textPrimary: string
  textSecondary: string
  textOnBrand: string
  statusSuccess: string
  statusError: string
  statusWarning: string
  statusInfo: string
  cartelaUnmarkedBg: string
  cartelaMarkedBg: string
  ballB: string
  ballI: string
  ballN: string
  ballG: string
  ballO: string
}

export interface BrandFonts {
  heading: string // e.g. 'Oswald'
  ui: string // e.g. 'Barlow Condensed'
  body: string // e.g. 'Inter'
  googleHref: string // Google Fonts stylesheet URL for the three families
}

export interface BrandManifest {
  themeColor: string
  backgroundColor: string
  shortName: string
}

export interface BrandTheme {
  id: string
  name: string
  colors: BrandColors
  fonts: BrandFonts
  logo: { full: string; mark: string }
  manifest: BrandManifest
}
