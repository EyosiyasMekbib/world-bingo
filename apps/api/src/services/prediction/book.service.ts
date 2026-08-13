/**
 * Prediction Book Service — aggregated depth and last-price reads.
 *
 * The book is derived, never stored: a level is just the resting orders on one
 * outcome at one price, summed. Aggregation happens in Postgres (`groupBy`)
 * rather than by pulling orders into Node, because a busy main-event book is
 * thousands of rows and this is the read every socket client refreshes on.
 *
 * Money is a `Decimal` in the database and a decimal *string* on the wire — see
 * `@world-bingo/shared-types` `prediction/common.ts`. Nothing here converts a
 * price to a JS number. Share counts are integers by construction, so
 * `Σ quantity − Σ filledQuantity` is exact integer arithmetic, not money math.
 *
 * Nothing here reads a hardcoded 100: `shareValue` is carried on the market and
 * returned with the book so a client can size a ticket without a second fetch.
 */

import type { PredictionOrderStatus } from '@prisma/client'
import prisma from '../../lib/prisma.js'
import type {
    PredictionBookLevel,
    PredictionFillDto,
    PredictionMarketBook,
    PredictionOutcomeBook,
    PredictionPriceHistory,
} from '@world-bingo/shared-types'

/** An order still has unfilled shares resting in the book in exactly these states. */
const RESTING_STATUSES: PredictionOrderStatus[] = ['OPEN', 'PARTIALLY_FILLED']

const DEFAULT_FILL_LIMIT = 50

/**
 * Ceiling on price-history points. Beyond this the series is evenly thinned so
 * the payload stays bounded no matter how much a market trades; the shape of the
 * line survives because the sampling is uniform and the endpoints are pinned.
 */
const MAX_HISTORY_POINTS = 500

/**
 * Even down-sampling that always keeps the first and last element, so the line
 * still spans the true time range. Returns the input untouched at or below the
 * cap. Not money math — it only ever selects existing points, never averages
 * prices, so no Decimal is combined or rounded here.
 */
function downsample<T>(items: T[], cap: number): T[] {
    if (items.length <= cap) return items
    const out: T[] = []
    const step = (items.length - 1) / (cap - 1)
    for (let i = 0; i < cap; i++) {
        out.push(items[Math.round(i * step)]!)
    }
    return out
}
const MAX_FILL_LIMIT = 200

export class PredictionBookService {
    /**
     * Full depth for both sides of a market, plus each outcome's last traded
     * price and the market's own share value.
     *
     * Levels are best price first — highest `limitPrice` first, which is the
     * most aggressive counterparty and therefore the first order a taker would
     * match against (see the matching service's price-time priority).
     */
    static async getBook(marketId: string): Promise<PredictionMarketBook> {
        const market = await prisma.predictionMarket.findUnique({
            where: { id: marketId },
            select: {
                id: true,
                shareValue: true,
                outcomes: {
                    select: { id: true, lastPrice: true },
                    orderBy: { sortOrder: 'asc' },
                },
            },
        })

        if (!market) throw new Error('Market not found')

        const levels = await this.aggregateLevels(marketId)

        return {
            marketId: market.id,
            shareValue: market.shareValue.toString(),
            outcomes: market.outcomes.map((outcome) => ({
                outcomeId: outcome.id,
                lastPrice: outcome.lastPrice ? outcome.lastPrice.toString() : null,
                levels: levels.get(outcome.id) ?? [],
            })),
        }
    }

    /** One side of the book. Same aggregation, filtered to a single outcome. */
    static async getDepth(marketId: string, outcomeId: string): Promise<PredictionOutcomeBook> {
        // findFirst on (id, marketId) so an outcome id from another market cannot
        // be used to read depth under the wrong market.
        const outcome = await prisma.predictionOutcome.findFirst({
            where: { id: outcomeId, marketId },
            select: { id: true, lastPrice: true },
        })

        if (!outcome) throw new Error('Outcome not found')

        const levels = await this.aggregateLevels(marketId, outcomeId)

        return {
            outcomeId: outcome.id,
            lastPrice: outcome.lastPrice ? outcome.lastPrice.toString() : null,
            levels: levels.get(outcome.id) ?? [],
        }
    }

