import Redlock from 'redlock'
import { Prisma } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '../../lib/prisma.js'
import redis from '../../lib/redis.js'
import { getQueue, QUEUE_NAMES } from '../../lib/queue.js'
import { reportError } from '../../lib/sentry.js'
import { emitBook, emitSettled, emitStatus } from '../../gateways/prediction.gateway.js'
import { BonusService } from '../bonus.service.js'

/**
 * Prediction market settlement and void.
 *
 * Two money paths, one shape. Both run under the same Redlock so a settle and a
 * void can never interleave on one market, both page through rows in batches
 * with each batch its own transaction, and both are idempotent because every
 * write is guarded on the row still being in its pre-terminal state. A retry
 * after a crash mid-batch resumes; it does not double-pay.
 *
 * `shareValue` and `feePct` are read from the MARKET, never from a constant and
 * never from live settings — they were snapshotted onto the market at creation
 * precisely so that changing them later cannot move money already escrowed.
 */

const BATCH_SIZE = 200
const LOCK_TTL_MS = 60_000
const TX_TIMEOUT_MS = 60_000
const TX_MAX_WAIT_MS = 15_000

/**
 * Percentage divisor for the fee. This is 100 because a percent is one part in
 * a hundred — it is NOT the share value and must never be confused with it.
 */
const PERCENT = new Decimal(100)

const ZERO = new Decimal(0)

const redlock = new Redlock([redis as any], {
    retryCount: 0, // another worker already holds it — bail, don't queue up behind it
    retryDelay: 200,
    driftFactor: 0.01,
})

redlock.on('error', (err: Error) => {
    if (!err.message?.includes('lock')) {
        console.error('[PredictionSettlement] Redlock error:', err)
    }
})

/**
 * A SECOND client, for the match lock only, and it waits rather than bailing.
 *
 * A void has to stop the book before it starts handing money back, and stopping
 * the book means taking the same lock `order.service` holds while it matches. If
 * that acquisition failed fast, a void would simply not run whenever one order
 * happened to be in flight. It queues instead: the in-flight placement finishes,
 * the market flips out of OPEN, and every later placement re-reads VOIDED and is
 * rejected inside its own transaction.
 */
const matchRedlock = new Redlock([redis as any], {
    retryCount: 40,
    retryDelay: 250,
    retryJitter: 100,
    driftFactor: 0.01,
})

matchRedlock.on('error', (err: Error) => {
    if (!err.message?.includes('lock')) {
        console.error('[PredictionSettlement] Redlock (match) error:', err)
    }
})

/** Settle and void share one lock: they are mutually exclusive on a market. */
const settleLockKey = (marketId: string) => `lock:prediction:settle:${marketId}`

/** The placement lock. Same key `order.service.ts` builds — it must stay in step. */
const matchLockKey = (marketId: string) => `lock:prediction:match:${marketId}`

/** How long the match lock is held for the status flip. It guards two queries. */
const MATCH_LOCK_TTL_MS = 15_000

export interface SettlementBreakdown {
    gross: Decimal
    profit: Decimal
    fee: Decimal
    net: Decimal
}

export interface SettleResult {
    marketId: string
    settled: boolean
    reason?: string
    winningOutcomeId?: string
    ordersRefunded: number
    positionsWon: number
    positionsLost: number
    totalFee: Decimal
}

export interface VoidResult {
    marketId: string
    voided: boolean
    reason?: string
    ordersRefunded: number
    positionsRefunded: number
    totalRefunded: Decimal
}

interface WalletSnapshot {
    realBefore: Decimal
    bonusBefore: Decimal
}

interface NotificationJob {
    userId: string
    type: 'PREDICTION_SETTLED' | 'PREDICTION_VOIDED'
    title: string
    body: string
    metadata: Record<string, unknown>
}

/**
 * Round a money value to 2 decimal places, half-up. Exported so the fee tests can
 * assert against the exact rounding the service uses rather than reimplementing it.
 */
export function round2(value: Decimal): Decimal {
    return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
}

/**
 * Split `total` across two buckets in the ratio of `partReal` : `partBonus`.
 * The bonus leg is rounded and the real leg takes the remainder, so the two legs
 * always add back up to `total` exactly — no rounding dust is created or lost.
 */
function splitProportionally(
    total: Decimal,
    partReal: Decimal,
    partBonus: Decimal,
): { real: Decimal; bonus: Decimal } {
    const denominator = partReal.plus(partBonus)
    if (total.lessThanOrEqualTo(0) || denominator.lessThanOrEqualTo(0)) {
        return { real: total.greaterThan(0) ? total : ZERO, bonus: ZERO }
    }
    const bonus = round2(total.times(partBonus).dividedBy(denominator))
    return { real: total.minus(bonus), bonus }
}

