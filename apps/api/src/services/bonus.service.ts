import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '../lib/prisma'
import { TransactionType, PaymentStatus } from '@world-bingo/shared-types'
import { NotificationService } from './notification.service'

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

export interface ReduceBonusResult {
    reduced: Decimal
    bonusBalanceBefore: Decimal
    bonusBalanceAfter: Decimal
}

export interface ExpireBonusResult {
    expired: Decimal
    bonusBalanceBefore: Decimal
    bonusBalanceAfter: Decimal
}

export interface ReconciliationMismatch {
    userId: string
    cachedBalance: Decimal
    lotSum: Decimal
}

export interface SweepExpiredBonusesResult {
    usersProcessed: number
    totalExpired: string
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
     * transaction; this does not re-lock it. Shared by `spend` (throws when
     * short) and `reduce` (clamps at zero when short).
     */
    private static async consumeLots(
        tx: Prisma.TransactionClient,
        userId: string,
        amount: Decimal,
        opts: { clamp: boolean },
    ): Promise<{ consumed: Decimal; soonestExpiryConsumed: Date | null }> {
        const lots = await tx.$queryRaw<Array<{ id: string; remaining: Decimal; expiresAt: Date | null }>>`
            SELECT id, remaining, "expiresAt" FROM bonus_grants
            WHERE "userId" = ${userId} AND status = 'ACTIVE'
            ORDER BY "expiresAt" ASC NULLS LAST, id ASC
            FOR UPDATE
        `

        let remainingNeed = amount
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
                    data: { remaining: newRemaining, status: newRemaining.lte(0) ? 'CONSUMED' : 'ACTIVE' },
                }),
            )
            remainingNeed = remainingNeed.minus(take)
        }

        if (remainingNeed.gt(0) && !opts.clamp) {
            throw new InsufficientBonusBalanceError()
        }

        await Promise.all(updates)
        const consumed = amount.minus(remainingNeed.gt(0) ? remainingNeed : new Decimal(0))
        return { consumed, soonestExpiryConsumed }
    }

    static async spend(tx: Prisma.TransactionClient, userId: string, amount: Decimal | number): Promise<SpendBonusResult> {
        const need = new Decimal(amount)
        if (!need.isFinite() || need.lte(0)) {
            throw new Error('Spend amount must be a positive number')
        }
        const wallets = await tx.$queryRaw<Array<{ bonusBalance: Decimal }>>`
            SELECT "bonusBalance" FROM wallets WHERE "userId" = ${userId}
        `
        const bonusBalanceBefore = new Decimal(wallets[0]?.bonusBalance ?? 0)

        const { consumed, soonestExpiryConsumed } = await this.consumeLots(tx, userId, need, { clamp: false })
        await tx.wallet.update({ where: { userId }, data: { bonusBalance: { decrement: consumed } } })

        return {
            spent: consumed,
            bonusBalanceBefore,
            bonusBalanceAfter: bonusBalanceBefore.minus(consumed),
            soonestExpiryConsumed,
        }
    }

    /** Negative admin adjustment. Clamps at zero — a balance never goes below zero. */
    static async reduce(tx: Prisma.TransactionClient, userId: string, amount: Decimal | number): Promise<ReduceBonusResult> {
        const requested = new Decimal(amount)
        if (!requested.isFinite() || requested.lte(0)) {
            throw new Error('Reduce amount must be a positive number')
        }
        const wallets = await tx.$queryRaw<Array<{ bonusBalance: Decimal }>>`
            SELECT "bonusBalance" FROM wallets WHERE "userId" = ${userId}
        `
        const bonusBalanceBefore = new Decimal(wallets[0]?.bonusBalance ?? 0)

        const { consumed } = await this.consumeLots(tx, userId, requested, { clamp: true })
        await tx.wallet.update({ where: { userId }, data: { bonusBalance: { decrement: consumed } } })

        return { reduced: consumed, bonusBalanceBefore, bonusBalanceAfter: bonusBalanceBefore.minus(consumed) }
    }

    /** Recreates a lot for refunded bonus, carrying the ORIGINAL expiry — never a fresh window. */
    static async restore(
        tx: Prisma.TransactionClient,
        userId: string,
        amount: Decimal | number,
        expiresAt: Date | null,
    ): Promise<GrantBonusResult> {
        return this.grant(tx, { userId, amount, source: 'ADMIN', ruleId: null, expiresAt })
    }

    /**
     * Called by the expiry worker, which holds no prior lock — unlike spend/
     * reduce/restore, this locks the wallet itself. Locks the wallet BEFORE
     * the bonus_grants rows, matching the lock order every other call site
     * uses (the caller locks the wallet, then consumeLots locks bonus_grants
     * rows filtered by status = 'ACTIVE' — the same set this method locks).
     * Locking lots first here would invert that order and risk a deadlock
     * against a concurrent spend/reduce for the same user.
     */
    static async expireForUser(tx: Prisma.TransactionClient, userId: string, now: Date): Promise<ExpireBonusResult | null> {
        const wallets = await tx.$queryRaw<Array<{ bonusBalance: Decimal }>>`
            SELECT "bonusBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
        `
        const bonusBalanceBefore = new Decimal(wallets[0]?.bonusBalance ?? 0)

        // "expiresAt" is `timestamp` WITHOUT time zone; binding a raw Date here
        // sends it as timestamptz and lets Postgres reconcile using the session
        // timezone, silently shifting the comparison on any non-UTC-pinned
        // session — the exact bug already documented and fixed in
        // player-metrics.service.ts's findStaleUserIds, and hit again (then
        // fixed) in BonusService.grant during Task 2's review. Bind the ISO
        // string and cast explicitly instead.
        const nowUtc = now.toISOString()
        const lots = await tx.$queryRaw<Array<{ id: string; remaining: Decimal }>>`
            SELECT id, remaining FROM bonus_grants
            WHERE "userId" = ${userId} AND status = 'ACTIVE' AND "expiresAt" <= ${nowUtc}::timestamp
            FOR UPDATE
        `
        if (lots.length === 0) return null

        const total = lots.reduce((sum, lot) => sum.plus(new Decimal(lot.remaining)), new Decimal(0))

        await tx.bonusGrant.updateMany({
            where: { id: { in: lots.map((l) => l.id) } },
            data: { remaining: 0, status: 'EXPIRED' },
        })
        await tx.wallet.update({ where: { userId }, data: { bonusBalance: { decrement: total } } })

        return { expired: total, bonusBalanceBefore, bonusBalanceAfter: bonusBalanceBefore.minus(total) }
    }

    /**
     * Sweeps every user with an ACTIVE lot past its expiresAt: expires each
     * one in its own transaction via expireForUser and writes a
     * BONUS_EXPIRED transaction so a balance dropping overnight has an audit
     * row, then pushes a live wallet update. Called every 15 minutes by the
     * bonus-expiry worker (a thin BullMQ wrapper around this method, matching
     * how every other worker in this codebase wraps a testable service
     * method rather than holding its own business logic).
     */
    static async sweepExpired(): Promise<SweepExpiredBonusesResult> {
        const now = new Date()
        // See the identical note in expireForUser — bind the ISO string and
        // cast explicitly; a raw Date here would compare against
        // "expiresAt" (naive timestamp) using the session timezone.
        const nowUtc = now.toISOString()
        const dueUsers = await prisma.$queryRaw<Array<{ userId: string }>>`
            SELECT DISTINCT "userId" FROM bonus_grants WHERE status = 'ACTIVE' AND "expiresAt" <= ${nowUtc}::timestamp
        `

        let usersProcessed = 0
        let totalExpired = new Decimal(0)

        for (const { userId } of dueUsers) {
            const result = await prisma.$transaction(async (tx) => {
                const expireResult = await BonusService.expireForUser(tx, userId, now)
                if (!expireResult) return null
                await tx.transaction.create({
                    data: {
                        userId,
                        type: TransactionType.BONUS_EXPIRED,
                        amount: expireResult.expired,
                        status: PaymentStatus.APPROVED,
                        note: 'Bonus expired',
                        bonusBalanceBefore: expireResult.bonusBalanceBefore,
                        bonusBalanceAfter: expireResult.bonusBalanceAfter,
                    },
                })
                return expireResult
            })
            if (!result) continue

            usersProcessed++
            totalExpired = totalExpired.plus(result.expired)

            const wallet = await prisma.wallet.findUnique({ where: { userId } })
            if (wallet) {
                NotificationService.pushWalletUpdate(userId, Number(wallet.realBalance), Number(wallet.bonusBalance))
            }
        }

        return { usersProcessed, totalExpired: totalExpired.toFixed(2) }
    }

    /**
     * Every wallet where the cached bonusBalance disagrees with the sum of its
     * live lots. Should always be empty — see the Global Constraints invariant.
     * Exposed to the admin panel (Task 24) so drift in production is visible
     * rather than silent.
     */
    static async reconcile(client: Prisma.TransactionClient | typeof import('../lib/prisma').default = prisma): Promise<ReconciliationMismatch[]> {
        const rows = await client.$queryRaw<Array<{ userId: string; cachedBalance: Decimal; lotSum: Decimal }>>`
            SELECT w."userId",
                   w."bonusBalance" AS "cachedBalance",
                   COALESCE(SUM(g.remaining) FILTER (WHERE g.status = 'ACTIVE'), 0) AS "lotSum"
            FROM wallets w
            LEFT JOIN bonus_grants g ON g."userId" = w."userId"
            GROUP BY w."userId", w."bonusBalance"
            HAVING w."bonusBalance" != COALESCE(SUM(g.remaining) FILTER (WHERE g.status = 'ACTIVE'), 0)
        `
        return rows.map((r) => ({
            userId: r.userId,
            cachedBalance: new Decimal(r.cachedBalance),
            lotSum: new Decimal(r.lotSum),
        }))
    }
}
