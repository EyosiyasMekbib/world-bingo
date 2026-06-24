import { z } from 'zod'

// Accept hex (#rgb / #rrggbb / #rrggbbaa) or rgb()/rgba() strings.
const colorValue = z
  .string()
  .regex(
    /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\(\s*\S[^)]*\))$/,
    'Must be a hex (#rgb/#rrggbb) or rgb()/rgba() color',
  )

// Asset URL: an absolute http(s) URL or a root-relative path. Uploaded assets
// are stored as root-relative `/uploads/...` paths (served by the API and
// proxied by the frontends), so a strict `.url()` would wrongly reject them.
const assetUrl = z
  .string()
  .refine(
    (s) => s.startsWith('/') || /^https?:\/\//.test(s),
    'Must be an absolute URL or a root-relative path',
  )

// Token key -> CSS custom property name(s). The map IS the closed set of keys.
export const BRAND_TOKEN_CSS_VARS = {
  surfaceBase: ['--surface-base'],
  surfaceRaised: ['--surface-raised'],
  surfaceOverlay: ['--surface-overlay'],
  surfaceBorder: ['--surface-border'],
  brandPrimary: ['--brand-primary'],
  brandPrimaryDim: ['--brand-primary-dim'],
  brandPrimaryGlow: ['--brand-primary-glow'],
  accentPrimary: ['--accent-primary'],
  accentDim: ['--accent-dim'],
  accentGlow: ['--accent-glow'],
  statusSuccess: ['--status-success'],
  statusError: ['--status-error'],
  statusWarning: ['--status-warning'],
  statusInfo: ['--status-info'],
  textPrimary: ['--text-primary', '--wb-text-primary'],
  textSecondary: ['--text-secondary', '--wb-text-secondary'],
  textDisabled: ['--text-disabled', '--wb-text-disabled'],
  textOnBrand: ['--text-on-brand', '--wb-text-on-brand'],
  cartelaUnmarkedBg: ['--cartela-unmarked-bg'],
  cartelaMarkedBg: ['--cartela-marked-bg'],
  cartelaMarkedText: ['--cartela-marked-text'],
  cartelaFreeBg: ['--cartela-free-bg'],
  cartelaFreeText: ['--cartela-free-text'],
  numberCalledGlow: ['--number-called-glow'],
  winnerGlow: ['--winner-glow'],
  ballB: ['--ball-b'],
  ballI: ['--ball-i'],
  ballN: ['--ball-n'],
  ballG: ['--ball-g'],
  ballO: ['--ball-o'],
} as const

export type BrandTokenKey = keyof typeof BRAND_TOKEN_CSS_VARS

// Build a strict object schema from the token-var map keys.
const tokensShape = Object.fromEntries(
  (Object.keys(BRAND_TOKEN_CSS_VARS) as BrandTokenKey[]).map((k) => [k, colorValue]),
) as Record<BrandTokenKey, typeof colorValue>

export const BrandTokensSchema = z.object(tokensShape).strict()
export type BrandTokens = z.infer<typeof BrandTokensSchema>

export const BrandConfigSchema = z
  .object({
    displayName: z.string().min(1).max(60),
    shortName: z.string().min(1).max(30),
    logoUrl: assetUrl.nullable(),
    faviconUrl: assetUrl.nullable(),
    tokens: BrandTokensSchema,
  })
  .strict()
export type BrandConfig = z.infer<typeof BrandConfigSchema>

// Partial update payload — any subset of fields, tokens can be partial.
export const BrandConfigUpdateSchema = z
  .object({
    displayName: z.string().min(1).max(60),
    shortName: z.string().min(1).max(30),
    logoUrl: assetUrl.nullable(),
    faviconUrl: assetUrl.nullable(),
    tokens: BrandTokensSchema.partial(),
  })
  .partial()
  .strict()
export type BrandConfigUpdate = z.infer<typeof BrandConfigUpdateSchema>

export const DEFAULT_BRAND: BrandConfig = {
  displayName: 'World Bingo',
  shortName: 'World',
  logoUrl: null,
  faviconUrl: null,
  tokens: {
    surfaceBase: '#0a0f1e',
    surfaceRaised: '#111827',
    surfaceOverlay: '#1c2537',
    surfaceBorder: '#1e2d4a',
    brandPrimary: '#f59e0b',
    brandPrimaryDim: '#d97706',
    brandPrimaryGlow: 'rgba(245, 158, 11, 0.3)',
    accentPrimary: '#06b6d4',
    accentDim: '#0891b2',
    accentGlow: 'rgba(6, 182, 212, 0.25)',
    statusSuccess: '#10b981',
    statusError: '#ef4444',
    statusWarning: '#f59e0b',
    statusInfo: '#3b82f6',
    textPrimary: '#f1f5f9',
    textSecondary: '#94a3b8',
    textDisabled: '#475569',
    textOnBrand: '#000000',
    cartelaUnmarkedBg: '#1e2d4a',
    cartelaMarkedBg: '#0891b2',
    cartelaMarkedText: '#ffffff',
    cartelaFreeBg: '#f59e0b',
    cartelaFreeText: '#000000',
    numberCalledGlow: 'rgba(6, 182, 212, 0.6)',
    winnerGlow: 'rgba(245, 158, 11, 0.8)',
    ballB: '#f59e0b',
    ballI: '#06b6d4',
    ballN: '#8b5cf6',
    ballG: '#10b981',
    ballO: '#ef4444',
  },
}

/** Render a brand's tokens as the body of a `:root { ... }` CSS block. */
export function brandTokensToCss(tokens: BrandTokens): string {
  const lines: string[] = []
  for (const key of Object.keys(BRAND_TOKEN_CSS_VARS) as BrandTokenKey[]) {
    const value = tokens[key]
    for (const cssVar of BRAND_TOKEN_CSS_VARS[key]) {
      lines.push(`${cssVar}: ${value};`)
    }
  }
  return lines.join('\n')
}