/**
 * Lock a wallet row FOR UPDATE and return its pre-image. Every money path in this
 * file takes the wallet lock FIRST and touches prediction rows after, matching the
 * ordering in `order.service` and `game.service` so the lock graph stays acyclic.
 */
async function lockWallet(tx: Prisma.TransactionClient, userId: string): Promise<WalletSnapshot> {
    const rows = await tx.$queryRaw<Array<{ id: string; realBalance: Decimal; bonusBalance: Decimal }>>`
        SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
    `
    const wallet = rows[0]
    if (!wallet) throw new Error(`Wallet not found for user ${userId}`)
    return {
        realBefore: new Decimal(wallet.realBalance),
        bonusBefore: new Decimal(wallet.bonusBalance),
    }
}

export class PredictionSettlementService {
    /**
     * PURE. The whole payout formula for one winning position.
     *
     *   gross  = shares x shareValue
     *   profit = max(gross - costBasis, 0)
     *   fee    = round2(profit x feePct / 100)
     *   net    = gross - fee
     *
     * The fee is charged on profit, not gross, so a share bought at 90 against a
     * 100 share value still pays 98.50 and every price in the book stays winnable.
     * Profit cannot legitimately be negative (basis per share is at most
     * shareValue - 1) but it is clamped anyway — a corrupted basis must not turn
     * into a negative fee, i.e. the house paying the player a bonus.
     */
    static computeSettlement(
        shares: number,
        shareValue: Decimal,
        costBasis: Decimal,
        feePct: Decimal,
    ): SettlementBreakdown {
        const gross = new Decimal(shareValue).times(shares)
        const basis = new Decimal(costBasis)
        const rawProfit = gross.minus(basis)
        const profit = rawProfit.greaterThan(0) ? rawProfit : ZERO
        const fee = round2(profit.times(new Decimal(feePct)).dividedBy(PERCENT))
        const net = gross.minus(fee)
        return { gross, profit, fee, net }
    }

    /**
     * Run `fn` while holding the market's settle lock, or report that a settle or
     * void already owns it.
     *
     * This exists for `unresolveMarket`: reversing a resolution is only safe if
     * no payout is running, and "no payout is running" is exactly what this lock
     * means. `acquired: false` is not an error here — the caller turns it into a
     * 409, because a market whose payout has already started can no longer be
     * reversed by an admin.
     */
    static async withSettleLock<T>(
        marketId: string,
        fn: () => Promise<T>,
    ): Promise<{ acquired: boolean; result?: T }> {
        let lock: any
        try {
            lock = await redlock.acquire([settleLockKey(marketId)], LOCK_TTL_MS)
        } catch {
            return { acquired: false }
        }

        try {
            return { acquired: true, result: await fn() }
        } finally {
            await PredictionSettlementService.releaseLock(lock)
        }
    }

    // ── Settlement ──────────────────────────────────────────────────────────

