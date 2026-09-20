import { describe, it, expect, afterEach, vi } from 'vitest'
import { PromotionsService } from '../services/promotions.service'
import { BonusRuleService } from '../services/bonus-rule.service'
import { CashbackService, getCurrentPeriod } from '../services/cashback.service'
import { prisma } from './setup'
import { CashbackFrequency, SEGMENT_RULESET_VERSION } from '@world-bingo/shared-types'

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

  it('bounds an advertised percentage cashback by maxPayoutPerPlayer', async () => {
    // CashbackService.payoutFor clamps every payout against the cap, so a tile
    // quoting the bare rate advertises a refund the disburser will not pay: 10%
    // of a 5,000 ETB loss reads as 500 ETB back when 50 is all that can land.
    await prisma.cashbackPromotion.create({
      data: {
        name: 'Capped Percent',
        lossThreshold: 500,
        refundType: 'PERCENTAGE',
        refundValue: 10,
        maxPayoutPerPlayer: 50,
        frequency: 'WEEKLY',
        isActive: true,
        startsAt: new Date(activeWindow.startsAt),
        endsAt: new Date(activeWindow.endsAt),
      },
    })

    const [tile] = (await PromotionsService.getPromotions()).promotions

    expect(tile.figure).toBe('10')
    expect(tile.sub).toBe('Lose 500 ETB in a week and get 10% back, up to 50 ETB')
  })

  it('advertises a FIXED cashback refund at its capped value, not its face value', async () => {
    // payoutFor clamps a flat refund too, so above the cap the cap IS the offer.
    await prisma.cashbackPromotion.create({
      data: {
        name: 'Capped Fixed',
        lossThreshold: 500,
        refundType: 'FIXED',
        refundValue: 80,
        maxPayoutPerPlayer: 50,
        frequency: 'WEEKLY',
        isActive: true,
        startsAt: new Date(activeWindow.startsAt),
        endsAt: new Date(activeWindow.endsAt),
      },
    })

    const [tile] = (await PromotionsService.getPromotions()).promotions

    expect(tile.figure).toBe('50')
    expect(tile.sub).toBe('Lose 500 ETB in a week and get 50 ETB back')
  })

  it('leaves an uncapped cashback tile without a ceiling', async () => {
    await prisma.cashbackPromotion.create({
      data: {
        name: 'Uncapped',
        lossThreshold: 500,
        refundType: 'PERCENTAGE',
        refundValue: 10,
        frequency: 'WEEKLY',
        isActive: true,
        startsAt: new Date(activeWindow.startsAt),
        endsAt: new Date(activeWindow.endsAt),
      },
    })

    const [tile] = (await PromotionsService.getPromotions()).promotions

    expect(tile.sub).toBe('Lose 500 ETB in a week and get 10% back')
  })

  it("bounds a PERCENTAGE deposit rule's copy by maxReward", async () => {
    // DepositBonusService.computeReward clamps a percentage reward against
    // maxReward, so 10% of a 10,000 ETB week is 300 ETB, not 1,000.
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

    const [tile] = (await PromotionsService.getPromotions()).promotions

    expect(tile.sub).toBe('Deposit 2000 ETB in a week for 10% in bonus, up to 300 ETB')
  })

  it('leaves a FIXED deposit rule uncapped in copy, because computeReward never clamps one', async () => {
    await createDailyRule('Daily Bonus')

    const [tile] = (await PromotionsService.getPromotions()).promotions

    expect(tile.sub).toBe('Deposit 500 ETB in a day, play with 550')
  })

  it('keeps a segment-scoped rule out of the legacy fields too', async () => {
    await createDailyRule('Global daily')
    const segment = await createWhaleSegment()
    await createDailyRule('Whale daily', { segmentId: segment.id })

    const result = await PromotionsService.getPromotions()

    expect(result.dailyDepositBonus).toMatchObject({ name: 'Global daily', rewardValue: 50 })
  })
})

