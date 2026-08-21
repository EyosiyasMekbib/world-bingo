import Redlock from 'redlock'
import {
    PaymentStatus,
    PredictionMarketStatus,
    PredictionOrderStatus,
    Prisma,
    TransactionType,
    UserRole,
} from '@prisma/client'
import { priceSchema, toWholeBirr } from '@world-bingo/shared-types'
import prisma from '../../lib/prisma.js'
import redis from '../../lib/redis.js'
import { PredictionMatchingService, splitAgainstReserve } from './matching.service.js'
import { emitBook, emitTrade } from '../../gateways/prediction.gateway.js'
import { BonusService, type SpendBonusResult } from '../bonus.service.js'

/**
 * Order placement, cancellation and reserve accounting for the binary order book.
 *
 * THE MONEY RULE, stated once: a player's money leaves the wallet when the order is
 * PLACED, not when it fills. A resting order is therefore always fully funded, which is
 * what lets the matching engine move a maker's money into a position without ever
 * touching that maker's wallet — and is why exactly one wallet row (the taker's) is
 * locked per placement and the book cannot deadlock.
 *
 * `shareValue` is a per-market column, never a constant. Every bound and every escrow
 * figure below is computed from `market.shareValue` read inside the transaction.
 */

/**
 * How long the per-market match lock is held.
 *
 * It MUST outlive the transaction it guards, or the key expires while a match is
 * still walking the book and a second placement starts matching the same resting
 * orders. The transaction budget is `TX_MAX_WAIT_MS` waiting for a pool
 * connection plus `TX_TIMEOUT_MS` executing, so the TTL is set above their sum
 * with room to spare.
 */
const TX_TIMEOUT_MS = 20_000
const TX_MAX_WAIT_MS = 15_000
const LOCK_TTL_MS = TX_TIMEOUT_MS + TX_MAX_WAIT_MS + 5_000

/** Wait for the lock rather than failing: orders queue behind each other per market. */
const redlock = new Redlock([redis as any], {
    retryCount: 50,
    retryDelay: 200,
    retryJitter: 100,
    driftFactor: 0.01,
})

redlock.on('error', (err: Error) => {
    if (!err.message?.includes('lock')) {
        console.error('[PredictionOrder] Redlock error:', err)
    }
})

const matchLockKey = (marketId: string) => `lock:prediction:match:${marketId}`

const ZERO = new Prisma.Decimal(0)

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

export interface PlaceOrderInput {
    marketId: string
    /** Whole birr. A number off the wire, or its decimal string — never a float amount. */
    limitPrice: number | string
    outcomeId: string
    quantity: number
}

export interface OrderListFilter {
    status?: PredictionOrderStatus | PredictionOrderStatus[]
    marketId?: string
    outcomeId?: string
    userId?: string
    limit?: number
    cursor?: string
}

function httpError(message: string, statusCode: number): Error {
    return Object.assign(new Error(message), { statusCode })
}

interface LockedWallet {
    id: string
    real: Prisma.Decimal
    bonus: Prisma.Decimal
    spendAccount: 'REAL' | 'BONUS'
}

/**
 * Looks up the expiry `BonusService.spend` stamped on this order's original hold,
 * so a release restores it rather than granting a fresh window. Falls back to
 * null (never-expiring) if the hold predates this column (defensive only —
 * every hold created after Task 16 ships has one) or if the order was funded
 * entirely from real and never held a bonus reserve at all.
 */
async function originalHoldExpiry(
    tx: Prisma.TransactionClient,
    userId: string,
    orderId: string,
): Promise<Date | null> {
    const hold = await tx.transaction.findFirst({
        where: { userId, type: TransactionType.PREDICTION_ORDER_HOLD, note: { contains: orderId } },
        select: { bonusExpiresAtSpend: true },
    })
    return hold?.bonusExpiresAtSpend ?? null
}

