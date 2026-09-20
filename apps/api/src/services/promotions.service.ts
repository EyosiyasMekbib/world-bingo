import prisma from '../lib/prisma'
import {
  CashbackRefundType,
  CashbackFrequency,
  BonusRuleType,
  BonusRewardType,
  PromoKind,
  REFERRAL_BONUS_ETB,
} from '@world-bingo/shared-types'
import type {
  CashbackPromoSummary,
  DepositBonusSummary,
  PromotionProgressDto,
  PromotionsPayload,
  PublicPromotionDto,
} from '@world-bingo/shared-types'
import { BonusRuleService } from './bonus-rule.service'
import { CashbackService, getCurrentPeriod } from './cashback.service'
import { dayBucketStart, weekBucketStart } from '../lib/bonus-period'

/** Kept as the old local names so existing importers still compile. */
export type CashbackPromoResult = CashbackPromoSummary
export type DepositBonusPromoResult = DepositBonusSummary
export type PromotionsResult = PromotionsPayload

const DAY_MS = 24 * 60 * 60 * 1000

/** A deposit rule buckets on a local day or a local Mon-Sun week, nothing else. */
const BUCKET_MS: Record<string, number> = {
  DAILY_DEPOSIT: DAY_MS,
  WEEKLY_DEPOSIT: 7 * DAY_MS,
}

const CASHBACK_PERIOD_NOUN: Record<CashbackFrequency, string> = {
  [CashbackFrequency.DAILY]: 'day',
  [CashbackFrequency.WEEKLY]: 'week',
  [CashbackFrequency.MONTHLY]: 'month',
}

