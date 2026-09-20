import { describe, it, expect, afterEach } from 'vitest'
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

describe('PromotionsService.getPromotions — promotions tile list', () => {
  // promo_artworks keys off (kind, refId) with no FK, so nothing cascades when
  // the promotion it points at is deleted and test/setup.ts does not know about
  // the table. Left behind, a stale row would attach art to an unrelated
  // promotion in a later suite.
  afterEach(async () => {
    await prisma.promoArtwork.deleteMany()
  })

  const activeWindow = { startsAt: '2026-01-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z' }

  async function createDailyRule(name: string, overrides: { segmentId?: string } = {}) {
    return BonusRuleService.create({
      name,
      type: 'DAILY_DEPOSIT',
      threshold: 500,
      rewardType: 'FIXED',
      rewardValue: 50,
      validityHours: 24,
      ...activeWindow,
      ...overrides,
    })
  }

  async function createWhaleSegment() {
    const whale = await prisma.user.create({
      data: {
        username: 'tile_whale',
        phone: '+251900003101',
        passwordHash: 'hashed:pass',
        role: 'PLAYER',
        wallet: { create: {} },
      },
    })
    await prisma.playerMetrics.create({
      data: { userId: whale.id, lifetimeDeposits: 5000, registeredAt: new Date() },
    })
    return prisma.segment.create({
      data: {
        name: 'Tile whales',
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
  }

  it('builds one tile per live offer, with presentation-ready figures', async () => {
    await prisma.siteSetting.create({ data: { key: 'first_deposit_bonus_amount', value: '50' } })
    await prisma.siteSetting.create({ data: { key: 'feature_referrals', value: 'true' } })
    await prisma.cashbackPromotion.create({
      data: {
        name: 'Weekend Special',
        lossThreshold: 500,
        refundType: 'PERCENTAGE',
        refundValue: 10,
        frequency: 'WEEKLY',
        isActive: true,
        startsAt: new Date(activeWindow.startsAt),
        endsAt: new Date(activeWindow.endsAt),
      },
    })
    await createDailyRule('Daily Bonus')

    const { promotions } = await PromotionsService.getPromotions()

    expect(promotions.map((p) => p.kind)).toEqual(['WELCOME', 'CASHBACK', 'DEPOSIT_RULE', 'REFERRAL'])
    expect(promotions[0]).toMatchObject({ refId: 'welcome', figure: '50', unit: 'ETB', accent: 'amber' })
    expect(promotions[1]).toMatchObject({ name: 'Weekend Special', figure: '10', unit: '% BACK', accent: 'cyan' })
    expect(promotions[2]).toMatchObject({ name: 'Daily Bonus', figure: '50', unit: 'ETB', accent: 'amber' })
    expect(promotions[3]).toMatchObject({ refId: 'referral', figure: '50', unit: 'ETB', accent: 'emerald' })
    expect(promotions.map((p) => p.position)).toEqual([0, 1, 2, 3])
  })

  it('omits the welcome tile when the bonus amount is 0 and the referral tile when the flag is off', async () => {
    await prisma.siteSetting.create({ data: { key: 'first_deposit_bonus_amount', value: '0' } })
    await prisma.siteSetting.create({ data: { key: 'feature_referrals', value: 'false' } })
    await createDailyRule('Daily Bonus')

    const { promotions } = await PromotionsService.getPromotions()

    expect(promotions.map((p) => p.kind)).toEqual(['DEPOSIT_RULE'])
  })

  it('never advertises a segment-scoped rule, even when it is the newest one', async () => {
    // GET /promotions is unauthenticated, so a targeted rule has no viewer to
    // check eligibility against; it must be absent, not merely ranked lower.
    await createDailyRule('Global daily')
    const segment = await createWhaleSegment()
    await createDailyRule('Whale daily', { segmentId: segment.id })

    const { promotions } = await PromotionsService.getPromotions()

    expect(promotions.map((p) => p.name)).toEqual(['Global daily'])
  })

  it('attaches artwork where an image exists and leaves it null where none does', async () => {
    await prisma.siteSetting.create({ data: { key: 'first_deposit_bonus_amount', value: '50' } })
    await createDailyRule('Daily Bonus')
    await prisma.promoArtwork.create({
      data: {
        kind: 'WELCOME',
        refId: 'welcome',
        imageUrl: '/uploads/promo/welcome.webp',
        altText: 'Welcome offer banner',
      },
    })

    const { promotions } = await PromotionsService.getPromotions()

    const welcome = promotions.find((p) => p.kind === 'WELCOME')
    const rule = promotions.find((p) => p.kind === 'DEPOSIT_RULE')
    expect(welcome?.artwork).toEqual({ imageUrl: '/uploads/promo/welcome.webp', altText: 'Welcome offer banner' })
    expect(rule?.artwork).toBeNull()
  })

  it('orders by artwork position ascending, with unpositioned tiles behind in natural order', async () => {
    await prisma.siteSetting.create({ data: { key: 'first_deposit_bonus_amount', value: '50' } })
    const cashback = await prisma.cashbackPromotion.create({
      data: {
        name: 'Weekend Special',
        lossThreshold: 500,
        refundType: 'PERCENTAGE',
        refundValue: 10,
        frequency: 'WEEKLY',
        isActive: true,
        startsAt: new Date(activeWindow.startsAt),
        endsAt: new Date(activeWindow.endsAt),
      },
    })
    const rule = await createDailyRule('Daily Bonus')

    // Natural order is welcome, cashback, rule. Pinning the rule to slot 0 and
    // the cashback to slot 1 must move both ahead of the unpositioned welcome.
    await prisma.promoArtwork.createMany({
      data: [
        { kind: 'DEPOSIT_RULE', refId: rule.id, imageUrl: '/uploads/promo/daily.webp', position: 0 },
        { kind: 'CASHBACK', refId: cashback.id, imageUrl: '/uploads/promo/cashback.webp', position: 1 },
      ],
    })

    const { promotions } = await PromotionsService.getPromotions()

    expect(promotions.map((p) => p.name)).toEqual(['Daily Bonus', 'Weekend Special', 'Welcome Offer'])
    expect(promotions.map((p) => p.position)).toEqual([0, 1, 2])
  })

  it('leaves the four legacy fields byte-compatible once tiles are added', async () => {
    // DepositModal.vue reads dailyDepositBonus/weeklyDepositBonus off this
    // payload; adding `promotions` must not have disturbed any of it.
    await prisma.siteSetting.create({ data: { key: 'first_deposit_bonus_amount', value: '50' } })
    await prisma.cashbackPromotion.create({
      data: {
        name: 'Weekend Special',
        lossThreshold: 500,
        refundType: 'PERCENTAGE',
        refundValue: 10,
        frequency: 'WEEKLY',
        isActive: true,
        startsAt: new Date(activeWindow.startsAt),
        endsAt: new Date(activeWindow.endsAt),
      },
    })
    await createDailyRule('Daily Bonus')
    await BonusRuleService.create({
      name: 'Weekly 2000',
      type: 'WEEKLY_DEPOSIT',
      threshold: 2000,
      rewardType: 'PERCENTAGE',
      rewardValue: 10,
      maxReward: 300,
      validityHours: 168,
      ...activeWindow,
    })

    const result = await PromotionsService.getPromotions()

    expect(result.cashback).toEqual({
      name: 'Weekend Special',
      refundType: 'PERCENTAGE',
      refundValue: 10,
      frequency: 'WEEKLY',
    })
    expect(result.firstDepositBonus).toBe(50)
    expect(result.dailyDepositBonus).toEqual({
      name: 'Daily Bonus',
      type: 'DAILY_DEPOSIT',
      threshold: 500,
      rewardType: 'FIXED',
      rewardValue: 50,
      maxReward: null,
      validityHours: 24,
    })
    expect(result.weeklyDepositBonus).toEqual({
      name: 'Weekly 2000',
      type: 'WEEKLY_DEPOSIT',
      threshold: 2000,
      rewardType: 'PERCENTAGE',
      rewardValue: 10,
      maxReward: 300,
      validityHours: 168,
    })
  })

  it('keeps a segment-scoped rule out of the legacy fields too', async () => {
    await createDailyRule('Global daily')
    const segment = await createWhaleSegment()
    await createDailyRule('Whale daily', { segmentId: segment.id })

    const result = await PromotionsService.getPromotions()

    expect(result.dailyDepositBonus).toMatchObject({ name: 'Global daily', rewardValue: 50 })
  })
})
