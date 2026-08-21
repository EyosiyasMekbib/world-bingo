import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { BonusService } from './bonus.service'
import { dayBucketStart, weekBucketStart } from '../lib/bonus-period'

export interface EvaluateDepositBonusResult {
    daily: Array<{ ruleId: string; amount: Decimal }>
    weekly: Array<{ ruleId: string; amount: Decimal }>
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
     * checked independently, so one deposit can trigger both — and, since
     * BonusRule has no uniqueness constraint on `type`, more than one rule of
     * the same type can independently grant too (hence `daily`/`weekly` are
     * arrays, not single optional slots). Idempotent per (rule, user, bucket)
     * via BonusService.grant's unique constraint.
     *
     * Two distinct timestamps matter here, and they are NOT the same instant
     * when a deposit sits in manual review for a while:
     *   - `depositCreatedAt` (the deposit transaction's own `createdAt`) drives
     *     which day/week bucket this deposit belongs to, and thus the SUM
     *     query's date range — a deposit must always be evaluated against the
     *     bucket it actually happened in, regardless of how long it waited for
     *     approval.
     *   - `grantedAt` (the approval instant) drives which BonusRules are
     *     currently active, and anchors `expiresAt` — the bonus's usable
     *     window starts when it's actually granted, not when the deposit was
     *     originally submitted.
     */
    static async evaluateAndGrant(
        tx: Prisma.TransactionClient,
        userId: string,
        depositCreatedAt: Date,
        grantedAt: Date,
    ): Promise<EvaluateDepositBonusResult> {
        const rules = await tx.bonusRule.findMany({
            where: { isActive: true, startsAt: { lte: grantedAt }, endsAt: { gte: grantedAt } },
        })

        // Membership is gated on isSegmentScoped, NOT on segmentId: segmentId is a
        // nullable FK that a segment deletion sets to null, which would silently
        // turn a targeted rule into one that pays every player. One batched query
        // covers every scoped rule rather than one lookup per rule.
        const scoped = rules.filter((r) => r.isSegmentScoped)
        const memberOf = scoped.length
            ? new Set(
                  (
                      await tx.bonusRuleMember.findMany({
                          where: { userId, ruleId: { in: scoped.map((r) => r.id) } },
                          select: { ruleId: true },
                      })
                  ).map((m) => m.ruleId),
              )
            : new Set<string>()

        const result: EvaluateDepositBonusResult = { daily: [], weekly: [] }

        for (const rule of rules) {
            if (rule.isSegmentScoped && !memberOf.has(rule.id)) continue

            const periodStart = rule.type === 'DAILY_DEPOSIT' ? dayBucketStart(depositCreatedAt) : weekBucketStart(depositCreatedAt)
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

            const expiresAt = new Date(grantedAt.getTime() + rule.validityHours * 3_600_000)
            const grantResult = await BonusService.grant(tx, {
                userId,
                amount: reward,
                source: rule.type === 'DAILY_DEPOSIT' ? 'DAILY_DEPOSIT' : 'WEEKLY_DEPOSIT',
                ruleId: rule.id,
                periodStart,
                expiresAt,
            })
            if (!grantResult.granted) continue

            if (rule.type === 'DAILY_DEPOSIT') result.daily.push({ ruleId: rule.id, amount: reward })
            else result.weekly.push({ ruleId: rule.id, amount: reward })
        }

        return result
    }
}
