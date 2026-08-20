import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

export type BonusGrantSource = 'FIRST_DEPOSIT' | 'DAILY_DEPOSIT' | 'WEEKLY_DEPOSIT' | 'CASHBACK' | 'CAMPAIGN' | 'ADMIN'

export interface GrantBonusParams {
    userId: string
    amount: Decimal | number
    source: BonusGrantSource
    ruleId?: string | null
    periodStart?: Date | null
    expiresAt?: Date | null
}

export interface GrantBonusResult {
    granted: boolean
    grantId?: string
    amount: Decimal
    bonusBalanceBefore: Decimal
    bonusBalanceAfter: Decimal
}

export class InsufficientBonusBalanceError extends Error {
    statusCode = 400

    constructor() {
        super('Insufficient bonus balance')
        this.name = 'InsufficientBonusBalanceError'
    }
}

export class BonusService {
    /**
     * Grants a bonus lot. Idempotent on (ruleId, userId, periodStart) when
     * ruleId is set — a retried deposit approval or campaign send cannot
     * double-grant. Sources with no rule (cashback, campaign, admin,
     * first-deposit) pass ruleId: null, which the DB's unique index treats as
     * always-distinct, so those grants have no idempotency floor of their own —
     * callers must ensure they only call grant() once per award.
     */
    static async grant(tx: Prisma.TransactionClient, params: GrantBonusParams): Promise<GrantBonusResult> {
        const amount = new Decimal(params.amount)
        if (!amount.isFinite() || amount.lte(0)) {
            throw new Error('Grant amount must be a positive number')
        }

        const wallets = await tx.$queryRaw<Array<{ bonusBalance: Decimal }>>`
            SELECT "bonusBalance" FROM wallets WHERE "userId" = ${params.userId}
        `
        const bonusBalanceBefore = new Decimal(wallets[0]?.bonusBalance ?? 0)

        let grantId: string
        try {
            const lot = await tx.bonusGrant.create({
                data: {
                    userId: params.userId,
                    ruleId: params.ruleId ?? null,
                    amount,
                    remaining: amount,
                    periodStart: params.periodStart ?? new Date(),
                    expiresAt: params.expiresAt ?? null,
                    status: 'ACTIVE',
                },
            })
            grantId = lot.id
        } catch (err: any) {
            if (err?.code === 'P2002') {
                return { granted: false, amount, bonusBalanceBefore, bonusBalanceAfter: bonusBalanceBefore }
            }
            throw err
        }

        await tx.wallet.update({
            where: { userId: params.userId },
            data: { bonusBalance: { increment: amount } },
        })
        const bonusBalanceAfter = bonusBalanceBefore.plus(amount)

        return { granted: true, grantId, amount, bonusBalanceBefore, bonusBalanceAfter }
    }
}