describe('PromotionsService.getProgressFor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Live across every window these tests look at, so only overrides matter. */
  const liveWindow = {
    startsAt: new Date('2020-01-01T00:00:00Z'),
    endsAt: new Date('2030-01-01T00:00:00Z'),
  }

  type CashbackOverrides = {
    name?: string
    frequency?: 'DAILY' | 'WEEKLY' | 'MONTHLY'
    payoutTiming?: 'PERIOD_CLOSE' | 'ON_THRESHOLD'
    refundType?: 'PERCENTAGE' | 'FIXED'
    refundValue?: number
    lossThreshold?: number
    maxPayoutPerPlayer?: number
    startsAt?: Date
    endsAt?: Date
  }

  async function makePlayer(username: string, phone: string) {
    return prisma.user.create({
      data: { username, phone, passwordHash: 'hashed:pass', role: 'PLAYER', wallet: { create: {} } },
    })
  }

  async function makeCashback(overrides: CashbackOverrides = {}) {
    return prisma.cashbackPromotion.create({
      data: {
        name: 'Cashback',
        lossThreshold: 100,
        refundType: 'PERCENTAGE',
        refundValue: 10,
        frequency: 'DAILY',
        payoutTiming: 'PERIOD_CLOSE',
        isActive: true,
        ...liveWindow,
        ...overrides,
      },
    })
  }

  /** A pure real-balance loss, timestamped now unless placed elsewhere in the window. */
  async function loseReal(userId: string, amount: number, createdAt?: Date) {
    await prisma.transaction.create({
      data: { userId, type: 'GAME_ENTRY', amount, status: 'APPROVED', ...(createdAt ? { createdAt } : {}) },
    })
  }

  it('binds the net-loss query to the one player asking, not the whole player base', async () => {
    // getNetLossByUser without a user predicate groups every player's
    // transactions for the period, so an authenticated /promotions/me used to
    // scan and materialise the entire player base once per promotion.
    const promo = await makeCashback({ lossThreshold: 100 })
    const player = await makePlayer('progress_one', '+251900004001')
    const whale = await makePlayer('progress_two', '+251900004002')
    await loseReal(player.id, 60)
    await loseReal(whale.id, 5000)

    const spy = vi.spyOn(CashbackService, 'getNetLossByUser')
    const progress = await PromotionsService.getProgressFor(player.id)

    expect(spy).toHaveBeenCalledTimes(1)
    const args = spy.mock.calls[0] as unknown[]
    expect(args[3]).toBe(player.id)

    // Passing the argument is not the same as binding it: keyed by userId, the
    // figure below reads 60 whether or not the SQL narrowed anything. What the
    // whale proves is that the query itself came back with one row, so nothing
    // wider than this player was ever materialised.
    const returned = (await spy.mock.results[0].value) as Map<string, unknown>
    expect([...returned.keys()]).toEqual([player.id])

    expect(progress[0]).toMatchObject({ refId: promo.id, current: 60, target: 100 })
  })

  it('counts only the play the disburser will pay for, not the whole period', async () => {
    // The bar is a promise about money. Measured over the raw period it counts
    // losses from before the promotion existed, then the disburser — which
    // clamps to the promotion's own life — pays less than the bar advertised.
    const player = await makePlayer('progress_clamped', '+251900004008')
    const startsAt = new Date()
    await makeCashback({ frequency: 'MONTHLY', lossThreshold: 100, startsAt })
    await loseReal(player.id, 400, new Date(startsAt.getTime() - 60 * 60 * 1000))
    await loseReal(player.id, 40)

    const [progress] = await PromotionsService.getProgressFor(player.id)

    expect(progress.current).toBe(40)
  })

  it('promises the close of a window the disburser will actually settle', async () => {
    const player = await makePlayer('progress_daily', '+251900004003')
    await makeCashback({ frequency: 'DAILY', lossThreshold: 100 })
    await loseReal(player.id, 40)

    const [progress] = await PromotionsService.getProgressFor(player.id)

    expect(progress.hint).toBe('60 ETB to go · pays out today 23:59')
  })

  it('does not promise a payout for a window the promotion was not live at the start of', async () => {
    // runChecks skips any PERIOD_CLOSE window with `startsAt > periodStart`, so
    // a promotion created mid-window pays nothing for that window however much
    // the player loses in it — the promise belongs to the next window.
    const player = await makePlayer('progress_midwindow', '+251900004004')
    await makeCashback({ frequency: 'MONTHLY', lossThreshold: 100, startsAt: new Date() })
    await loseReal(player.id, 250)

    const [progress] = await PromotionsService.getProgressFor(player.id)

    // Entirely after startsAt, so the clamp above leaves all 250 standing —
    // this test is about the hint, not the window.
    expect(progress.current).toBe(250)
    expect(progress.hint).toContain('Counts from next month')
    expect(progress.hint).toContain('pays out')
    expect(progress.hint).not.toContain('Qualified')
  })

  it('promises nothing at all when the promotion ends before its next settleable window', async () => {
    const player = await makePlayer('progress_nowindow', '+251900004005')
    const { periodEnd } = getCurrentPeriod(CashbackFrequency.MONTHLY)
    await makeCashback({
      frequency: 'MONTHLY',
      lossThreshold: 100,
      startsAt: new Date(),
      endsAt: periodEnd,
    })
    await loseReal(player.id, 250)

    const [progress] = await PromotionsService.getProgressFor(player.id)

    expect(progress.hint).toBe('No payout due this month')
  })

  it('names the hourly run, not the period close, for an ON_THRESHOLD promotion', async () => {
    // ON_THRESHOLD pays inside the live window at the next hourly run, so the
    // period-close wording put the money hours further away than it was.
    const player = await makePlayer('progress_threshold', '+251900004006')
    await makeCashback({ frequency: 'WEEKLY', lossThreshold: 100, payoutTiming: 'ON_THRESHOLD' })
    await loseReal(player.id, 150)

    const [qualified] = await PromotionsService.getProgressFor(player.id)
    expect(qualified.hint).toBe('Qualified · pays out within the hour')

    const other = await makePlayer('progress_threshold_2', '+251900004007')
    await loseReal(other.id, 25)
    const [pending] = await PromotionsService.getProgressFor(other.id)
    expect(pending.hint).toBe('75 ETB to go · pays out within the hour')
  })

  it('reads an existing disbursement as paid, with its amount', async () => {
    const player = await makePlayer('progress_paid', '+251900004008')
    const paidPromo = await makeCashback({ name: 'Paid', payoutTiming: 'ON_THRESHOLD' })
    const openPromo = await makeCashback({ name: 'Open', payoutTiming: 'ON_THRESHOLD' })
    await loseReal(player.id, 150)

    const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
    await prisma.cashbackDisbursement.create({
      data: { promotionId: paidPromo.id, userId: player.id, amount: 12.5, periodStart, periodEnd },
    })

    const progress = await PromotionsService.getProgressFor(player.id)

    // One batched read keyed on (promotionId, userId, periodStart): the paid row
    // must land on its own promotion and nowhere else.
    expect(progress.find((p) => p.refId === paidPromo.id)?.hint).toBe('Paid out · 12.5 ETB')
    expect(progress.find((p) => p.refId === openPromo.id)?.hint).toBe(
      'Qualified · pays out within the hour',
    )
  })

  it('ignores a disbursement from another player or another window', async () => {
    const player = await makePlayer('progress_unpaid', '+251900004009')
    const neighbour = await makePlayer('progress_neighbour', '+251900004010')
    const promo = await makeCashback({ payoutTiming: 'ON_THRESHOLD' })
    await loseReal(player.id, 150)

    const { periodStart, periodEnd } = getCurrentPeriod(CashbackFrequency.DAILY)
    await prisma.cashbackDisbursement.create({
      data: { promotionId: promo.id, userId: neighbour.id, amount: 9, periodStart, periodEnd },
    })
    await prisma.cashbackDisbursement.create({
      data: {
        promotionId: promo.id,
        userId: player.id,
        amount: 7,
        periodStart: new Date(periodStart.getTime() - 24 * 60 * 60 * 1000),
        periodEnd: new Date(periodEnd.getTime() - 24 * 60 * 60 * 1000),
      },
    })

    const [progress] = await PromotionsService.getProgressFor(player.id)

    expect(progress.hint).toBe('Qualified · pays out within the hour')
  })
})
