import prisma from '../lib/prisma'
import {
  BrandConfig,
  BrandConfigUpdate,
  BrandConfigUpdateSchema,
  DEFAULT_BRAND,
} from '@world-bingo/shared-types'

const SINGLETON_ID = 'default'

/** Deep-merge a stored row over DEFAULT_BRAND. Missing token keys fall back. */
function mergeBrand(row: {
  displayName: string
  shortName: string
  logoUrl: string | null
  faviconUrl: string | null
  tokens: unknown
} | null): BrandConfig {
  if (!row) return DEFAULT_BRAND
  const rowTokens = (row.tokens ?? {}) as Partial<BrandConfig['tokens']>
  return {
    displayName: row.displayName ?? DEFAULT_BRAND.displayName,
    shortName: row.shortName ?? DEFAULT_BRAND.shortName,
    logoUrl: row.logoUrl ?? DEFAULT_BRAND.logoUrl,
    faviconUrl: row.faviconUrl ?? DEFAULT_BRAND.faviconUrl,
    tokens: { ...DEFAULT_BRAND.tokens, ...rowTokens },
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
    const mergedTokens = patch.tokens
      ? { ...existingTokens, ...patch.tokens }
      : existingTokens

    const data = {
      displayName: patch.displayName ?? existing?.displayName ?? DEFAULT_BRAND.displayName,
      shortName: patch.shortName ?? existing?.shortName ?? DEFAULT_BRAND.shortName,
      logoUrl: patch.logoUrl !== undefined ? patch.logoUrl : existing?.logoUrl ?? null,
      faviconUrl: patch.faviconUrl !== undefined ? patch.faviconUrl : existing?.faviconUrl ?? null,
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
