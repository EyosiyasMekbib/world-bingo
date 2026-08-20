import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { BonusService } from './bonus.service'
import { dayBucketStart, weekBucketStart } from '../lib/bonus-period'

export interface EvaluateDepositBonusResult {
    daily?: { ruleId: string; amount: Decimal }
    weekly?: { ruleId: string; amount: Decimal }
}

function computeReward(rule: { rewardType: string; rewardValue: Decimal | number; maxReward: Decimal | number | null }, bucketTotal: Decimal): Decimal {
    if (rule.rewardType === 'FIXED') return new Decimal(rule.rewardValue)
    let reward = bucketTotal.times(rule.rewardValue).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_DOWN)
    if (rule.maxReward != null) reward = Decimal.min(reward, new Decimal(rule.maxReward))
    return reward
}

export class DepositBonusService {
    /**
     * Evaluated at deposit-approval time, inside the same transaction that
     * credits realBalance. Every active DAILY_DEPOSIT/WEEKLY_DEPOSIT rule is
     * checked independently, so one deposit can trigger both. Idempotent per
     * (rule, user, bucket) via BonusService.grant's unique constraint.
     */
    static async evaluateAndGrant(
        tx: Prisma.TransactionClient,
        userId: string,
        depositAt: Date,
    ): Promise<EvaluateDepositBonusResult> {
        const rules = await tx.bonusRule.findMany({
            where: { isActive: true, startsAt: { lte: depositAt }, endsAt: { gte: depositAt } },
        })
        const result: EvaluateDepositBonusResult = {}

        for (const rule of rules) {
            const periodStart = rule.type === 'DAILY_DEPOSIT' ? dayBucketStart(depositAt) : weekBucketStart(depositAt)
            const bucketMs = rule.type === 'DAILY_DEPOSIT' ? 86_400_000 : 7 * 86_400_000
            const bucketEnd = new Date(periodStart.getTime() + bucketMs)

            const sum = await tx.transaction.aggregate({
                where: { userId, type: 'DEPOSIT', status: 'APPROVED', createdAt: { gte: periodStart, lt: bucketEnd } },
                _sum: { amount: true },
            })
            const bucketTotal = new Decimal(sum._sum.amount ?? 0)
            if (bucketTotal.lessThan(rule.threshold)) continue

            const reward = computeReward(rule, bucketTotal)
            if (reward.lte(0)) continue

            const expiresAt = new Date(depositAt.getTime() + rule.validityHours * 3_600_000)
            const grantResult = await BonusService.grant(tx, {
                userId,
                amount: reward,
                source: rule.type === 'DAILY_DEPOSIT' ? 'DAILY_DEPOSIT' : 'WEEKLY_DEPOSIT',
                ruleId: rule.id,
                periodStart,
                expiresAt,
            })
            if (!grantResult.granted) continue

            if (rule.type === 'DAILY_DEPOSIT') result.daily = { ruleId: rule.id, amount: reward }
            else result.weekly = { ruleId: rule.id, amount: reward }
        }

        return result
    }
}
