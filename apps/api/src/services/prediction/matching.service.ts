import { Prisma, PredictionOrderStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

/**
 * The matching engine for the binary order book.
 *
 * Every birr in the feature flows through this file, so it is written around two
 * invariants that are asserted at runtime rather than assumed:
 *
 * 1. **Every filled share escrows exactly `shareValue`.** A maker resting at `p_m`
 *    on one outcome and a taker at `p_t` on the other match only when
 *    `p_m + p_t >= shareValue`. The maker pays its own limit and the taker pays
 *    exactly `shareValue - p_m`, so the pair always contributes `shareValue` — no
 *    more (the book would owe money it does not hold) and no less (the house
 *    would be funding the difference, i.e. taking a position). The taker keeps the
 *    price improvement `p_t - (shareValue - p_m)`; it is never escrowed.
 *
 * 2. **Matching never touches a wallet.** Money left the wallet when the order was
 *    placed and now sits on the order as `reservedReal` / `reservedBonus`. A fill
 *    only moves reserve into a position's cost basis. That is what makes it safe
 *    for `placeOrder` to hold exactly ONE wallet lock — the taker's — while
 *    filling against arbitrarily many makers: a maker's wallet is not read, not
 *    locked, and not written, so no two concurrent placements can deadlock on
 *    each other's wallet rows.
 *
 * `shareValue` is per-market data, never a constant. Nothing here hardcodes 100.
 */

/** A resting order on the opposite outcome, as `planFills` needs to see it. */
export interface PredictionRestingOrder {
    id: string
    userId: string
    limitPrice: Decimal
    quantity: number
    filledQuantity: number
}

/** One intended trade. `makerPrice + takerPrice === shareValue`, always. */
export interface PredictionPlannedFill {
    makerOrderId: string
    makerUserId: string
    quantity: number
    makerPrice: Decimal
    takerPrice: Decimal
}

export interface PredictionFillPlan {
    fills: PredictionPlannedFill[]
    filledQuantity: number
    unfilledQuantity: number
}

/** The incoming order. A freshly inserted `PredictionOrder` row satisfies this. */
export interface PredictionTakerOrder {
    id: string
    marketId: string
    outcomeId: string
    userId: string
    limitPrice: Decimal
    quantity: number
    filledQuantity: number
    reservedReal: Decimal
    reservedBonus: Decimal
}

/** How much of an amount came out of real balance versus bonus balance. */
export interface PredictionFundingSplit {
    real: Decimal
    bonus: Decimal
}

export interface PredictionMatchResult {
    fills: PredictionPlannedFill[]
    filledQuantity: number
    /** Reserve moved from the taker's order into its position, by funding bucket. */
    takerConsumedReal: Decimal
    takerConsumedBonus: Decimal
}

const ZERO = new Decimal(0)

/** Money is two decimal places, everywhere in this feature. */
const MONEY_DP = 2

/**
 * Split `amount` across an order's remaining reserve in the proportion that
 * reserve is currently held.
 *
 * Deriving the proportion from the ORDER (not the wallet) is the anti-laundering
 * rule. The wallet has moved on since placement; the order still remembers that,
 * say, 30% of this money was promotional credit. Splitting consumption in the
 * ratio of the *remaining* reserve preserves the original ratio exactly — taking
 * `c·R/T` and `c·B/T` from `(R, B)` leaves `(R, B)` scaled by `1 - c/T`, the same
 * ratio — so every fill against an order carries the same funding mix as the
 * order itself.
 *
 * The rounding direction is deliberately irrelevant to safety: whatever is not
 * moved into cost basis stays on the order's reserve and is released back to the
 * same bucket, so `consumedBonus + remainingBonus === reservedBonus` to the cent
 * no matter how the halves round. Bonus can therefore never surface as real cash.
 */
export function splitAgainstReserve(
    amount: Decimal,
    reservedReal: Decimal,
    reservedBonus: Decimal,
): PredictionFundingSplit {
    const total = reservedReal.plus(reservedBonus)

    if (amount.lessThanOrEqualTo(0)) {
        return { real: ZERO, bonus: ZERO }
    }

    // A resting order is funded for its full unfilled quantity by construction. If
    // it is not, the book is short of the money it has already promised — fail the
    // placement loudly rather than issue a share nothing is backing.
    if (amount.greaterThan(total)) {
        throw new Error(
            `Prediction order reserve is short: need ${amount.toFixed(MONEY_DP)}, held ${total.toFixed(MONEY_DP)}`,
        )
    }

    // Exact consumption of the whole reserve — the common case on a final fill.
    if (amount.equals(total)) {
        return { real: reservedReal, bonus: reservedBonus }
    }

    let bonus = amount.times(reservedBonus).dividedBy(total).toDecimalPlaces(MONEY_DP, Decimal.ROUND_DOWN)
    let real = amount.minus(bonus)

    // Rounding can push at most a cent onto the real side; give it back to bonus
    // rather than let the split exceed what the order actually holds.
    if (real.greaterThan(reservedReal)) {
        real = reservedReal
        bonus = amount.minus(real)
    }

    return { real, bonus }
}

/** OPEN → PARTIALLY_FILLED → FILLED, derived from the counts rather than tracked. */
export function predictionOrderStatusFor(filledQuantity: number, quantity: number): PredictionOrderStatus {
    if (filledQuantity >= quantity) return PredictionOrderStatus.FILLED
    if (filledQuantity > 0) return PredictionOrderStatus.PARTIALLY_FILLED
    return PredictionOrderStatus.OPEN
}

export class PredictionMatchingService {
    /**
     * Plan the fills for an incoming order. PURE — no database, no clock, no I/O.
     *
     * `restingOrders` are the orders on the OPPOSITE outcome, already ordered
     * `limitPrice DESC, createdAt ASC`. That ordering is price-time priority
     * expressed in complementary prices: the most aggressive counterparty is also
     * the cheapest fill for the taker, so serving the book in order is both fair
     * and best-execution. Because the list is sorted descending, the first maker
     * that cannot pay the complement proves none of the rest can either, and the
     * walk stops there.
     *
     * The `takerPrice` recorded on each fill is `shareValue - makerPrice`, NOT the
     * taker's own limit — the taker receives the price improvement.
     */
    static planFills(
        shareValue: Decimal,
        takerPrice: Decimal,
        takerQuantity: number,
        takerUserId: string,
        restingOrders: PredictionRestingOrder[],
    ): PredictionFillPlan {
        const share = new Decimal(shareValue)
        const taker = new Decimal(takerPrice)

        if (!Number.isInteger(takerQuantity)) {
            throw new Error(`Prediction share quantities are whole: got ${takerQuantity}`)
        }
        if (takerQuantity <= 0) {
            return { fills: [], filledQuantity: 0, unfilledQuantity: 0 }
        }

        const fills: PredictionPlannedFill[] = []
        let remaining = takerQuantity

        for (const order of restingOrders) {
            if (remaining <= 0) break

            const makerPrice = new Decimal(order.limitPrice)

            // Eligibility: the two sides must together cover a whole share.
            if (makerPrice.plus(taker).lessThan(share)) break

            // No self-matching. A player trading with themselves would move their
            // own money between two of their own orders and print shares on both
            // sides of a market they cannot lose or win on net.
            if (order.userId === takerUserId) continue

            const makerRemaining = order.quantity - order.filledQuantity
            if (!Number.isInteger(makerRemaining) || makerRemaining <= 0) continue

            // A maker outside (0, shareValue) would hand someone a free share or a
            // free option. Order validation forbids it; if one is in the book the
            // book is corrupt and no fill against it is safe.
            if (makerPrice.lessThanOrEqualTo(0) || makerPrice.greaterThanOrEqualTo(share)) {
                throw new Error(
                    `Prediction order ${order.id} rests at ${makerPrice.toFixed(MONEY_DP)}, outside (0, ${share.toFixed(MONEY_DP)})`,
                )
            }

            const quantity = Math.min(remaining, makerRemaining)
            const fillTakerPrice = share.minus(makerPrice)

            // Invariant 1, asserted per fill: the pair escrows exactly one share.
            if (!fillTakerPrice.plus(makerPrice).equals(share)) {
                throw new Error(
                    `Prediction escrow broken: ${fillTakerPrice.toFixed(MONEY_DP)} + ${makerPrice.toFixed(MONEY_DP)} != ${share.toFixed(MONEY_DP)}`,
                )
            }
            // The taker never pays above its own limit — implied by eligibility,
            // checked because the consequence is charging a player more than they bid.
            if (fillTakerPrice.greaterThan(taker)) {
                throw new Error(
                    `Prediction fill would charge the taker ${fillTakerPrice.toFixed(MONEY_DP)} above its limit ${taker.toFixed(MONEY_DP)}`,
                )
            }

            fills.push({
                makerOrderId: order.id,
                makerUserId: order.userId,
                quantity,
                makerPrice,
                takerPrice: fillTakerPrice,
            })

            remaining -= quantity
        }

        return {
            fills,
            filledQuantity: takerQuantity - remaining,
            unfilledQuantity: remaining,
        }
    }

    /**
     * Apply the plan inside an EXISTING transaction — the one `placeOrder` opened
     * under the market's Redlock, holding the taker's wallet lock and nothing else.
     *
     * Writes, in order: fills, both orders' `filledQuantity`/status/reserve, both
     * sides' positions, the market's totals, and both outcomes' last price. It does
     * NOT release the taker's leftover reserve — the caller does that, because the
     * leftover is two things at once: the price improvement on the shares that
     * filled, plus the funding for the shares still resting. Only the caller knows
     * it wants to release the former and keep the latter.
     */
    static async matchOrder(
        tx: Prisma.TransactionClient,
        takerOrder: PredictionTakerOrder,
        shareValue: Decimal,
    ): Promise<PredictionMatchResult> {
        const share = new Decimal(shareValue)
        const takerPrice = new Decimal(takerOrder.limitPrice)
        const takerRemaining = takerOrder.quantity - takerOrder.filledQuantity

        const nothing: PredictionMatchResult = {
            fills: [],
            filledQuantity: 0,
            takerConsumedReal: ZERO,
            takerConsumedBonus: ZERO,
        }

        if (takerRemaining <= 0) return nothing

        // The book to match against is the other outcome of this binary market.
        // Resolving it to an id keeps the query an equality match on the hot-path
        // index [marketId, outcomeId, status, limitPrice, createdAt].
        const outcomes = await tx.predictionOutcome.findMany({
            where: { marketId: takerOrder.marketId },
            select: { id: true },
            orderBy: { sortOrder: 'asc' },
        })

        // The complement price only means anything on a two-outcome market: with
        // three sides, `shareValue - p_m` no longer covers the rest of the book and
        // a fill would escrow less than a share. Refuse rather than under-collect.
        if (outcomes.length !== 2) {
            throw new Error(
                `Prediction market ${takerOrder.marketId} has ${outcomes.length} outcomes; matching is binary`,
            )
        }
        // An order whose outcome is not on this market would be matched against a
        // book it does not belong to — its "opposite" would be a real outcome and
        // the shares issued to the taker would be unbacked.
        if (!outcomes.some((outcome) => outcome.id === takerOrder.outcomeId)) {
            throw new Error(
                `Prediction order ${takerOrder.id} is on outcome ${takerOrder.outcomeId}, which is not on market ${takerOrder.marketId}`,
            )
        }

        const opposite = outcomes.find((outcome) => outcome.id !== takerOrder.outcomeId)
        if (!opposite) return nothing

        const resting = await tx.predictionOrder.findMany({
            where: {
                marketId: takerOrder.marketId,
                outcomeId: opposite.id,
                status: { in: [PredictionOrderStatus.OPEN, PredictionOrderStatus.PARTIALLY_FILLED] },
                // makerPrice >= shareValue - takerPrice is the eligibility rule,
                // pushed into SQL so a deep book is not read to be discarded.
                limitPrice: { gte: share.minus(takerPrice) },
                userId: { not: takerOrder.userId },
            },
            orderBy: [{ limitPrice: 'desc' }, { createdAt: 'asc' }],
        })
        if (resting.length === 0) return nothing

        const restingById = new Map(resting.map((order) => [order.id, order]))

        const plan = PredictionMatchingService.planFills(
            share,
            takerPrice,
            takerRemaining,
            takerOrder.userId,
            resting.map((order) => ({
                id: order.id,
                userId: order.userId,
                limitPrice: new Decimal(order.limitPrice),
                quantity: order.quantity,
                filledQuantity: order.filledQuantity,
            })),
        )
        if (plan.fills.length === 0) return nothing

        let takerReserveReal = new Decimal(takerOrder.reservedReal)
        let takerReserveBonus = new Decimal(takerOrder.reservedBonus)
        let takerConsumedReal = ZERO
        let takerConsumedBonus = ZERO
        let makerConsumed = ZERO

        // A maker may rest several orders on this side; fold them into one position
        // write per user so the same row is not upserted repeatedly.
        const makerPositions = new Map<string, { shares: number; real: Decimal; bonus: Decimal }>()
        const fillRows: Prisma.PredictionFillCreateManyInput[] = []

        for (const fill of plan.fills) {
            const maker = restingById.get(fill.makerOrderId)
            if (!maker) {
                throw new Error(`Prediction fill references unknown resting order ${fill.makerOrderId}`)
            }

            // ── Maker side. The wallet is not touched: this money left it at
            //    placement. Reserve simply becomes cost basis.
            const makerCost = fill.makerPrice.times(fill.quantity)
            const makerSplit = splitAgainstReserve(
                makerCost,
                new Decimal(maker.reservedReal),
                new Decimal(maker.reservedBonus),
            )
            const makerFilled = maker.filledQuantity + fill.quantity

            // Optimistic guard: the update only lands if the order is still exactly
            // as it was read. Under the per-market Redlock nothing else should be
            // matching this book, so a miss means an assumption is wrong — abort the
            // transaction rather than oversell an order that someone else just filled.
            const written = await tx.predictionOrder.updateMany({
                where: {
                    id: maker.id,
                    filledQuantity: maker.filledQuantity,
                    status: { in: [PredictionOrderStatus.OPEN, PredictionOrderStatus.PARTIALLY_FILLED] },
                },
                data: {
                    filledQuantity: makerFilled,
                    status: predictionOrderStatusFor(makerFilled, maker.quantity),
                    reservedReal: new Decimal(maker.reservedReal).minus(makerSplit.real),
                    reservedBonus: new Decimal(maker.reservedBonus).minus(makerSplit.bonus),
                },
            })
            if (written.count !== 1) {
                // 409, not 500: the order itself was valid and the player can
                // simply place it again. This is only reachable if two matchers
                // ran on one book — a lock that expired under the transaction —
                // so reporting it as the player's server error would be a lie.
                throw Object.assign(
                    new Error(`Prediction order ${maker.id} changed during matching`),
                    { statusCode: 409 },
                )
            }

            const position = makerPositions.get(maker.userId) ?? { shares: 0, real: ZERO, bonus: ZERO }
            position.shares += fill.quantity
            position.real = position.real.plus(makerSplit.real)
            position.bonus = position.bonus.plus(makerSplit.bonus)
            makerPositions.set(maker.userId, position)
            makerConsumed = makerConsumed.plus(makerCost)

            // ── Taker side. Same move, against the reserve tracked in memory: the
            //    taker's row is written once, after the walk.
            const takerCost = fill.takerPrice.times(fill.quantity)
            const takerSplit = splitAgainstReserve(takerCost, takerReserveReal, takerReserveBonus)
            takerReserveReal = takerReserveReal.minus(takerSplit.real)
            takerReserveBonus = takerReserveBonus.minus(takerSplit.bonus)
            takerConsumedReal = takerConsumedReal.plus(takerSplit.real)
            takerConsumedBonus = takerConsumedBonus.plus(takerSplit.bonus)

            fillRows.push({
                marketId: takerOrder.marketId,
                quantity: fill.quantity,
                takerOrderId: takerOrder.id,
                makerOrderId: maker.id,
                takerOutcomeId: takerOrder.outcomeId,
                makerOutcomeId: maker.outcomeId,
                takerPrice: fill.takerPrice,
                makerPrice: fill.makerPrice,
            })
        }

        // Invariant 1 again, over the whole batch: what the two sides paid is
        // exactly what the market now owes the winning side.
        const escrowed = makerConsumed.plus(takerConsumedReal).plus(takerConsumedBonus)
        const expected = share.times(plan.filledQuantity)
        if (!escrowed.equals(expected)) {
            throw new Error(
                `Prediction escrow mismatch: collected ${escrowed.toFixed(MONEY_DP)} for ${plan.filledQuantity} shares, expected ${expected.toFixed(MONEY_DP)}`,
            )
        }

        await tx.predictionFill.createMany({ data: fillRows })

        const takerFilled = takerOrder.filledQuantity + plan.filledQuantity
        await tx.predictionOrder.update({
            where: { id: takerOrder.id },
            data: {
                filledQuantity: takerFilled,
                status: predictionOrderStatusFor(takerFilled, takerOrder.quantity),
                reservedReal: takerReserveReal,
                reservedBonus: takerReserveBonus,
            },
        })

        for (const [userId, position] of makerPositions) {
            await tx.predictionPosition.upsert({
                where: {
                    marketId_outcomeId_userId: {
                        marketId: takerOrder.marketId,
                        outcomeId: opposite.id,
                        userId,
                    },
                },
                create: {
                    marketId: takerOrder.marketId,
                    outcomeId: opposite.id,
                    userId,
                    shares: position.shares,
                    costBasisReal: position.real,
                    costBasisBonus: position.bonus,
                },
                update: {
                    shares: { increment: position.shares },
                    costBasisReal: { increment: position.real },
                    costBasisBonus: { increment: position.bonus },
                },
            })
        }

        await tx.predictionPosition.upsert({
            where: {
                marketId_outcomeId_userId: {
                    marketId: takerOrder.marketId,
                    outcomeId: takerOrder.outcomeId,
                    userId: takerOrder.userId,
                },
            },
            create: {
                marketId: takerOrder.marketId,
                outcomeId: takerOrder.outcomeId,
                userId: takerOrder.userId,
                shares: plan.filledQuantity,
                costBasisReal: takerConsumedReal,
                costBasisBonus: takerConsumedBonus,
            },
            update: {
                shares: { increment: plan.filledQuantity },
                costBasisReal: { increment: takerConsumedReal },
                costBasisBonus: { increment: takerConsumedBonus },
            },
        })

        // `totalVolume` is escrow, so it grows by a whole share per matched pair —
        // not by what either side individually paid.
        await tx.predictionMarket.update({
            where: { id: takerOrder.marketId },
            data: {
                totalShares: { increment: plan.filledQuantity },
                totalVolume: { increment: expected },
            },
        })

        // Last trade on each side. The two are complements of one another, which is
        // what lets the UI quote either outcome from a single book.
        const lastFill = plan.fills[plan.fills.length - 1]!
        await tx.predictionOutcome.update({
            where: { id: takerOrder.outcomeId },
            data: { lastPrice: lastFill.takerPrice },
        })
        await tx.predictionOutcome.update({
            where: { id: opposite.id },
            data: { lastPrice: lastFill.makerPrice },
        })

        return {
            fills: plan.fills,
            filledQuantity: plan.filledQuantity,
            takerConsumedReal,
            takerConsumedBonus,
        }
    }
}
