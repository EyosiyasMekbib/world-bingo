import prisma from '../lib/prisma'
import { CashbackRefundType, CashbackFrequency, BonusRuleType, BonusRewardType } from '@world-bingo/shared-types'
import { BonusRuleService } from './bonus-rule.service'

export interface CashbackPromoResult {
  name: string
  refundType: CashbackRefundType
  refundValue: number
  frequency: CashbackFrequency
}

export interface DepositBonusPromoResult {
  name: string
  type: BonusRuleType
  threshold: number
  rewardType: BonusRewardType
  rewardValue: number
  maxReward: number | null
  validityHours: number
}

export interface PromotionsResult {
  cashback: CashbackPromoResult | null
  firstDepositBonus: number | null
  dailyDepositBonus: DepositBonusPromoResult | null
  weeklyDepositBonus: DepositBonusPromoResult | null
}

export class PromotionsService {
  /**
   * Returns the first currently-active cashback promotion and the configured
   * first-deposit bonus amount. Returns null for either field when not set up.
   * firstDepositBonus is null when the setting is missing OR set to 0.
   */
  static async getPromotions(): Promise<PromotionsResult> {
    const now = new Date()

    const [cashbackRow, bonusSetting, activeRules] = await Promise.all([
      prisma.cashbackPromotion.findFirst({
        where: {
          isActive: true,
          startsAt: { lte: now },
          endsAt: { gte: now },
        },
        select: {
          name: true,
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
    ])

    const raw = bonusSetting ? Number(bonusSetting.value) : 0
    const firstDepositBonus = isNaN(raw) ? 0 : raw

    const toPromo = (rule: (typeof activeRules)[number]): DepositBonusPromoResult => ({
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
    const dailyRule = activeRules.find((r) => r.type === 'DAILY_DEPOSIT' && !r.isSegmentScoped)
    const weeklyRule = activeRules.find((r) => r.type === 'WEEKLY_DEPOSIT' && !r.isSegmentScoped)

    return {
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
}
