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

describe('BrandService theme resolution', () => {
  beforeEach(() => vi.clearAllMocks())

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'default',
    displayName: 'X',
    shortName: 'X',
    logoUrl: null,
    faviconUrl: null,
    themeId: 'arada',
    tokens: {},
    updatedAt: new Date(),
    ...over,
  })

  it('merges sparse overrides over the active theme palette', async () => {
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue(
      row({ themeId: 'dash5', tokens: { brandPrimary: '#123456' } }),
    )
    const brand = await BrandService.getBrand()
    expect(brand.themeId).toBe('dash5')
    expect(brand.tokens.brandPrimary).toBe('#123456')
    // untouched key comes from the dash5 palette, not DEFAULT_BRAND
    expect(brand.tokens.surfaceRaised).toBe('#06262d')
  })

  it('falls back to arada for an unknown stored themeId', async () => {
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue(row({ themeId: 'nope' }))
    const brand = await BrandService.getBrand()
    expect(brand.themeId).toBe('arada')
    expect(brand.tokens.brandPrimary).toBe(DEFAULT_BRAND.tokens.brandPrimary)
  })

  it('clears colour overrides when the theme changes', async () => {
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue(
      row({ tokens: { brandPrimary: '#111111', surfaceBase: '#222222' } }),
    )
    ;(prisma.brandSetting.upsert as any).mockResolvedValue({})
    await BrandService.updateBrand({ themeId: 'dash5' })
    const arg = (prisma.brandSetting.upsert as any).mock.calls[0][0]
    expect(arg.update.themeId).toBe('dash5')
    expect(arg.update.tokens).toEqual({})
  })

  it('keeps overrides when themeId is unchanged', async () => {
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue(
      row({ themeId: 'dash5', tokens: { brandPrimary: '#111111' } }),
    )
    ;(prisma.brandSetting.upsert as any).mockResolvedValue({})
    await BrandService.updateBrand({ themeId: 'dash5', displayName: 'Y' })
    const arg = (prisma.brandSetting.upsert as any).mock.calls[0][0]
    expect(arg.update.tokens).toEqual({ brandPrimary: '#111111' })
  })

  it('keeps overrides when the caller sends tokens alongside a theme change', async () => {
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue(row())
    ;(prisma.brandSetting.upsert as any).mockResolvedValue({})
    await BrandService.updateBrand({ themeId: 'dash5', tokens: { brandPrimary: '#abcdef' } })
    const arg = (prisma.brandSetting.upsert as any).mock.calls[0][0]
    expect(arg.update.tokens).toEqual({ brandPrimary: '#abcdef' })
  })

  it('leaves the theme alone on an unrelated partial save', async () => {
    ;(prisma.brandSetting.findUnique as any).mockResolvedValue(
      row({ themeId: 'dash5', tokens: { brandPrimary: '#111111' } }),
    )
    ;(prisma.brandSetting.upsert as any).mockResolvedValue({})
    await BrandService.updateBrand({ displayName: 'Y' })
    const arg = (prisma.brandSetting.upsert as any).mock.calls[0][0]
    expect(arg.update.themeId).toBe('dash5')
    expect(arg.update.tokens).toEqual({ brandPrimary: '#111111' })
  })
})
