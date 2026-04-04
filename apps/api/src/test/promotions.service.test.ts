import { describe, it, expect } from 'vitest'
import { PromotionsService } from '../services/promotions.service'
import { prisma } from './setup'

describe('PromotionsService.getPromotions', () => {
  it('returns null for both when nothing is configured', async () => {
    const result = await PromotionsService.getPromotions()
    expect(result.cashback).toBeNull()
    expect(result.firstDepositBonus).toBeNull()
  })

  it('returns cashback promo when one is active within date range', async () => {
    await prisma.cashbackPromotion.create({
      data: {
        name: 'Weekly Cashback',
        lossThreshold: 100,
        refundType: 'PERCENTAGE',
        refundValue: 10,
        frequency: 'WEEKLY',
        isActive: true,
        startsAt: new Date(Date.now() - 1000),
        endsAt: new Date(Date.now() + 86400000),
      },
    })

    const result = await PromotionsService.getPromotions()
    expect(result.cashback).toEqual({
      name: 'Weekly Cashback',
      refundType: 'PERCENTAGE',
      refundValue: 10,
      frequency: 'WEEKLY',
    })
  })

  it('returns null for cashback when promotion isActive is false', async () => {
    await prisma.cashbackPromotion.create({
      data: {
        name: 'Inactive Promo',
        lossThreshold: 100,
        refundType: 'PERCENTAGE',
        refundValue: 10,
        frequency: 'WEEKLY',
        isActive: false,
        startsAt: new Date(Date.now() - 1000),
        endsAt: new Date(Date.now() + 86400000),
      },
    })

    const result = await PromotionsService.getPromotions()
    expect(result.cashback).toBeNull()
  })

  it('returns null for cashback when promotion has expired', async () => {
    await prisma.cashbackPromotion.create({
      data: {
        name: 'Expired Promo',
        lossThreshold: 100,
        refundType: 'PERCENTAGE',
        refundValue: 10,
        frequency: 'WEEKLY',
        isActive: true,
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() - 1000),
      },
    })

    const result = await PromotionsService.getPromotions()
    expect(result.cashback).toBeNull()
  })

  it('returns firstDepositBonus as a number when site setting is configured with a positive value', async () => {
    await prisma.siteSetting.create({
      data: { key: 'first_deposit_bonus_amount', value: '50' },
    })

    const result = await PromotionsService.getPromotions()
    expect(result.firstDepositBonus).toBe(50)
  })

  it('returns null for firstDepositBonus when setting value is 0', async () => {
    await prisma.siteSetting.create({
      data: { key: 'first_deposit_bonus_amount', value: '0' },
    })

    const result = await PromotionsService.getPromotions()
    expect(result.firstDepositBonus).toBeNull()
  })

  it('returns both cashback and firstDepositBonus when both are configured', async () => {
    await prisma.cashbackPromotion.create({
      data: {
        name: 'Monthly Fixed',
        lossThreshold: 200,
        refundType: 'FIXED',
        refundValue: 30,
        frequency: 'MONTHLY',
        isActive: true,
        startsAt: new Date(Date.now() - 1000),
        endsAt: new Date(Date.now() + 86400000),
      },
    })
    await prisma.siteSetting.create({
      data: { key: 'first_deposit_bonus_amount', value: '100' },
    })

    const result = await PromotionsService.getPromotions()
    expect(result.cashback?.refundType).toBe('FIXED')
    expect(result.cashback?.refundValue).toBe(30)
    expect(result.firstDepositBonus).toBe(100)
  })
})
