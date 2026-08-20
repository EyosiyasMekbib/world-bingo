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

        // Convert dates to ISO strings and bind as naive timestamps to match schema.
        // The columns are `timestamp` WITHOUT time zone holding UTC. Prisma binds a JS Date
        // as timestamptz, which Postgres reconciles using the SESSION timezone, silently
        // shifting the stored value. Passing ISO strings cast to `timestamp` avoids this.
        const periodStartUtc = (params.periodStart ?? new Date()).toISOString()
        const expiresAtUtc = params.expiresAt ? params.expiresAt.toISOString() : null
        const ruleId = params.ruleId ?? null

        const rows = await tx.$queryRaw<Array<{ id: string }>>`
            INSERT INTO bonus_grants (id, "userId", "ruleId", amount, remaining, "periodStart", "expiresAt", status, "createdAt")
            VALUES (gen_random_uuid(), ${params.userId}, ${ruleId}, ${amount}, ${amount}, ${periodStartUtc}::timestamp, ${expiresAtUtc}::timestamp, 'ACTIVE', NOW())
            ON CONFLICT ("ruleId", "userId", "periodStart") DO NOTHING
            RETURNING id
        `

        if (rows.length === 0) {
            return { granted: false, amount, bonusBalanceBefore, bonusBalanceAfter: bonusBalanceBefore }
        }

        const grantId = rows[0].id

        await tx.wallet.update({
            where: { userId: params.userId },
            data: { bonusBalance: { increment: amount } },
        })
        const bonusBalanceAfter = bonusBalanceBefore.plus(amount)

        return { granted: true, grantId, amount, bonusBalanceBefore, bonusBalanceAfter }
    }
}
