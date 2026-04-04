import prisma from '../lib/prisma'
import { CashbackRefundType, CashbackFrequency } from '@world-bingo/shared-types'

export interface CashbackPromoResult {
  name: string
  refundType: CashbackRefundType
  refundValue: number
  frequency: CashbackFrequency
}

export interface PromotionsResult {
  cashback: CashbackPromoResult | null
  firstDepositBonus: number | null
}

export class PromotionsService {
  /**
   * Returns the first currently-active cashback promotion and the configured
   * first-deposit bonus amount. Returns null for either field when not set up.
   * firstDepositBonus is null when the setting is missing OR set to 0.
   */
  static async getPromotions(): Promise<PromotionsResult> {
    const now = new Date()

    const [cashbackRow, bonusSetting] = await Promise.all([
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
    ])

    const raw = bonusSetting ? Number(bonusSetting.value) : 0
    const firstDepositBonus = isNaN(raw) ? 0 : raw

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
    }
  }
}
