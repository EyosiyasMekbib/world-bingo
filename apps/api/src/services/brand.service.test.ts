import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_BRAND } from '@world-bingo/shared-types'

vi.mock('../lib/prisma', () => ({
  default: {
    brandSetting: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}))

import prisma from '../lib/prisma'
import { BrandService } from './brand.service'

describe('BrandService.getBrand', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns DEFAULT_BRAND when no row exists', async () => {
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue(null)
    const brand = await BrandService.getBrand()
    expect(brand).toEqual(DEFAULT_BRAND)
  })

  it('merges row over defaults, including partial tokens', async () => {
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue({
      id: 'default',
      displayName: 'Arada Bingo',
      shortName: 'Arada',
      logoUrl: 'https://x/logo.png',
      faviconUrl: null,
      tokens: { brandPrimary: '#14b8a6' },
      updatedAt: new Date(),
    })
    const brand = await BrandService.getBrand()
    expect(brand.displayName).toBe('Arada Bingo')
    expect(brand.tokens.brandPrimary).toBe('#14b8a6')
    expect(brand.tokens.accentPrimary).toBe(DEFAULT_BRAND.tokens.accentPrimary)
  })
})

describe('BrandService.updateBrand', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects an invalid token color', async () => {
    await expect(
      BrandService.updateBrand({ tokens: { brandPrimary: 'notacolor' } as any }),
    ).rejects.toThrow()
    expect(prisma.brandSetting.upsert).not.toHaveBeenCalled()
  })

  it('upserts a valid partial update and returns the merged brand', async () => {
    ;(prisma.brandSetting.upsert as any).mockResolvedValue({})
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue({
      id: 'default',
      displayName: 'Arada Bingo',
      shortName: 'Arada',
      logoUrl: null,
      faviconUrl: null,
      tokens: { brandPrimary: '#14b8a6' },
      updatedAt: new Date(),
    })
    const brand = await BrandService.updateBrand({ displayName: 'Arada Bingo' })
    expect(prisma.brandSetting.upsert).toHaveBeenCalledOnce()
    expect(brand.displayName).toBe('Arada Bingo')
  })
})
