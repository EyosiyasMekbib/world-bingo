import prisma from '../lib/prisma'
import {
  BrandConfig,
  BrandConfigUpdate,
  BrandConfigUpdateSchema,
  DEFAULT_BRAND,
  resolveTheme,
} from '@world-bingo/shared-types'

const SINGLETON_ID = 'default'

/**
 * Merge a stored row over its theme's default palette. The stored `tokens` blob
 * holds only the keys an admin explicitly overrode; everything else comes from
 * the active theme.
 */
function mergeBrand(row: {
  displayName: string
  shortName: string
  logoUrl: string | null
  faviconUrl: string | null
  themeId: string | null
  tokens: unknown
} | null): BrandConfig {
  if (!row) return DEFAULT_BRAND
  const theme = resolveTheme(row.themeId ?? undefined)
  const rowTokens = (row.tokens ?? {}) as Partial<BrandConfig['tokens']>
  return {
    displayName: row.displayName ?? DEFAULT_BRAND.displayName,
    shortName: row.shortName ?? DEFAULT_BRAND.shortName,
    logoUrl: row.logoUrl ?? DEFAULT_BRAND.logoUrl,
    faviconUrl: row.faviconUrl ?? DEFAULT_BRAND.faviconUrl,
    themeId: theme.id,
    tokens: { ...theme.defaultTokens, ...rowTokens },
  }
}

export class BrandService {
  /** Public read. Never throws — falls back to defaults on any DB error. */
  static async getBrand(): Promise<BrandConfig> {
    try {
      const row = await prisma.brandSetting.findUnique({ where: { id: SINGLETON_ID } })
      return mergeBrand(row as any)
    } catch {
      return DEFAULT_BRAND
    }
  }

  /** Admin write. Validates, then upserts the singleton, merging token partials. */
  static async updateBrand(input: BrandConfigUpdate): Promise<BrandConfig> {
    const patch = BrandConfigUpdateSchema.parse(input)

    const existing = await prisma.brandSetting.findUnique({ where: { id: SINGLETON_ID } })
    const existingTokens = ((existing?.tokens ?? {}) as Record<string, string>) || {}
    const existingThemeId = existing?.themeId ?? DEFAULT_BRAND.themeId
    const nextThemeId = patch.themeId ?? existingThemeId

    // Switching theme discards colour overrides — otherwise the previous theme's
    // palette would fully mask the new one and the switch would be invisible.
    // An explicit `tokens` payload in the same request wins over the reset.
    const themeChanged = nextThemeId !== existingThemeId
    const mergedTokens = patch.tokens
      ? { ...(themeChanged ? {} : existingTokens), ...patch.tokens }
      : themeChanged
        ? {}
        : existingTokens

    const data = {
      displayName: patch.displayName ?? existing?.displayName ?? DEFAULT_BRAND.displayName,
      shortName: patch.shortName ?? existing?.shortName ?? DEFAULT_BRAND.shortName,
      logoUrl: patch.logoUrl !== undefined ? patch.logoUrl : existing?.logoUrl ?? null,
      faviconUrl: patch.faviconUrl !== undefined ? patch.faviconUrl : existing?.faviconUrl ?? null,
      themeId: nextThemeId,
      tokens: mergedTokens,
    }

    await prisma.brandSetting.upsert({
      where: { id: SINGLETON_ID },
      update: data,
      create: { id: SINGLETON_ID, ...data },
    })

    return BrandService.getBrand()
  }
}