const CASHBACK_PROGRESS_LABEL: Record<CashbackFrequency, string> = {
  [CashbackFrequency.DAILY]: 'Lost today',
  [CashbackFrequency.WEEKLY]: 'Lost this week',
  [CashbackFrequency.MONTHLY]: 'Lost this month',
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/**
 * The tile's figure is cut in 40px display type, where a trailing '.00' eats a
 * third of the width and says nothing. Decimals survive when they carry value,
 * so 12.50 renders as '12.5'.
 */
function figure(value: number): string {
  return String(Number(value.toFixed(2)))
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * When the open cashback period closes. Read in UTC because getCurrentPeriod
 * cuts its windows there — rendering the same instant in Addis local time would
 * name a weekday the disburser does not agree with, and the whole point of this
 * line is to promise the payout the job will actually make.
 */
function payoutLabel(frequency: CashbackFrequency, periodEnd: Date): string {
  const time = `${pad2(periodEnd.getUTCHours())}:${pad2(periodEnd.getUTCMinutes())}`
  if (frequency === CashbackFrequency.DAILY) return `today ${time}`
  if (frequency === CashbackFrequency.WEEKLY) return `${WEEKDAYS[periodEnd.getUTCDay()]} ${time}`
  return `${periodEnd.getUTCDate()} ${MONTHS[periodEnd.getUTCMonth()]} ${time}`
}

/**
 * Coarse on purpose: '3h' is what a player acts on, and a second-by-second
 * countdown is something the client can run itself off the bucket end.
 */
function untilLabel(ms: number): string {
  if (ms <= 0) return 'a moment'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** A tile before artwork and ordering resolve its final slot. */
type TileDraft = Omit<PublicPromotionDto, 'artwork' | 'position'>

export class PromotionsService {
  /**
   * The public promotions payload: one tile per live offer, plus the four legacy
   * fields DepositModal.vue already reads. The legacy shape is deliberately
   * untouched — adding tiles must not force a coordinated client change.
   */
  static async getPromotions(): Promise<PromotionsPayload> {
    const now = new Date()

    const [cashbackRows, bonusSetting, activeRules, referralSetting] = await Promise.all([
      prisma.cashbackPromotion.findMany({
        where: {
          isActive: true,
          startsAt: { lte: now },
          endsAt: { gte: now },
        },
        select: {
          id: true,
          name: true,
          lossThreshold: true,
          refundType: true,
          refundValue: true,
          frequency: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.siteSetting.findUnique({
        where: { key: 'first_deposit_bonus_amount' },
      }),
      BonusRuleService.listActive(now),
      prisma.siteSetting.findUnique({
        where: { key: 'feature_referrals' },
      }),
    ])

    const raw = bonusSetting ? Number(bonusSetting.value) : 0
    const firstDepositBonus = isNaN(raw) ? 0 : raw

    const toPromo = (rule: (typeof activeRules)[number]): DepositBonusSummary => ({
      name: rule.name,
      type: rule.type as BonusRuleType,
      threshold: Number(rule.threshold),
      rewardType: rule.rewardType as BonusRewardType,
      rewardValue: Number(rule.rewardValue),
      maxReward: rule.maxReward != null ? Number(rule.maxReward) : null,
      validityHours: rule.validityHours,
    })

    // A segment-scoped rule can only pay its frozen cohort, and this endpoint
    // is unauthenticated -- there is no player context to check eligibility
    // against. Advertising a promotion a given viewer can never receive is
    // worse than not advertising it, so targeted rules are excluded from the
    // public payload entirely (never displacing the newest *unscoped* rule).
    const publicRules = activeRules.filter((r) => !r.isSegmentScoped)
    const dailyRule = publicRules.find((r) => r.type === 'DAILY_DEPOSIT')
    const weeklyRule = publicRules.find((r) => r.type === 'WEEKLY_DEPOSIT')

    // Natural order, before `position` gets a say: the welcome offer leads,
    // then cashback and deposit rules newest-first (the same createdAt-desc
    // order the legacy fields above pick from), then the evergreen referral
    // offer, which has no date to sort by and belongs last regardless.
    const drafts: TileDraft[] = []

    if (firstDepositBonus > 0) {
      drafts.push({
        kind: PromoKind.WELCOME,
        refId: 'welcome',
        name: 'Welcome Offer',
        figure: figure(firstDepositBonus),
        unit: 'ETB',
        sub: 'On your first approved deposit',
        href: '/wallet',
        action: 'deposit',
        accent: 'amber',
      })
    }

    for (const promo of cashbackRows) {
      const frequency = promo.frequency as CashbackFrequency
      const value = Number(promo.refundValue)
      const isPercentage = promo.refundType === CashbackRefundType.PERCENTAGE
      const reward = isPercentage ? `${figure(value)}%` : `${figure(value)} ETB`
      const noun = CASHBACK_PERIOD_NOUN[frequency]
      drafts.push({
        kind: PromoKind.CASHBACK,
        refId: promo.id,
        name: promo.name,
        figure: figure(value),
        // 'BACK' rides along in the unit so a cashback tile never reads as a
        // deposit bonus of the same size sitting beside it in the row.
        unit: isPercentage ? '% BACK' : 'ETB BACK',
        sub: `Lose ${figure(Number(promo.lossThreshold))} ETB in a ${noun} and get ${reward} back`,
        href: '/promotions',
        action: null,
        accent: 'cyan',
      })
    }

    for (const rule of publicRules) {
      const threshold = Number(rule.threshold)
      const value = Number(rule.rewardValue)
      const isPercentage = rule.rewardType === BonusRewardType.PERCENTAGE
      const noun = rule.type === 'DAILY_DEPOSIT' ? 'day' : 'week'
      drafts.push({
        kind: PromoKind.DEPOSIT_RULE,
        refId: rule.id,
        name: rule.name,
        figure: figure(value),
        unit: isPercentage ? '% BONUS' : 'ETB',
        sub: isPercentage
          ? `Deposit ${figure(threshold)} ETB in a ${noun} for ${figure(value)}% in bonus`
          : `Deposit ${figure(threshold)} ETB in a ${noun}, play with ${figure(threshold + value)}`,
        href: '/wallet',
        action: 'deposit',
        accent: 'amber',
      })
    }

    if (referralSetting?.value === 'true') {
      drafts.push({
        kind: PromoKind.REFERRAL,
        refId: 'referral',
        name: 'Refer & Earn',
        figure: figure(REFERRAL_BONUS_ETB),
        unit: 'ETB',
        sub: `Earn ${figure(REFERRAL_BONUS_ETB)} ETB when a friend makes their first deposit`,
        href: '/refer',
        action: 'referral',
        accent: 'emerald',
      })
    }

    // One round-trip for the whole row. Artwork is keyed on (kind, refId)
    // rather than an FK because the welcome and referral offers are site
    // settings with no row of their own to hang an image off.
    const artworks =
      drafts.length > 0
        ? await prisma.promoArtwork.findMany({
            where: { OR: drafts.map((d) => ({ kind: d.kind, refId: d.refId })) },
            select: { kind: true, refId: true, imageUrl: true, altText: true, position: true },
          })
        : []
    const artworkByKey = new Map(artworks.map((a) => [`${a.kind}:${a.refId}`, a]))

    const promotions: PublicPromotionDto[] = drafts
      .map((draft, naturalIndex) => ({
        draft,
        naturalIndex,
        art: artworkByKey.get(`${draft.kind}:${draft.refId}`) ?? null,
      }))
      .sort((a, b) => {
        const left = a.art?.position ?? null
        const right = b.art?.position ?? null
        // An unpositioned tile falls behind every positioned one rather than
        // sorting as 0: an admin who pins one promotion to the front should not
        // silently reshuffle the ones they never touched.
        if (left === null && right === null) return a.naturalIndex - b.naturalIndex
        if (left === null) return 1
        if (right === null) return -1
        return left - right || a.naturalIndex - b.naturalIndex
      })
      .map(({ draft, art }, slot) => ({
        ...draft,
        artwork: art ? { imageUrl: art.imageUrl, altText: art.altText } : null,
        // The resolved slot, not the admin's sparse `position`: the client
        // renders the array as given and never re-derives this ordering.
        position: slot,
      }))

    const cashbackRow = cashbackRows[0]

    return {
      promotions,
      cashback: cashbackRow
        ? {
            name: cashbackRow.name,
            refundType: cashbackRow.refundType as CashbackRefundType,
            refundValue: Number(cashbackRow.refundValue),
            frequency: cashbackRow.frequency as CashbackFrequency,
          }
        : null,
      firstDepositBonus: firstDepositBonus > 0 ? firstDepositBonus : null,
      dailyDepositBonus: dailyRule ? toPromo(dailyRule) : null,
      weeklyDepositBonus: weeklyRule ? toPromo(weeklyRule) : null,
    }
  }

  /**
   * How far one player is towards each offer that can still pay them this
   * period. Every figure comes from the query that will actually decide the
   * payout, so a bar can never promise something the disburser then refuses.
   *
   * Only the two progressive offers appear: the welcome bonus is a one-shot
   * with nothing to accumulate, and a referral pays on the friend's deposit
   * rather than on anything this player can push towards.
   */
  static async getProgressFor(userId: string): Promise<PromotionProgressDto[]> {
    const now = new Date()

    const [cashbackPromos, activeRules] = await Promise.all([
      prisma.cashbackPromotion.findMany({
        where: {
          isActive: true,
          startsAt: { lte: now },
          endsAt: { gte: now },
        },
        orderBy: { createdAt: 'desc' },
      }),
      BonusRuleService.listActive(now),
    ])

    const progress: PromotionProgressDto[] = []

    for (const promo of cashbackPromos) {
      const frequency = promo.frequency as CashbackFrequency
      const { periodStart, periodEnd } = getCurrentPeriod(frequency, now)
      // The hourly disburser's own net-loss query, game scope and all. Run one
      // promotion at a time rather than in parallel: it is a per-user GROUP BY
      // over the whole period, and a lobby refresh should not fan that out.
      const netLossByUser = await CashbackService.getNetLossByUser(promo, periodStart, periodEnd)
      const current = Number(netLossByUser.get(userId) ?? 0)
      const target = Number(promo.lossThreshold)
      const remaining = target - current
      const closes = payoutLabel(frequency, periodEnd)

      progress.push({
        kind: PromoKind.CASHBACK,
        refId: promo.id,
        label: CASHBACK_PROGRESS_LABEL[frequency],
        current,
        target,
        hint: remaining > 0 ? `${figure(remaining)} ETB to go · pays out ${closes}` : `Qualified · pays out ${closes}`,
      })
    }

    // Segment-scoped rules are skipped here as well as in getPromotions: this
    // list pairs with the tiles by (kind, refId), so progress towards an offer
    // that is never advertised has no tile to attach to.
    for (const rule of activeRules) {
      if (rule.isSegmentScoped) continue

      const periodStart = rule.type === 'DAILY_DEPOSIT' ? dayBucketStart(now) : weekBucketStart(now)
      const bucketEnd = new Date(periodStart.getTime() + BUCKET_MS[rule.type])

      // Same bucket SUM DepositBonusService evaluates at approval time.
      const sum = await prisma.transaction.aggregate({
        where: { userId, type: 'DEPOSIT', status: 'APPROVED', createdAt: { gte: periodStart, lt: bucketEnd } },
        _sum: { amount: true },
      })
      const current = Number(sum._sum.amount ?? 0)
      const target = Number(rule.threshold)
      const remaining = target - current
      const resets = untilLabel(bucketEnd.getTime() - now.getTime())

      progress.push({
        kind: PromoKind.DEPOSIT_RULE,
        refId: rule.id,
        label: rule.type === 'DAILY_DEPOSIT' ? 'Deposited today' : 'Deposited this week',
        current,
        target,
        hint:
          remaining > 0
            ? `${figure(remaining)} ETB to go · resets in ${resets}`
            : `Bonus earned · resets in ${resets}`,
      })
    }

    return progress
  }
}