    /**
     * Pay out a resolved market. Runs from the `settle-market` job after the
     * dispute window has elapsed.
     */
    static async settleMarket(marketId: string): Promise<SettleResult> {
        const empty: SettleResult = {
            marketId,
            settled: false,
            ordersRefunded: 0,
            positionsWon: 0,
            positionsLost: 0,
            totalFee: ZERO,
        }

        let lock: any
        try {
            lock = await redlock.acquire([settleLockKey(marketId)], LOCK_TTL_MS)
        } catch {
            console.log(`[PredictionSettlement] ${marketId}: settle lock held elsewhere — skipping`)
            return { ...empty, reason: 'lock_not_acquired' }
        }

        try {
            const market = await prisma.predictionMarket.findUnique({
                where: { id: marketId },
                include: { outcomes: true },
            })
            if (!market) return { ...empty, reason: 'market_not_found' }

            // Quiet no-ops, not throws: a duplicate delayed job, a job that fires
            // while an admin is mid-unresolve, or a retry after SETTLED all land here.
            if (market.status !== 'RESOLVING') {
                return { ...empty, reason: `market_status_${market.status}` }
            }
            if (!market.winningOutcomeId) {
                return { ...empty, reason: 'no_winning_outcome' }
            }
            if (!market.disputeUntil || Date.now() < market.disputeUntil.getTime()) {
                return { ...empty, reason: 'dispute_window_open' }
            }

            const winningOutcomeId = market.winningOutcomeId
            const shareValue = new Decimal(market.shareValue)
            const feePct = new Decimal(market.feePct)

            await PredictionSettlementService.checkSolvency(marketId, shareValue, market.totalShares, winningOutcomeId)

            // 1. Unmatched reserve was never at risk — hand it all back before paying anyone.
            const ordersRefunded = await PredictionSettlementService.refundOpenOrders(
                marketId,
                'PREDICTION_ORDER_RELEASE',
                lock,
            )

            // The book is empty now; a settled market never fills again, so no
            // later emit would ever correct a client still rendering that depth.
            emitBook(marketId)

            // 2. Winning positions, batch by batch.
            const winners: Array<{ userId: string; payout: Decimal }> = []
            let positionsWon = 0
            let reversed = false

            for (;;) {
                const batch = await prisma.predictionPosition.findMany({
                    where: { marketId, outcomeId: winningOutcomeId, status: 'OPEN' },
                    orderBy: { userId: 'asc' },
                    take: BATCH_SIZE,
                })
                if (batch.length === 0) break

                const paid = await prisma.$transaction(
                    async (tx) => {
                        // Re-verify the call inside every batch. Paging hundreds of
                        // positions takes real time, and the status was read once
                        // before any of it. An admin reversal that lands mid-run
                        // must stop the payout, not race it — otherwise the market
                        // ends up CLOSED with its winners already paid.
                        const current = await tx.predictionMarket.findUnique({
                            where: { id: marketId },
                            select: { status: true, winningOutcomeId: true },
                        })
                        if (
                            current?.status !== 'RESOLVING' ||
                            current.winningOutcomeId !== winningOutcomeId
                        ) {
                            reversed = true
                            return []
                        }

                        const settledInBatch: Array<{ userId: string; payout: Decimal }> = []
                        for (const position of batch) {
                            const { fee, net } = PredictionSettlementService.computeSettlement(
                                position.shares,
                                shareValue,
                                new Decimal(position.costBasisReal).plus(position.costBasisBonus),
                                feePct,
                            )

                            const { realBefore, bonusBefore } = await lockWallet(tx, position.userId)

                            // The idempotency gate. Filtering on status = 'OPEN' inside the
                            // same transaction as the credit means a retry that re-reads a
                            // already-WON row updates nothing and pays nothing.
                            const claimed = await tx.predictionPosition.updateMany({
                                where: { id: position.id, status: 'OPEN' },
                                data: {
                                    status: 'WON',
                                    payout: net,
                                    feePaid: fee,
                                    settledAt: new Date(),
                                },
                            })
                            if (claimed.count === 0) continue

                            // Winnings are cash. Bonus-funded or not, a settled position
                            // credits REAL balance only — bonus is a stake subsidy, not a
                            // payout currency.
                            const realAfter = realBefore.plus(net)
                            await tx.wallet.update({
                                where: { userId: position.userId },
                                data: { realBalance: realAfter },
                            })
                            await tx.transaction.create({
                                data: {
                                    userId: position.userId,
                                    type: 'PREDICTION_WIN',
                                    amount: net,
                                    status: 'APPROVED',
                                    referenceId: marketId,
                                    note: `Prediction win — ${market.question}`,
                                    balanceBefore: realBefore,
                                    balanceAfter: realAfter,
                                    bonusBalanceBefore: bonusBefore,
                                    bonusBalanceAfter: bonusBefore,
                                },
                            })

                            settledInBatch.push({ userId: position.userId, payout: net })
                        }
                        return settledInBatch
                    },
                    { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
                )

                winners.push(...paid)
                positionsWon += paid.length

                // Every row in the batch was already terminal — nothing left to do, and
                // re-querying would spin forever on the same 200 rows.
                if (paid.length === 0) break

                await PredictionSettlementService.extendLock(lock, marketId)
            }

            if (reversed) {
                // The market was unresolved or voided underneath us. Stop here:
                // do not mark the losers, do not book a fee, do not stamp SETTLED.
                console.warn(
                    `[PredictionSettlement] ${marketId}: resolution reversed mid-settlement — ` +
                        `stopping after ${positionsWon} payout(s)`,
                )
                return { ...empty, reason: 'resolution_reversed', ordersRefunded, positionsWon }
            }

            // 3. The losing side. One statement — there is no money to move.
            const losersBefore = await prisma.predictionPosition.findMany({
                where: { marketId, status: 'OPEN', outcomeId: { not: winningOutcomeId } },
                select: { userId: true },
            })
            const lost = await prisma.predictionPosition.updateMany({
                where: { marketId, status: 'OPEN', outcomeId: { not: winningOutcomeId } },
                data: { status: 'LOST', payout: 0, settledAt: new Date() },
            })

            // 4. The house takes its cut once, from what was actually charged.
            const totalFee = await PredictionSettlementService.creditHouseFee(marketId, market.question)

            // 5. Terminal state, guarded so a concurrent void cannot be overwritten.
            await prisma.predictionMarket.updateMany({
                where: { id: marketId, status: 'RESOLVING' },
                data: { status: 'SETTLED', settledAt: new Date() },
            })

            // ── Post-commit side effects ────────────────────────────────────
            const winningLabel =
                market.outcomes.find((o) => o.id === winningOutcomeId)?.label ?? 'the winning outcome'

            emitSettled(marketId, winningOutcomeId, market.totalShares, totalFee)
            emitStatus(marketId)

            await PredictionSettlementService.enqueueNotifications([
                ...winners.map((w) => ({
                    userId: w.userId,
                    type: 'PREDICTION_SETTLED' as const,
                    title: 'Prediction settled — you won',
                    body: `${market.question} resolved to ${winningLabel}. ${w.payout.toString()} ETB has been credited to your wallet.`,
                    metadata: { marketId, winningOutcomeId, payout: w.payout.toString() },
                })),
                ...losersBefore.map((l) => ({
                    userId: l.userId,
                    type: 'PREDICTION_SETTLED' as const,
                    title: 'Prediction settled',
                    body: `${market.question} resolved to ${winningLabel}.`,
                    metadata: { marketId, winningOutcomeId, payout: '0' },
                })),
            ])

            console.log(
                `[PredictionSettlement] ${marketId}: settled — ${positionsWon} won, ${lost.count} lost, ` +
                    `${ordersRefunded} orders refunded, fee ${totalFee.toString()} ETB`,
            )

            return {
                marketId,
                settled: true,
                winningOutcomeId,
                ordersRefunded,
                positionsWon,
                positionsLost: lost.count,
                totalFee,
            }
        } finally {
            await PredictionSettlementService.releaseLock(lock)
        }
    }

    // ── Void ────────────────────────────────────────────────────────────────

    /**
     * Unwind a market — a draw, a no-contest, a cancelled bout, or an admin void.
     * Everyone gets their money back at cost basis and the house takes nothing.
     */
    static async voidMarket(marketId: string, reason: string): Promise<VoidResult> {
        const empty: VoidResult = {
            marketId,
            voided: false,
            ordersRefunded: 0,
            positionsRefunded: 0,
            totalRefunded: ZERO,
        }

        let lock: any
        try {
            lock = await redlock.acquire([settleLockKey(marketId)], LOCK_TTL_MS)
        } catch {
            console.log(`[PredictionSettlement] ${marketId}: void lock held elsewhere — skipping`)
            return { ...empty, reason: 'lock_not_acquired' }
        }

        try {
            const market = await prisma.predictionMarket.findUnique({ where: { id: marketId } })
            if (!market) return { ...empty, reason: 'market_not_found' }
            if (market.status === 'SETTLED') return { ...empty, reason: 'market_already_settled' }

            // ── Stop the book BEFORE a single birr moves ────────────────────
            //
            // The refund passes below take hundreds of round trips on a busy
            // market. Flipping the status only at the END of that would leave
            // the market reading OPEN throughout, so `placeOrder`'s in-transaction
            // status check would keep passing: an order committed during the
            // refund pass rests forever on a market that is about to become
            // terminal, with its reserve unreachable by cancel, void or settle;
            // and a fill landing on a position row this loop already refunded
            // would book escrow onto a REFUNDED row that is never revisited.
            //
            // So the terminal transition is claimed first, under the MATCH lock,
            // which is what `placeOrder` holds while it matches. Any placement
            // already inside its transaction commits before the flip and is
            // therefore picked up by the refund passes; every placement after it
            // re-reads VOIDED and is rejected.
            const claimed = await PredictionSettlementService.claimVoid(marketId, reason)
            if (!claimed) {
                const fresh = await prisma.predictionMarket.findUnique({
                    where: { id: marketId },
                    select: { status: true },
                })
                if (fresh?.status === 'SETTLED') {
                    return { ...empty, reason: 'market_already_settled' }
                }
                // Already VOIDED — fall through rather than return. A void that
                // died mid-refund must be able to resume; every write below is
                // guarded on the row's own pre-terminal state, so resuming pays
                // out exactly what the first run did not.
            }

            emitStatus(marketId)

            const shareValue = new Decimal(market.shareValue)
            await PredictionSettlementService.checkSolvency(marketId, shareValue, market.totalShares)

            const ordersRefunded = await PredictionSettlementService.refundOpenOrders(
                marketId,
                'PREDICTION_REFUND',
                lock,
            )

            // The book is empty now. Clients holding a pre-void depth snapshot
            // would otherwise render it forever — a terminal market never fills
            // again, so no later emit would correct them.
            emitBook(marketId)

            const refundedUserIds: string[] = []
            let positionsRefunded = 0
            let totalRefunded = ZERO

            for (;;) {
                const batch = await prisma.predictionPosition.findMany({
                    where: { marketId, status: 'OPEN' },
                    orderBy: { userId: 'asc' },
                    take: BATCH_SIZE,
                })
                if (batch.length === 0) break

                const done = await prisma.$transaction(
                    async (tx) => {
                        const refunded: Array<{ userId: string; amount: Decimal }> = []
                        for (const position of batch) {
                            const basisReal = new Decimal(position.costBasisReal)
                            const basisBonus = new Decimal(position.costBasisBonus)
                            const amount = basisReal.plus(basisBonus)

                            const { realBefore, bonusBefore } = await lockWallet(tx, position.userId)

                            const claimed = await tx.predictionPosition.updateMany({
                                where: { id: position.id, status: 'OPEN' },
                                data: {
                                    status: 'REFUNDED',
                                    payout: amount,
                                    feePaid: 0,
                                    settledAt: new Date(),
                                },
                            })
                            if (claimed.count === 0) continue

                            // Bonus goes back as bonus. Refunding a bonus-funded position to
                            // real balance would launder promotional credit into withdrawable
                            // cash — the same rule the bingo leave/refund path enforces. Real
                            // returns as a plain wallet credit; bonus returns through
                            // `BonusService.restore` so it lands in a lot carrying the SAME
                            // expiry the funding order's hold consumed, rather than a fresh
                            // window — mirrors `refundOpenOrders` above. A position has no
                            // single originating order (its cost basis can accumulate from
                            // several fills — matching.service.ts's upsert increments
                            // costBasisBonus across potentially many orders), so every
                            // PREDICTION_ORDER_HOLD for this user on this market is fetched
                            // (referenceId=marketId, no note-contains-orderId to scope to one)
                            // and reduced to the SOONEST non-null bonusExpiresAtSpend among
                            // them — the same fix Task 15 applied to leaveGame/refundGame for
                            // the identical multi-hold ambiguity (see refund.service.ts).
                            // Restoring under a LATER expiry than any contributing hold
                            // actually had would extend that portion's effective life, which
                            // is exactly the anti-abuse leak this plan exists to close.
                            const realAfter = realBefore.plus(basisReal)
                            const bonusAfter = bonusBefore.plus(basisBonus)
                            if (basisReal.greaterThan(0)) {
                                await tx.wallet.update({
                                    where: { userId: position.userId },
                                    data: { realBalance: realAfter },
                                })
                            }
                            if (basisBonus.greaterThan(0)) {
                                const holds = await tx.transaction.findMany({
                                    where: {
                                        userId: position.userId,
                                        type: 'PREDICTION_ORDER_HOLD',
                                        referenceId: marketId,
                                    },
                                    select: { bonusExpiresAtSpend: true },
                                })
                                const holdExpiry = holds.reduce<Date | null>((soonest, t) => {
                                    if (t.bonusExpiresAtSpend == null) return soonest
                                    if (soonest == null || t.bonusExpiresAtSpend < soonest) return t.bonusExpiresAtSpend
                                    return soonest
                                }, null)
                                await BonusService.restore(tx, position.userId, basisBonus, holdExpiry)
                            }
                            await tx.transaction.create({
                                data: {
                                    userId: position.userId,
                                    type: 'PREDICTION_REFUND',
                                    amount,
                                    status: 'APPROVED',
                                    referenceId: marketId,
                                    note: `Prediction voided — ${reason}`,
                                    balanceBefore: realBefore,
                                    balanceAfter: realAfter,
                                    bonusBalanceBefore: bonusBefore,
                                    bonusBalanceAfter: bonusAfter,
                                },
                            })

                            refunded.push({ userId: position.userId, amount })
                        }
                        return refunded
                    },
                    { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
                )

                if (done.length === 0) break

                positionsRefunded += done.length
                for (const r of done) {
                    totalRefunded = totalRefunded.plus(r.amount)
                    refundedUserIds.push(r.userId)
                }

                await PredictionSettlementService.extendLock(lock, marketId)
            }

            // No HouseTransaction. A void produces no revenue — the house was never a
            // counterparty, so there is nothing to book and nothing to claw back.
            //
            // The status was claimed at the top; all that is left is to stamp when
            // the money actually finished moving.
            await prisma.predictionMarket.updateMany({
                where: { id: marketId, status: 'VOIDED', settledAt: null },
                data: { settledAt: new Date() },
            })

            await PredictionSettlementService.enqueueNotifications(
                [...new Set(refundedUserIds)].map((userId) => ({
                    userId,
                    type: 'PREDICTION_VOIDED' as const,
                    title: 'Prediction voided — refunded',
                    body: `${market.question} was voided (${reason}). Your stake has been returned in full.`,
                    metadata: { marketId, reason },
                })),
            )

            console.log(
                `[PredictionSettlement] ${marketId}: voided (${reason}) — ${positionsRefunded} positions ` +
                    `and ${ordersRefunded} orders refunded, ${totalRefunded.toString()} ETB returned`,
            )

            return {
                marketId,
                voided: true,
                ordersRefunded,
                positionsRefunded,
                totalRefunded,
            }
        } finally {
            await PredictionSettlementService.releaseLock(lock)
        }
    }

    // ── Internals ───────────────────────────────────────────────────────────

    /**
     * Claim the VOIDED transition under the per-market MATCH lock.
     *
     * Taking `lock:prediction:match:<marketId>` — the key `order.service` holds
     * for the whole of a placement — is what drains the placements already in
     * flight: this waits for them, then flips the row, and every placement that
     * starts afterwards re-reads the status inside its own transaction and is
     * rejected. Without it the flip would race a transaction that has already
     * passed its status check, and that order's reserve would be stranded on a
     * terminal market.
     *
     * Returns false when the row was already terminal — the caller decides
     * whether that is "already settled" (stop) or "already voided" (resume).
     */
    private static async claimVoid(marketId: string, reason: string): Promise<boolean> {
        let lock: any
        try {
            lock = await matchRedlock.acquire([matchLockKey(marketId)], MATCH_LOCK_TTL_MS)
        } catch {
            // The book could not be quiesced. Flip anyway and warn: refusing to
            // void would leave every position escrowed on a bout that is not
            // happening, which is strictly worse than the narrow window this
            // reopens (an order that commits just after the flip rests on a
            // terminal market and needs an operator to release it).
            console.warn(
                `[PredictionSettlement] ${marketId}: match lock unavailable — voiding without quiescing the book`,
            )
        }

        try {
            const claimed = await prisma.predictionMarket.updateMany({
                where: { id: marketId, status: { notIn: ['SETTLED', 'VOIDED'] } },
                data: { status: 'VOIDED', voidReason: reason },
            })
            return claimed.count > 0
        } finally {
            await PredictionSettlementService.releaseLock(lock)
        }
    }

    /**
     * Cancel every still-live order on the market and hand back the reserve it is
     * still holding. Unmatched reserve never became a position, so it was never at
     * risk on the result — it is returned in full regardless of the outcome.
     *
     * The refund is `min(reserve still on the row, limitPrice x unfilled)`. Those
     * two are the same number when the row's `reservedReal`/`reservedBonus` are
     * decremented as fills consume them; the cap makes this correct as well if the
     * row instead carries the original full reserve, and it can never pay out more
     * than the unfilled portion was worth.
     *
     * The batch query above is only a WORK LIST. Every figure the refund is
     * computed from is re-read inside the transaction and pinned in the update's
     * where-clause, because the batch snapshot is taken outside any transaction:
     * a fill landing between the two would otherwise refund a reserve that has
     * already become a position's cost basis, paying that money out twice.
     */
    private static async refundOpenOrders(
        marketId: string,
        txType: 'PREDICTION_ORDER_RELEASE' | 'PREDICTION_REFUND',
        lock: any,
    ): Promise<number> {
        let refunded = 0

        for (;;) {
            const batch = await prisma.predictionOrder.findMany({
                where: { marketId, status: { in: ['OPEN', 'PARTIALLY_FILLED'] } },
                orderBy: { userId: 'asc' },
                take: BATCH_SIZE,
            })
            if (batch.length === 0) break

            const done = await prisma.$transaction(
                async (tx) => {
                    let count = 0
                    for (const stale of batch) {
                        // Re-read inside the transaction. `stale` came from an
                        // unsynchronised snapshot and may already have been filled.
                        const order = await tx.predictionOrder.findUnique({
                            where: { id: stale.id },
                        })
                        if (!order) continue
                        if (order.status !== 'OPEN' && order.status !== 'PARTIALLY_FILLED') {
                            continue
                        }

                        const heldReal = new Decimal(order.reservedReal)
                        const heldBonus = new Decimal(order.reservedBonus)
                        const held = heldReal.plus(heldBonus)
                        const unfilled = Math.max(0, order.quantity - order.filledQuantity)
                        const cap = new Decimal(order.limitPrice).times(unfilled)
                        const release = Decimal.min(held, cap)
                        const { real, bonus } = splitProportionally(release, heldReal, heldBonus)

                        const { realBefore, bonusBefore } = await lockWallet(tx, order.userId)

                        // Pinned on everything the refund was computed from, the
                        // same way `matching.service` pins a maker before filling
                        // it. A fill that lands inside this transaction moves all
                        // three, so the update matches nothing and no money moves.
                        const claimed = await tx.predictionOrder.updateMany({
                            where: {
                                id: order.id,
                                status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
                                filledQuantity: order.filledQuantity,
                                reservedReal: heldReal,
                                reservedBonus: heldBonus,
                            },
                            data: {
                                status: 'CANCELLED',
                                reservedReal: heldReal.minus(real),
                                reservedBonus: heldBonus.minus(bonus),
                            },
                        })
                        if (claimed.count === 0) continue
                        count += 1

                        if (release.lessThanOrEqualTo(0)) continue

                        const realAfter = realBefore.plus(real)
                        const bonusAfter = bonusBefore.plus(bonus)

                        // Real returns as a plain wallet credit; bonus returns
                        // through `BonusService.restore` so it lands in a lot
                        // carrying the SAME expiry the order's original hold
                        // consumed, rather than a fresh window — mirrors
                        // `cancelOrder`'s own release path (Task 17).
                        if (real.greaterThan(0)) {
                            await tx.wallet.update({
                                where: { userId: order.userId },
                                data: { realBalance: realAfter },
                            })
                        }
                        if (bonus.greaterThan(0)) {
                            const hold = await tx.transaction.findFirst({
                                where: {
                                    userId: order.userId,
                                    type: 'PREDICTION_ORDER_HOLD',
                                    note: { contains: order.id },
                                },
                                select: { bonusExpiresAtSpend: true },
                            })
                            await BonusService.restore(tx, order.userId, bonus, hold?.bonusExpiresAtSpend ?? null)
                        }

                        await tx.transaction.create({
                            data: {
                                userId: order.userId,
                                type: txType,
                                amount: release,
                                status: 'APPROVED',
                                referenceId: marketId,
                                note: 'Prediction order cancelled — unmatched reserve released',
                                balanceBefore: realBefore,
                                balanceAfter: realAfter,
                                bonusBalanceBefore: bonusBefore,
                                bonusBalanceAfter: bonusAfter,
                            },
                        })
                    }
                    return count
                },
                { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
            )

            if (done === 0) {
                // Nothing in the batch was still claimable. Normally that means
                // a resumed run re-reading rows a previous pass already cancelled.
                // Anything else would spin on the same 200 rows forever, so stop
                // and say so rather than loop.
                console.warn(
                    `[PredictionSettlement] ${marketId}: ${batch.length} order(s) in the refund batch ` +
                        'were no longer claimable — stopping the refund pass',
                )
                break
            }
            refunded += done
            await PredictionSettlementService.extendLock(lock, marketId)
        }

        return refunded
    }

    /**
     * Book the summed fee to the house as a single HouseTransaction.
     *
     * The total is re-derived from the `feePaid` the positions actually recorded
     * rather than accumulated in memory, so a settlement that crashed and resumed
     * still books exactly what was charged. `gameId` carries the market id — the
     * house ledger has no market column and the field has no foreign key — and it
     * is also the idempotency key, checked under the house-wallet row lock.
     */
    private static async creditHouseFee(marketId: string, question: string): Promise<Decimal> {
        const agg = await prisma.predictionPosition.aggregate({
            where: { marketId, status: 'WON' },
            _sum: { feePaid: true },
        })
        const totalFee = new Decimal(agg._sum.feePaid ?? 0)
        if (totalFee.lessThanOrEqualTo(0)) return ZERO

        return prisma.$transaction(async (tx) => {
            await tx.$executeRaw`
                INSERT INTO house_wallet (id, balance, "updatedAt")
                VALUES ('house', 0, NOW())
                ON CONFLICT (id) DO NOTHING
            `
            const rows = await tx.$queryRaw<Array<{ balance: Decimal }>>`
                SELECT balance FROM house_wallet WHERE id = 'house' FOR UPDATE
            `

            const existing = await tx.houseTransaction.findFirst({
                where: { type: 'PREDICTION_FEE', gameId: marketId },
            })
            if (existing) return new Decimal(existing.amount)

            const before = new Decimal(rows[0]?.balance ?? 0)
            const after = before.plus(totalFee)
            await tx.$executeRaw`UPDATE house_wallet SET balance = ${after}, "updatedAt" = NOW() WHERE id = 'house'`
            await tx.houseTransaction.create({
                data: {
                    type: 'PREDICTION_FEE',
                    amount: totalFee,
                    description: `Prediction market fee — ${question}`,
                    gameId: marketId,
                    balanceBefore: before,
                    balanceAfter: after,
                },
            })
            return totalFee
        })
    }

    /**
     * The book must hold exactly what it owes.
     *
     *   sum(costBasis over every position) == totalShares x shareValue
     *   winning-side gross                 == totalShares x shareValue
     *
     * Every matched pair escrows one shareValue, so both sides of both identities
     * are the same money. A mismatch means the book is corrupt and someone is
     * about to be paid from the wrong pocket. It is reported loudly rather than
     * thrown: refusing to settle would strand player funds indefinitely, which is
     * strictly worse than paying out under an alarm.
     */
    private static async checkSolvency(
        marketId: string,
        shareValue: Decimal,
        totalShares: number,
        winningOutcomeId?: string,
    ): Promise<void> {
        const escrow = new Decimal(shareValue).times(totalShares)

        const all = await prisma.predictionPosition.aggregate({
            where: { marketId },
            _sum: { costBasisReal: true, costBasisBonus: true },
        })
        const basis = new Decimal(all._sum.costBasisReal ?? 0).plus(all._sum.costBasisBonus ?? 0)

        if (!basis.equals(escrow)) {
            const message =
                `[PredictionSettlement] SOLVENCY BREACH ${marketId}: sum(costBasis)=${basis.toString()} ` +
                `!= totalShares x shareValue=${escrow.toString()}`
            console.error(message)
            reportError(new Error(message), {
                service: 'prediction-settlement',
                marketId,
                basis: basis.toString(),
                escrow: escrow.toString(),
            })
        }

        if (!winningOutcomeId) return

        const winning = await prisma.predictionPosition.aggregate({
            where: { marketId, outcomeId: winningOutcomeId },
            _sum: { shares: true },
        })
        const gross = new Decimal(shareValue).times(winning._sum.shares ?? 0)

        if (!gross.equals(escrow)) {
            const message =
                `[PredictionSettlement] SOLVENCY BREACH ${marketId}: winning-side gross=${gross.toString()} ` +
                `!= totalShares x shareValue=${escrow.toString()}`
            console.error(message)
            reportError(new Error(message), {
                service: 'prediction-settlement',
                marketId,
                winningOutcomeId,
                gross: gross.toString(),
                escrow: escrow.toString(),
            })
        }
    }

    /** Notifications are out-of-band — a delivery failure must never unwind a payout. */
    private static async enqueueNotifications(jobs: NotificationJob[]): Promise<void> {
        if (jobs.length === 0) return
        try {
            const queue = getQueue(QUEUE_NAMES.NOTIFICATION)
            for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
                await queue.addBulk(
                    jobs.slice(i, i + BATCH_SIZE).map((data) => ({ name: 'send-notification', data })),
                )
            }
        } catch (err) {
            console.error('[PredictionSettlement] Failed to enqueue notifications:', err)
            reportError(err, { service: 'prediction-settlement', stage: 'notifications' })
        }
    }

    private static async extendLock(lock: any, marketId: string): Promise<void> {
        if (!lock?.extend) return
        try {
            await lock.extend(LOCK_TTL_MS)
        } catch (err) {
            console.error(`[PredictionSettlement] ${marketId}: lock extend failed`, err)
        }
    }

    private static async releaseLock(lock: any): Promise<void> {
        if (!lock?.unlock) return
        try {
            await lock.unlock()
        } catch {
            // The lock expires on its own; a failed unlock is not worth failing the job over.
        }
    }
}