    /** The tape: most recent fills first. */
    static async getRecentFills(marketId: string, limit = DEFAULT_FILL_LIMIT): Promise<PredictionFillDto[]> {
        const take = Number.isFinite(limit) && limit >= 1
            ? Math.min(Math.trunc(limit), MAX_FILL_LIMIT)
            : DEFAULT_FILL_LIMIT

        const fills = await prisma.predictionFill.findMany({
            where: { marketId },
            // id breaks ties so two fills written in the same transaction come
            // back in a stable order rather than an arbitrary one.
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
        })

        return fills.map((fill) => ({
            id: fill.id,
            marketId: fill.marketId,
            quantity: fill.quantity,
            takerOrderId: fill.takerOrderId,
            makerOrderId: fill.makerOrderId,
            takerOutcomeId: fill.takerOutcomeId,
            makerOutcomeId: fill.makerOutcomeId,
            takerPrice: fill.takerPrice.toString(),
            makerPrice: fill.makerPrice.toString(),
            createdAt: fill.createdAt.toISOString(),
        }))
    }

    /**
     * The price trajectory for a probability-over-time chart.
     *
     * One point per fill, time-ascending. The line tracks the FIRST outcome
     * (`sortOrder` 0); the market is binary, so the second outcome is always
     * `shareValue - price` and drawing it would be a redundant mirror. For each
     * fill, that outcome's price is whichever side of the trade it was on:
     * `takerPrice` when it was the taker, `makerPrice` otherwise — and the two
     * always sum to `shareValue`, so exactly one of them is the reference price.
     *
     * A market with no fills returns an empty series. That is a real state (no
     * one has traded yet), rendered as an empty plot rather than treated as an
     * error. Beyond `MAX_HISTORY_POINTS` the series is evenly downsampled so a
     * runaway-volume market cannot ship an unbounded payload; the first and last
     * points are always kept so the line still spans the true time range.
     */
    static async getPriceHistory(marketId: string): Promise<PredictionPriceHistory> {
        const market = await prisma.predictionMarket.findUnique({
            where: { id: marketId },
            select: {
                id: true,
                shareValue: true,
                outcomes: {
                    select: { id: true, label: true },
                    orderBy: { sortOrder: 'asc' },
                    take: 1,
                },
            },
        })

        if (!market) throw new Error('Market not found')

        const reference = market.outcomes[0]
        if (!reference) throw new Error('Market has no outcomes')

        const fills = await prisma.predictionFill.findMany({
            where: { marketId },
            select: {
                createdAt: true,
                quantity: true,
                takerOutcomeId: true,
                takerPrice: true,
                makerPrice: true,
            },
            // Ascending so the client plots left-to-right without re-sorting; id
            // breaks ties for fills written in the same transaction.
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })

        const points = downsample(fills, MAX_HISTORY_POINTS).map((fill) => ({
            t: fill.createdAt.toISOString(),
            // The reference outcome's price at this fill. Whichever side it took,
            // its price + the counterparty's price is exactly one share.
            price: (fill.takerOutcomeId === reference.id
                ? fill.takerPrice
                : fill.makerPrice
            ).toString(),
            shares: fill.quantity,
        }))

        return {
            marketId: market.id,
            outcomeId: reference.id,
            outcomeLabel: reference.label,
            shareValue: market.shareValue.toString(),
            points,
        }
    }

    /**
     * `(outcomeId, limitPrice) -> unfilled shares`, grouped in the database.
     *
     * `Σ(quantity − filledQuantity)` is not expressible in a Prisma `groupBy`,
     * but it equals `Σ quantity − Σ filledQuantity`, and both of those are.
     * Fully-filled and cancelled orders are excluded by the status filter, so a
     * level only ever reports shares that are genuinely still takeable.
     */
    private static async aggregateLevels(
        marketId: string,
        outcomeId?: string,
    ): Promise<Map<string, PredictionBookLevel[]>> {
        const rows = await prisma.predictionOrder.groupBy({
            by: ['outcomeId', 'limitPrice'],
            where: {
                marketId,
                status: { in: RESTING_STATUSES },
                ...(outcomeId ? { outcomeId } : {}),
            },
            _sum: { quantity: true, filledQuantity: true },
            // Best price first. Postgres orders the Decimal column numerically,
            // which string sorting in Node would not.
            orderBy: { limitPrice: 'desc' },
        })

        const byOutcome = new Map<string, PredictionBookLevel[]>()

        for (const row of rows) {
            // Integers, not money: shares are whole by construction.
            const shares = (row._sum.quantity ?? 0) - (row._sum.filledQuantity ?? 0)
            if (shares <= 0) continue

            const levels = byOutcome.get(row.outcomeId)
            const level: PredictionBookLevel = { price: row.limitPrice.toString(), shares }

            if (levels) {
                levels.push(level)
            } else {
                byOutcome.set(row.outcomeId, [level])
            }
        }

        return byOutcome
    }
}