async function lockWallet(tx: Prisma.TransactionClient, userId: string): Promise<LockedWallet> {
    const wallets = await tx.$queryRaw<
        Array<{
            id: string
            realBalance: Prisma.Decimal
            bonusBalance: Prisma.Decimal
            spendAccount: 'REAL' | 'BONUS'
        }>
    >`
        SELECT id, "realBalance", "bonusBalance", "spendAccount" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
    `
    const wallet = wallets[0]
    if (!wallet) throw httpError('Wallet not found', 404)

    return {
        id: wallet.id,
        real: new Prisma.Decimal(wallet.realBalance),
        bonus: new Prisma.Decimal(wallet.bonusBalance),
        spendAccount: wallet.spendAccount,
    }
}

/**
 * Run `fn` under the market's match lock.
 *
 * redlock@4 puts `unlock` and `extend` on `Lock.prototype`; `release` lives only
 * on the Redlock CLIENT. Calling `lock.release()` here would throw a TypeError
 * out of the `finally` AFTER the transaction had already committed, replacing
 * the return value with a 500 and leaving the key to expire on its own — the
 * player charged, the order live, and the market wedged for the whole TTL.
 *
 * The release is therefore `unlock`, and it is wrapped: a genuine LockError from
 * the release path must never mask a placement that has already committed.
 */
async function withMarketLock<T>(marketId: string, fn: () => Promise<T>): Promise<T> {
    const lock = await redlock.acquire([matchLockKey(marketId)], LOCK_TTL_MS)
    try {
        return await fn()
    } finally {
        try {
            await lock.unlock()
        } catch {
            // The key expires on its own; a failed unlock is not worth failing on.
        }
    }
}

function clampLimit(limit?: number): number {
    if (!limit || !Number.isFinite(limit) || limit < 1) return DEFAULT_PAGE_SIZE
    return Math.min(Math.floor(limit), MAX_PAGE_SIZE)
}

function statusFilter(
    status?: PredictionOrderStatus | PredictionOrderStatus[],
): Prisma.PredictionOrderWhereInput['status'] {
    if (!status) return undefined
    return Array.isArray(status) ? { in: status } : status
}

