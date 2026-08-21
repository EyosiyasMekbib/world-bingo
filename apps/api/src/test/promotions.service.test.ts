import { describe, it, expect } from 'vitest'
import { PromotionsService } from '../services/promotions.service'
import { BonusRuleService } from '../services/bonus-rule.service'
import { prisma } from './setup'
import { SEGMENT_RULESET_VERSION } from '@world-bingo/shared-types'

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

  it('includes the most recently created active daily and weekly rules', async () => {
    await BonusRuleService.create({
      name: 'Daily 500',
      type: 'DAILY_DEPOSIT',
      threshold: 500,
      rewardType: 'FIXED',
      rewardValue: 50,
      validityHours: 24,
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2027-01-01T00:00:00Z',
    })
    await BonusRuleService.create({
      name: 'Weekly 2000',
      type: 'WEEKLY_DEPOSIT',
      threshold: 2000,
      rewardType: 'PERCENTAGE',
      rewardValue: 10,
      maxReward: 300,
      validityHours: 168,
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2027-01-01T00:00:00Z',
    })

    const promos = await PromotionsService.getPromotions()

    expect(promos.dailyDepositBonus).toMatchObject({ name: 'Daily 500', threshold: 500, rewardValue: 50 })
    expect(promos.weeklyDepositBonus).toMatchObject({ name: 'Weekly 2000', threshold: 2000, maxReward: 300 })
  })

  it('returns null deposit-bonus fields when none are active', async () => {
    const promos = await PromotionsService.getPromotions()
    expect(promos.dailyDepositBonus).toBeNull()
    expect(promos.weeklyDepositBonus).toBeNull()
  })

  it('never surfaces a segment-scoped rule, and falls back to the older global rule beneath it', async () => {
    // Regression test: GET /promotions is unauthenticated, so a targeted rule
    // can never be matched against "is this viewer eligible" -- it must be
    // excluded from the public payload entirely, not just deprioritized. Before
    // the fix, BonusRuleService.listActive's createdAt-desc ordering meant the
    // newer targeted rule below would displace this older global one.
    await BonusRuleService.create({
      name: 'Global daily',
      type: 'DAILY_DEPOSIT',
      threshold: 500,
      rewardType: 'FIXED',
      rewardValue: 50,
      validityHours: 24,
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2027-01-01T00:00:00Z',
    })

    const whale = await prisma.user.create({
      data: {
        username: 'promo_whale',
        phone: '+251900003001',
        passwordHash: 'hashed:pass',
        role: 'PLAYER',
        wallet: { create: {} },
      },
    })
    await prisma.playerMetrics.create({
      data: { userId: whale.id, lifetimeDeposits: 5000, registeredAt: new Date() },
    })
    const segment = await prisma.segment.create({
      data: {
        name: 'Whales',
        rules: {
          version: SEGMENT_RULESET_VERSION,
          root: {
            kind: 'group',
            op: 'AND',
            children: [{ kind: 'cond', field: 'lifetimeDeposits', op: 'gte', value: 1000 }],
          },
        },
      },
    })
    await BonusRuleService.create({
      name: 'Whale daily',
      type: 'DAILY_DEPOSIT',
      threshold: 500,
      rewardType: 'FIXED',
      rewardValue: 999,
      validityHours: 24,
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2027-01-01T00:00:00Z',
      segmentId: segment.id,
    })

    const promos = await PromotionsService.getPromotions()
    expect(promos.dailyDepositBonus).toMatchObject({ name: 'Global daily', rewardValue: 50 })
  })
})
