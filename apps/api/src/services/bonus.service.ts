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

export interface SpendBonusResult {
    spent: Decimal
    bonusBalanceBefore: Decimal
    bonusBalanceAfter: Decimal
    soonestExpiryConsumed: Date | null
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

    /**
     * Consumes active lots soonest-expiry-first (NULL expiry sorts last — it
     * never dies, so it is the worst choice to spend from first). Assumes the
     * caller already holds a FOR UPDATE lock on the wallet row in this same
     * transaction; this does not re-lock it.
     */
    static async spend(tx: Prisma.TransactionClient, userId: string, amount: Decimal | number): Promise<SpendBonusResult> {
        const need = new Decimal(amount)
        if (!need.isFinite() || need.lte(0)) {
            throw new Error('Spend amount must be a positive number')
        }

        const lots = await tx.$queryRaw<Array<{ id: string; remaining: Decimal; expiresAt: Date | null }>>`
            SELECT id, remaining, "expiresAt" FROM bonus_grants
            WHERE "userId" = ${userId} AND status = 'ACTIVE'
            ORDER BY "expiresAt" ASC NULLS LAST, id ASC
            FOR UPDATE
        `

        const wallets = await tx.$queryRaw<Array<{ bonusBalance: Decimal }>>`
            SELECT "bonusBalance" FROM wallets WHERE "userId" = ${userId}
        `
        const bonusBalanceBefore = new Decimal(wallets[0]?.bonusBalance ?? 0)

        let remainingNeed = need
        let soonestExpiryConsumed: Date | null = null
        const updates: Array<Promise<unknown>> = []

        for (const lot of lots) {
            if (remainingNeed.lte(0)) break
            const lotRemaining = new Decimal(lot.remaining)
            const take = Decimal.min(lotRemaining, remainingNeed)
            if (soonestExpiryConsumed === null) soonestExpiryConsumed = lot.expiresAt

            const newRemaining = lotRemaining.minus(take)
            updates.push(
                tx.bonusGrant.update({
                    where: { id: lot.id },
                    data: {
                        remaining: newRemaining,
                        status: newRemaining.lte(0) ? 'CONSUMED' : 'ACTIVE',
                    },
                }),
            )
            remainingNeed = remainingNeed.minus(take)
        }

        if (remainingNeed.gt(0)) {
            throw new InsufficientBonusBalanceError()
        }

        await Promise.all(updates)
        await tx.wallet.update({ where: { userId }, data: { bonusBalance: { decrement: need } } })

        return {
            spent: need,
            bonusBalanceBefore,
            bonusBalanceAfter: bonusBalanceBefore.minus(need),
            soonestExpiryConsumed,
        }
    }
}
