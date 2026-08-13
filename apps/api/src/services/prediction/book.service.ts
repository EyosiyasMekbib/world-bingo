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
} from '@world-bingo/shared-types'

/** An order still has unfilled shares resting in the book in exactly these states. */
const RESTING_STATUSES: PredictionOrderStatus[] = ['OPEN', 'PARTIALLY_FILLED']

const DEFAULT_FILL_LIMIT = 50
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