async function listOrders(where: Prisma.PredictionOrderWhereInput, filter: OrderListFilter) {
    const limit = clampLimit(filter.limit)

    const rows = await prisma.predictionOrder.findMany({
        where,
        include: { market: true, outcome: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(filter.cursor ? { skip: 1, cursor: { id: filter.cursor } } : {}),
    })

    const hasMore = rows.length > limit
    const orders = hasMore ? rows.slice(0, limit) : rows

    return {
        orders,
        nextCursor: hasMore ? orders[orders.length - 1].id : null,
    }
}

export class PredictionOrderService {
    /**
     * Places a buy-only limit order and matches it against the book.
     *
     * One Redlock on the market, one transaction, one wallet lock — see the ordering
     * comment inside. Returns the order in its post-match state, the fills it generated
     * and the caller's resulting balances.
     */
    static async placeOrder(userId: string, input: PlaceOrderInput) {
        const { marketId, outcomeId } = input

        const result = await withMarketLock(marketId, () =>
            prisma.$transaction(
                async (tx) => {
                    // ── 0. Staff may not trade ───────────────────────────────────
                    // The same people who resolve a market can otherwise take a
                    // position in it, and resolution is a judgement call on a video
                    // for the novelty markets. An audit log proves what an admin
                    // decided; it cannot prove they had no stake in the outcome.
                    // Refusing the order is the only version of that guarantee that
                    // does not depend on trust.
                    //
                    // Enforced here rather than in the route so every caller is
                    // covered, and stated as "only PLAYER may trade" rather than a
                    // list of banned roles — a role added later is then blocked by
                    // default instead of silently permitted.
                    const trader = await tx.user.findUnique({
                        where: { id: userId },
                        select: { role: true },
                    })
                    if (!trader) throw httpError('User not found', 404)
                    if (trader.role !== UserRole.PLAYER) {
                        throw httpError('Staff accounts cannot trade prediction markets', 403)
                    }

                    // ── 1. Lock the taker's wallet ───────────────────────────────
                    // The only wallet touched by a placement. Makers were funded when
                    // they placed; matching moves their reserve into a position.
                    const wallet = await lockWallet(tx, userId)

                    // ── 2. Re-read the market inside the transaction ─────────────
                    const market = await tx.predictionMarket.findUnique({
                        where: { id: marketId },
                        select: {
                            id: true,
                            status: true,
                            closesAt: true,
                            shareValue: true,
                            minOrderShares: true,
                            maxOrderShares: true,
                        },
                    })
                    if (!market) throw httpError('Market not found', 404)
                    if (market.status !== PredictionMarketStatus.OPEN) {
                        throw httpError('This market is not open for orders', 409)
                    }
                    if (new Date() >= market.closesAt) {
                        throw httpError('This market has closed', 409)
                    }

                    // ── 3. The outcome must belong to this market ────────────────
                    // Both sides are read here: the other one is the book this order
                    // matches against, and naming it now saves the post-match code a
                    // second query to label the maker half of each trade.
                    const outcomes = await tx.predictionOutcome.findMany({
                        where: { marketId },
                        select: { id: true },
                        orderBy: { sortOrder: 'asc' },
                    })
                    if (!outcomes.some((row) => row.id === outcomeId)) {
                        throw httpError('Outcome does not belong to this market', 400)
                    }
                    const oppositeOutcomeId = outcomes.find((row) => row.id !== outcomeId)?.id

                    // ── 4. Validate against the market's OWN shareValue ──────────
                    // 1 <= limitPrice <= shareValue - 1, whole 1 ETB ticks. `toWholeBirr`
                    // parses the integer digits as text, so an off-tick price like 35.50
                    // is rejected without ever becoming a float.
                    let priceBirr: number
                    try {
                        priceBirr = toWholeBirr(input.limitPrice)
                    } catch {
                        throw httpError('Price must be a whole number of 1 ETB ticks', 400)
                    }

                    let priceRule: ReturnType<typeof priceSchema>
                    try {
                        priceRule = priceSchema(market.shareValue.toString())
                    } catch (err) {
                        throw httpError((err as Error).message, 400)
                    }

                    const parsedPrice = priceRule.safeParse(priceBirr)
                    if (!parsedPrice.success) {
                        throw httpError(parsedPrice.error.issues[0].message, 400)
                    }

                    const quantity = input.quantity
                    if (!Number.isInteger(quantity) || quantity < 1) {
                        throw httpError('Quantity must be a whole number of shares', 400)
                    }
                    if (quantity < market.minOrderShares) {
                        throw httpError(
                            `Minimum order size is ${market.minOrderShares} share(s)`,
                            400,
                        )
                    }
                    if (quantity > market.maxOrderShares) {
                        throw httpError(
                            `Maximum order size is ${market.maxOrderShares} share(s)`,
                            400,
                        )
                    }

                    // ── 5. Reserve limitPrice × quantity from the selected account ──
                    const limitPrice = new Prisma.Decimal(priceBirr)
                    const reserve = limitPrice.times(quantity)

                    let reservedReal = new Prisma.Decimal(0)
                    let reservedBonus = new Prisma.Decimal(0)
                    let realAfterHold = wallet.real
                    let bonusAfterHold = wallet.bonus
                    let spendResult: SpendBonusResult | undefined

                    if (wallet.spendAccount === 'BONUS') {
                        spendResult = await BonusService.spend(tx, userId, reserve)
                        reservedBonus = reserve
                        bonusAfterHold = spendResult.bonusBalanceAfter
                    } else {
                        if (wallet.real.lessThan(reserve)) {
                            throw httpError('Insufficient funds', 400)
                        }
                        reservedReal = reserve
                        realAfterHold = wallet.real.minus(reserve)
                        await tx.wallet.update({ where: { userId }, data: { realBalance: realAfterHold } })
                    }

                    // ── 6. Insert the order + the hold transaction ───────────────
                    const order = await tx.predictionOrder.create({
                        data: {
                            marketId,
                            outcomeId,
                            userId,
                            limitPrice,
                            quantity,
                            reservedReal,
                            reservedBonus,
                            status: PredictionOrderStatus.OPEN,
                        },
                    })

                    await tx.transaction.create({
                        data: {
                            userId,
                            type: TransactionType.PREDICTION_ORDER_HOLD,
                            amount: reserve,
                            status: PaymentStatus.APPROVED,
                            referenceId: marketId,
                            note: `Prediction order ${order.id}`,
                            balanceBefore: wallet.real,
                            balanceAfter: realAfterHold,
                            bonusBalanceBefore: wallet.bonus,
                            bonusBalanceAfter: bonusAfterHold,
                            bonusExpiresAtSpend:
                                wallet.spendAccount === 'BONUS' ? spendResult!.soonestExpiryConsumed : null,
                        },
                    })

                    // ── 7. Match against the opposing side of the book ───────────
                    // Matching moves consumed reserve off this order and into both
                    // sides' positions. It writes no wallet — the makers' money left
                    // their wallets when they placed.
                    const match = await PredictionMatchingService.matchOrder(
                        tx,
                        order,
                        market.shareValue,
                    )

                    // ── 8. Release the reserve the fills did not consume ─────────
                    // Two different things are still held on this order:
                    //
                    //   remaining reserve = limitPrice × unfilled   ← funds the resting
                    //                                                 part, stays held
                    //                     + price improvement       ← released now
                    //
                    // A maker pays its own limit, so the taker pays `shareValue -
                    // makerPrice`, at or below its own limit; the gap is the taker's
                    // improvement on the shares that ACTUALLY FILLED. An order that did
                    // not fill at all therefore releases nothing — its whole reserve
                    // still backs the resting order until it fills or is cancelled.
                    const consumed = match.takerConsumedReal.plus(match.takerConsumedBonus)
                    const heldReal = reservedReal.minus(match.takerConsumedReal)
                    const heldBonus = reservedBonus.minus(match.takerConsumedBonus)
                    const improvement = limitPrice.times(match.filledQuantity).minus(consumed)

                    if (improvement.lessThan(0)) {
                        // The taker was charged above its own limit, which would also
                        // leave the resting part under-funded (the two are the same
                        // quantity). A solvency break — fail rather than book it.
                        throw httpError('Order matched above its limit price', 500)
                    }

                    let realFinal = realAfterHold
                    let bonusFinal = bonusAfterHold

                    if (improvement.greaterThan(0)) {
                        // Release in the proportion the reserve is STILL held in, which
                        // is the proportion it was reserved in — bonus money must come
                        // back as bonus or promotional credit becomes withdrawable cash.
                        const released = splitAgainstReserve(improvement, heldReal, heldBonus)
                        realFinal = realAfterHold.plus(released.real)
                        bonusFinal = bonusAfterHold.plus(released.bonus)

                        // Real returns as a plain wallet credit; bonus returns through
                        // `BonusService.restore` so it lands in a lot carrying the SAME
                        // expiry the original hold consumed, rather than a fresh window
                        // — and, critically, in an actual `BonusGrant` lot rather than a
                        // raw balance bump with no lot backing it, which would mint
                        // unspendable bonus and permanently trip reconcile(). Mirrors
                        // `cancelOrder`'s release, exactly.
                        if (released.real.greaterThan(0)) {
                            await tx.wallet.update({ where: { userId }, data: { realBalance: realFinal } })
                        }
                        if (released.bonus.greaterThan(0)) {
                            const expiry = await originalHoldExpiry(tx, userId, order.id)
                            await BonusService.restore(tx, userId, released.bonus, expiry)
                        }

                        // The order must forget what it just gave back, or a later
                        // cancellation would refund the improvement a second time.
                        await tx.predictionOrder.update({
                            where: { id: order.id },
                            data: {
                                reservedReal: heldReal.minus(released.real),
                                reservedBonus: heldBonus.minus(released.bonus),
                            },
                        })

                        await tx.transaction.create({
                            data: {
                                userId,
                                type: TransactionType.PREDICTION_ORDER_RELEASE,
                                amount: improvement,
                                status: PaymentStatus.APPROVED,
                                referenceId: marketId,
                                note: `Price improvement on prediction order ${order.id}`,
                                balanceBefore: realAfterHold,
                                balanceAfter: realFinal,
                                bonusBalanceBefore: bonusAfterHold,
                                bonusBalanceAfter: bonusFinal,
                            },
                        })
                    }

                    // One trade event per side of every fill — the two sides trade at
                    // complementary prices summing to shareValue.
                    const trades: Array<{
                        outcomeId: string
                        price: Prisma.Decimal
                        quantity: number
                    }> = []

                    for (const fill of match.fills) {
                        trades.push({
                            outcomeId,
                            price: fill.takerPrice,
                            quantity: fill.quantity,
                        })
                        if (oppositeOutcomeId) {
                            trades.push({
                                outcomeId: oppositeOutcomeId,
                                price: fill.makerPrice,
                                quantity: fill.quantity,
                            })
                        }
                    }

                    const finalOrder = await tx.predictionOrder.findUnique({
                        where: { id: order.id },
                        include: { market: true, outcome: true },
                    })

                    return {
                        order: finalOrder!,
                        fills: match.fills,
                        trades,
                        realBalance: realFinal,
                        bonusBalance: bonusFinal,
                    }
                },
                { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS },
            ),
        )

        // ── Post-commit broadcasts ───────────────────────────────────────────────
        try {
            for (const trade of result.trades) {
                emitTrade(marketId, trade.outcomeId, trade.price, trade.quantity)
            }
            emitBook(marketId)
        } catch (err) {
            console.error(`[PredictionOrder] broadcast failed for market ${marketId}:`, err)
        }

        return {
            order: result.order,
            fills: result.fills,
            realBalance: result.realBalance,
            bonusBalance: result.bonusBalance,
        }
    }

    /**
     * Cancels an unfilled or partially filled order and returns the reserve still held
     * against it. Filled shares are untouched — those are positions now, and they are
     * released only by settlement or a void.
     */
    static async cancelOrder(userId: string, orderId: string) {
        const existing = await prisma.predictionOrder.findUnique({
            where: { id: orderId },
            select: { marketId: true },
        })
        if (!existing) throw httpError('Order not found', 404)

        const marketId = existing.marketId

        const result = await withMarketLock(marketId, () =>
            prisma.$transaction(async (tx) => {
                const wallet = await lockWallet(tx, userId)

                const order = await tx.predictionOrder.findUnique({
                    where: { id: orderId },
                    include: { market: { select: { id: true, status: true } } },
                })
                if (!order) throw httpError('Order not found', 404)
                if (order.userId !== userId) throw httpError('This order is not yours', 403)
                if (
                    order.status !== PredictionOrderStatus.OPEN &&
                    order.status !== PredictionOrderStatus.PARTIALLY_FILLED
                ) {
                    throw httpError('This order can no longer be cancelled', 409)
                }
                if (order.market.status !== PredictionMarketStatus.OPEN) {
                    throw httpError('This market is not open for orders', 409)
                }

                const unfilled = order.quantity - order.filledQuantity
                if (unfilled <= 0) {
                    throw httpError('This order can no longer be cancelled', 409)
                }

                // `reservedReal`/`reservedBonus` are the reserve STILL HELD, not the
                // placement figures: every fill decrements them by what it moved into
                // the position's cost basis, and any price improvement was released at
                // placement. So the invariant on a live order is
                //
                //     reservedReal + reservedBonus === limitPrice × unfilled
                //
                // and cancelling releases exactly that — the unfilled reserve, in the
                // buckets it is held in, never a birr more. Bonus returns as bonus.
                // Filled shares are untouched: they are positions now.
                const releasedReal = new Prisma.Decimal(order.reservedReal)
                const releasedBonus = new Prisma.Decimal(order.reservedBonus)
                const refund = releasedReal.plus(releasedBonus)

                if (refund.greaterThan(new Prisma.Decimal(order.limitPrice).times(unfilled))) {
                    // More is held than the unfilled shares can justify — the order's
                    // accounting has drifted. Refuse rather than pay out the difference.
                    throw httpError('Order reserve is inconsistent', 500)
                }

                const realAfter = wallet.real.plus(releasedReal)
                const bonusAfter = wallet.bonus.plus(releasedBonus)

                if (refund.greaterThan(0)) {
                    // Real returns as a plain wallet credit; bonus returns through
                    // `BonusService.restore` so it lands in a lot carrying the SAME
                    // expiry the original hold consumed, rather than a fresh window
                    // — otherwise a cancel would let a player launder an
                    // about-to-expire bonus into a longer-lived one.
                    if (releasedReal.greaterThan(0)) {
                        await tx.wallet.update({ where: { userId }, data: { realBalance: realAfter } })
                    }
                    if (releasedBonus.greaterThan(0)) {
                        const expiry = await originalHoldExpiry(tx, userId, order.id)
                        await BonusService.restore(tx, userId, releasedBonus, expiry)
                    }

                    await tx.transaction.create({
                        data: {
                            userId,
                            type: TransactionType.PREDICTION_ORDER_RELEASE,
                            amount: refund,
                            status: PaymentStatus.APPROVED,
                            referenceId: marketId,
                            note: `Cancelled prediction order ${order.id}`,
                            balanceBefore: wallet.real,
                            balanceAfter: realAfter,
                            bonusBalanceBefore: wallet.bonus,
                            bonusBalanceAfter: bonusAfter,
                        },
                    })
                }

                const cancelled = await tx.predictionOrder.update({
                    where: { id: order.id },
                    data: {
                        status: PredictionOrderStatus.CANCELLED,
                        reservedReal: ZERO,
                        reservedBonus: ZERO,
                    },
                    include: { market: true, outcome: true },
                })

                return {
                    order: cancelled,
                    refunded: refund,
                    realBalance: realAfter,
                    bonusBalance: bonusAfter,
                }
            }),
        )

        try {
            emitBook(marketId)
        } catch (err) {
            console.error(`[PredictionOrder] broadcast failed for market ${marketId}:`, err)
        }

        return result
    }

    /** A player's own orders, newest first, cursor paginated. */
    static async listUserOrders(userId: string, filter: OrderListFilter = {}) {
        const where: Prisma.PredictionOrderWhereInput = { userId }
        if (filter.marketId) where.marketId = filter.marketId
        if (filter.outcomeId) where.outcomeId = filter.outcomeId

        const status = statusFilter(filter.status)
        if (status) where.status = status

        return listOrders(where, filter)
    }

    /** Every order on a market, newest first, cursor paginated. Admin-facing. */
    static async listMarketOrders(marketId: string, filter: OrderListFilter = {}) {
        const where: Prisma.PredictionOrderWhereInput = { marketId }
        if (filter.userId) where.userId = filter.userId
        if (filter.outcomeId) where.outcomeId = filter.outcomeId

        const status = statusFilter(filter.status)
        if (status) where.status = status

        return listOrders(where, filter)
    }
}

export default PredictionOrderService
