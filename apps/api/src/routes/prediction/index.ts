/**
 * Prediction Market — Player Routes (binary order book)
 *
 * Public:
 *   GET    /prediction/markets            — list published markets (?status=&limit=&cursor=)
 *   GET    /prediction/markets/:id        — one market, with book depth and last price
 *   GET    /prediction/markets/:id/book   — aggregated depth per outcome
 *
 * Authenticated:
 *   POST   /prediction/orders             — place a buy-only limit order
 *   DELETE /prediction/orders/:id         — cancel own order
 *   GET    /prediction/orders             — own orders (?status=&marketId=&limit=&cursor=)
 *   GET    /prediction/positions          — own positions (?status=&marketId=&limit=&cursor=)
 *
 * THREE THINGS THIS FILE IS RESPONSIBLE FOR, AND NOTHING ELSE:
 *
 * 1. **The feature flag.** `feature_prediction_market` is read from `SiteSetting`
 *    in an `onRequest` hook, exactly as every other flag in this codebase is read
 *    (`routes/settings/index.ts` — the row's value compared to the string
 *    `'true'`). A missing row means off, which is the documented default. The
 *    hook runs before `authenticate`, so with the flag off the whole surface is
 *    404 to anonymous and authenticated callers alike.
 * 2. **Draft markets are not public.** An unpublished book takes no orders and
 *    must not be advertised, so the list excludes DRAFT and the single-market
 *    reads 404 on it rather than 403 — the existence of an unreleased bout is
 *    itself information.
 * 3. **Serialization to the wire convention.** Money is a `Prisma.Decimal` in the
 *    database and a decimal STRING on the wire; timestamps are ISO-8601. Nothing
 *    here converts a price to a JS number — see `@world-bingo/shared-types`
 *    `prediction/common.ts`. Share counts are integers by construction.
 *
 * PRICE VALIDATION IS DELIBERATELY HALF DONE HERE. `PlaceOrderSchema` enforces
 * shape and generic bounds — a positive whole number of 1 ETB ticks — because a
 * schema cannot see the market. The real rule, `1 <= limitPrice <= shareValue - 1`,
 * is re-checked inside the order transaction against `market.shareValue`, which is
 * per-market data and never a hardcoded 100. Do not duplicate that bound here; it
 * would go stale the first time a market runs a different denomination.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { PredictionMarketStatus } from '@prisma/client'
import type { PredictionOrderStatus, PredictionPositionStatus, Prisma } from '@prisma/client'
import {
    PlaceOrderSchema,
    PREDICTION_MARKET_STATUSES,
    PREDICTION_ORDER_STATUSES,
    PREDICTION_POSITION_STATUSES,
    type PlaceOrderDto,
    type PredictionMarketDto,
    type PredictionOrderDto,
    type PredictionOutcomeDto,
    type PredictionPositionDto,
} from '@world-bingo/shared-types'
import zodToJsonSchema from 'zod-to-json-schema'
import prisma from '../../lib/prisma.js'
import { PredictionBookService } from '../../services/prediction/book.service.js'
import { PredictionMarketService } from '../../services/prediction/market.service.js'
import { PredictionOrderService } from '../../services/prediction/order.service.js'

// ─── Feature flag ────────────────────────────────────────────────────────────

/** Defaults to `'false'` in `routes/settings/index.ts`; a missing row means off. */
const FEATURE_FLAG_KEY = 'feature_prediction_market'

async function predictionEnabled(): Promise<boolean> {
    const row = await prisma.siteSetting
        .findUnique({ where: { key: FEATURE_FLAG_KEY } })
        .catch(() => null)
    return row?.value === 'true'
}

// ─── Paging ──────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

/** A page size is a count, not money — integer arithmetic is correct here. */
function clampLimit(limit?: number): number {
    if (!limit || !Number.isFinite(limit) || limit < 1) return DEFAULT_PAGE_SIZE
    return Math.min(Math.floor(limit), MAX_PAGE_SIZE)
}

// ─── Errors ──────────────────────────────────────────────────────────────────

function httpError(message: string, statusCode: number): Error {
    return Object.assign(new Error(message), { statusCode })
}

/**
 * Map a thrown error onto the design's Errors table.
 *
 * The prediction services attach `statusCode` to everything they throw, so that
 * branch carries almost all traffic and is the authoritative one. The message
 * matching below only exists for the services that throw a bare `Error`
 * (`book.service.ts`), and for `Insufficient funds`, which is mapped to 400 here
 * exactly as the game routes map it.
 *
 * Anything unrecognized is a 500. Guessing 400 for an unknown failure would
 * report a database or lock error as the player's fault.
 */
function errorStatus(err: unknown): number {
    const code = (err as { statusCode?: unknown })?.statusCode
    if (typeof code === 'number' && code >= 400 && code <= 599) return code

    const message = String((err as { message?: unknown })?.message ?? '')
    if (message === 'Insufficient funds') return 400
    if (/not found/i.test(message)) return 404
    if (/not yours/i.test(message)) return 403
    if (/not open|has closed|no longer|already/i.test(message)) return 409
    return 500
}

function fail(reply: FastifyReply, err: unknown): FastifyReply {
    const status = errorStatus(err)
    const message = String((err as { message?: unknown })?.message ?? 'Request failed')
    if (status >= 500) {
        reply.request.log.error({ err }, '[Prediction] request failed')
    }
    return reply.status(status).send({ error: message })
}

// ─── Query parsing ───────────────────────────────────────────────────────────

/**
 * `?status=OPEN` or `?status=OPEN,PARTIALLY_FILLED`.
 *
 * An unknown status is a 400 rather than a silently ignored filter: a client
 * that asked for something the server does not understand has been given the
 * wrong answer, not a filtered one.
 */
function parseStatuses<T extends string>(
    raw: string | undefined,
    allowed: readonly T[],
    label: string,
): T[] | undefined {
    if (!raw) return undefined

    const requested = raw
        .split(',')
        .map((part) => part.trim().toUpperCase())
        .filter((part) => part.length > 0)
    if (requested.length === 0) return undefined

    const parsed: T[] = []
    for (const value of requested) {
        if (!(allowed as readonly string[]).includes(value)) {
            throw httpError(`Unknown ${label} status: ${value}`, 400)
        }
        if (!parsed.includes(value as T)) parsed.push(value as T)
    }
    return parsed
}

// ─── Serialization ───────────────────────────────────────────────────────────

type MarketRow = Prisma.PredictionMarketGetPayload<{ include: { outcomes: true } }>
type OutcomeRow = MarketRow['outcomes'][number]
type OrderRow = Prisma.PredictionOrderGetPayload<{ include: { market: true; outcome: true } }>
type PositionRow = Prisma.PredictionPositionGetPayload<{
    include: { market: { include: { outcomes: true } }; outcome: true }
}>

/** Every money field goes out as `Decimal.toString()` — never through a JS number. */
function serializeMarket(market: MarketRow): PredictionMarketDto {
    return {
        id: market.id,
        eventName: market.eventName,
        question: market.question,
        description: market.description,
        imageUrl: market.imageUrl,
        status: market.status,
        closesAt: market.closesAt.toISOString(),
        resolvesAt: market.resolvesAt ? market.resolvesAt.toISOString() : null,
        shareValue: market.shareValue.toString(),
        feePct: market.feePct.toString(),
        minOrderShares: market.minOrderShares,
        maxOrderShares: market.maxOrderShares,
        totalShares: market.totalShares,
        totalVolume: market.totalVolume.toString(),
        winningOutcomeId: market.winningOutcomeId,
        resolvedById: market.resolvedById,
        resolvedAt: market.resolvedAt ? market.resolvedAt.toISOString() : null,
        disputeUntil: market.disputeUntil ? market.disputeUntil.toISOString() : null,
        settledAt: market.settledAt ? market.settledAt.toISOString() : null,
        voidReason: market.voidReason,
        createdById: market.createdById,
        createdAt: market.createdAt.toISOString(),
        updatedAt: market.updatedAt.toISOString(),
    }
}

function serializeOutcome(outcome: OutcomeRow): PredictionOutcomeDto {
    return {
        id: outcome.id,
        marketId: outcome.marketId,
        label: outcome.label,
        sortOrder: outcome.sortOrder,
        lastPrice: outcome.lastPrice ? outcome.lastPrice.toString() : null,
    }
}

function serializeMarketWithOutcomes(market: MarketRow) {
    return {
        ...serializeMarket(market),
        outcomes: market.outcomes.map(serializeOutcome),
    }
}

function serializeOrder(order: OrderRow) {
    const dto: PredictionOrderDto = {
        id: order.id,
        marketId: order.marketId,
        outcomeId: order.outcomeId,
        userId: order.userId,
        limitPrice: order.limitPrice.toString(),
        quantity: order.quantity,
        filledQuantity: order.filledQuantity,
        reservedReal: order.reservedReal.toString(),
        reservedBonus: order.reservedBonus.toString(),
        status: order.status,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
    }

    return {
        ...dto,
        /** Enough to render the row without a second fetch; never the whole book. */
        market: {
            id: order.market.id,
            eventName: order.market.eventName,
            question: order.market.question,
            status: order.market.status,
            shareValue: order.market.shareValue.toString(),
            closesAt: order.market.closesAt.toISOString(),
        },
        outcome: serializeOutcome(order.outcome),
    }
}

function serializePosition(position: PositionRow) {
    const dto: PredictionPositionDto = {
        id: position.id,
        marketId: position.marketId,
        outcomeId: position.outcomeId,
        userId: position.userId,
        shares: position.shares,
        costBasisReal: position.costBasisReal.toString(),
        costBasisBonus: position.costBasisBonus.toString(),
        status: position.status,
        payout: position.payout.toString(),
        feePaid: position.feePaid.toString(),
        settledAt: position.settledAt ? position.settledAt.toISOString() : null,
        createdAt: position.createdAt.toISOString(),
        updatedAt: position.updatedAt.toISOString(),
    }

    return {
        ...dto,
        market: serializeMarketWithOutcomes(position.market),
        outcome: serializeOutcome(position.outcome),
    }
}

// ─── Swagger fragments ───────────────────────────────────────────────────────

const TAGS = ['Prediction']

/**
 * No `format: 'uuid'` on path params on purpose: a malformed id should fall
 * through to the service's own 404, not be rejected as a schema violation.
 * The order BODY does carry uuid formats — there a bad id is a client bug.
 */
const ID_PARAMS = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
}

const PAGING_PROPERTIES = {
    /** Clamped to 100 server-side rather than rejected. */
    limit: { type: 'integer' },
    cursor: { type: 'string' },
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const predictionRoutes: FastifyPluginAsync = async (fastify) => {
    // The whole surface disappears when the flag is off. Registered on the
    // plugin, so it covers every route below — including the authenticated ones,
    // and before `authenticate` runs.
    fastify.addHook('onRequest', async (_request, reply) => {
        if (await predictionEnabled()) return
        return reply.status(404).send({ error: 'Not found' })
    })

    // ── GET /markets ─────────────────────────────────────────────────────────
    fastify.get(
        '/markets',
        {
            schema: {
                tags: TAGS,
                summary: 'List prediction markets',
                description:
                    'Published markets only, soonest to close first — which on a fight card is bout order. Cursor paginated.',
                querystring: {
                    type: 'object',
                    properties: {
                        status: {
                            type: 'string',
                            description: 'Comma-separated market statuses. DRAFT is not public.',
                        },
                        ...PAGING_PROPERTIES,
                    },
                },
            },
        },
        async (request, reply) => {
            const query = request.query as { status?: string; limit?: number; cursor?: string }
            try {
                const statuses = parseStatuses(
                    query.status,
                    PREDICTION_MARKET_STATUSES,
                    'market',
                )
                if (statuses?.includes('DRAFT')) {
                    throw httpError('Draft markets are not public', 400)
                }

                const result = await PredictionMarketService.listMarkets({
                    ...(statuses
                        ? { status: statuses as PredictionMarketStatus[] }
                        : { excludeDrafts: true }),
                    limit: query.limit,
                    cursor: query.cursor,
                })

                return reply.send({
                    markets: result.markets.map(serializeMarketWithOutcomes),
                    nextCursor: result.nextCursor,
                })
            } catch (err) {
                return fail(reply, err)
            }
        },
    )

    // ── GET /markets/:id ─────────────────────────────────────────────────────
    fastify.get(
        '/markets/:id',
        {
            schema: {
                tags: TAGS,
                summary: 'Get one market with its book',
                description:
                    'The market, both outcomes with their last traded price, and aggregated depth per outcome. `shareValue` is carried on the book so a ticket can be sized without assuming 100.',
                params: ID_PARAMS,
            },
        },
        async (request, reply) => {
            const { id } = request.params as { id: string }
            try {
                const market = await PredictionMarketService.getMarket(id)
                if (market.status === PredictionMarketStatus.DRAFT) {
                    throw httpError('Market not found', 404)
                }

                const book = await PredictionBookService.getBook(id)

                return reply.send({ ...serializeMarketWithOutcomes(market), book })
            } catch (err) {
                return fail(reply, err)
            }
        },
    )

    // ── GET /markets/:id/book ────────────────────────────────────────────────
    fastify.get(
        '/markets/:id/book',
        {
            schema: {
                tags: TAGS,
                summary: 'Aggregated book depth',
                description:
                    'Resting orders grouped by (outcome, price) into levels, best price first. Prices and share value are decimal strings.',
                params: ID_PARAMS,
            },
        },
        async (request, reply) => {
            const { id } = request.params as { id: string }
            try {
                // Status guard before the aggregation: an unpublished book is not
                // public, and `getBook` alone would happily return an empty one.
                const market = await prisma.predictionMarket.findUnique({
                    where: { id },
                    select: { status: true },
                })
                if (!market || market.status === PredictionMarketStatus.DRAFT) {
                    throw httpError('Market not found', 404)
                }

                return reply.send(await PredictionBookService.getBook(id))
            } catch (err) {
                return fail(reply, err)
            }
        },
    )

    // ── GET /markets/:id/history ─────────────────────────────────────────────
    fastify.get(
        '/markets/:id/history',
        {
            schema: {
                tags: TAGS,
                summary: 'Price history for the probability chart',
                description:
                    'One point per trade for the first outcome, time-ascending. Price is a decimal string; the market being binary, the other outcome is shareValue − price. Empty until the first trade.',
                params: ID_PARAMS,
            },
        },
        async (request, reply) => {
            const { id } = request.params as { id: string }
            try {
                // Same visibility rule as the book: an unpublished market's
                // history is not public, and getPriceHistory would return an
                // empty series rather than 404 on its own.
                const market = await prisma.predictionMarket.findUnique({
                    where: { id },
                    select: { status: true },
                })
                if (!market || market.status === PredictionMarketStatus.DRAFT) {
                    throw httpError('Market not found', 404)
                }

                return reply.send(await PredictionBookService.getPriceHistory(id))
            } catch (err) {
                return fail(reply, err)
            }
        },
    )

    // ── POST /orders ─────────────────────────────────────────────────────────
    fastify.post(
        '/orders',
        {
            preHandler: [fastify.authenticate],
            schema: {
                tags: TAGS,
                summary: 'Place a limit order',
                description:
                    'Buy-only. The reserve (limitPrice x quantity) leaves the wallet immediately, bonus balance first then real, so a resting order is always fully funded. The order matches against the opposing outcome and any unconsumed reserve is released in the same instant.',
                body: zodToJsonSchema(PlaceOrderSchema),
            },
        },
        async (request, reply) => {
            const userId = (request.user as { id: string }).id
            try {
                // The schema above already rejected a malformed body at the ajv
                // layer; parsing again is what produces the typed DTO and the
                // shared-types error message rather than an ajv one.
                const parsed = PlaceOrderSchema.safeParse(request.body)
                if (!parsed.success) {
                    return reply.status(400).send({ error: parsed.error.issues })
                }

                const body: PlaceOrderDto = parsed.data
                const result = await PredictionOrderService.placeOrder(userId, {
                    marketId: body.marketId,
                    outcomeId: body.outcomeId,
                    limitPrice: body.limitPrice,
                    quantity: body.quantity,
                })

                return reply.status(201).send({
                    order: serializeOrder(result.order),
                    // The taker's own executions. A fill also names its maker;
                    // that stays server-side — who took the other side of a trade
                    // is not the taker's business.
                    fills: result.fills.map((fill) => ({
                        quantity: fill.quantity,
                        price: fill.takerPrice.toString(),
                    })),
                    realBalance: result.realBalance.toString(),
                    bonusBalance: result.bonusBalance.toString(),
                })
            } catch (err) {
                return fail(reply, err)
            }
        },
    )

    // ── DELETE /orders/:id ───────────────────────────────────────────────────
    fastify.delete(
        '/orders/:id',
        {
            preHandler: [fastify.authenticate],
            schema: {
                tags: TAGS,
                summary: 'Cancel an order',
                description:
                    'Releases exactly the unfilled reserve, in the buckets it was held in — bonus returns as bonus. Shares that already filled are positions now and are untouched.',
                params: ID_PARAMS,
            },
        },
        async (request, reply) => {
            const { id } = request.params as { id: string }
            const userId = (request.user as { id: string }).id
            try {
                const result = await PredictionOrderService.cancelOrder(userId, id)

                return reply.send({
                    order: serializeOrder(result.order),
                    refunded: result.refunded.toString(),
                    realBalance: result.realBalance.toString(),
                    bonusBalance: result.bonusBalance.toString(),
                })
            } catch (err) {
                return fail(reply, err)
            }
        },
    )

    // ── GET /orders ──────────────────────────────────────────────────────────
    fastify.get(
        '/orders',
        {
            preHandler: [fastify.authenticate],
            schema: {
                tags: TAGS,
                summary: "List the caller's own orders",
                description: 'Newest first, cursor paginated.',
                querystring: {
                    type: 'object',
                    properties: {
                        status: {
                            type: 'string',
                            description: 'Comma-separated order statuses.',
                        },
                        marketId: { type: 'string' },
                        outcomeId: { type: 'string' },
                        ...PAGING_PROPERTIES,
                    },
                },
            },
        },
        async (request, reply) => {
            const userId = (request.user as { id: string }).id
            const query = request.query as {
                status?: string
                marketId?: string
                outcomeId?: string
                limit?: number
                cursor?: string
            }
            try {
                const statuses = parseStatuses(query.status, PREDICTION_ORDER_STATUSES, 'order')

                const result = await PredictionOrderService.listUserOrders(userId, {
                    ...(statuses ? { status: statuses as PredictionOrderStatus[] } : {}),
                    marketId: query.marketId,
                    outcomeId: query.outcomeId,
                    limit: query.limit,
                    cursor: query.cursor,
                })

                return reply.send({
                    orders: result.orders.map(serializeOrder),
                    nextCursor: result.nextCursor,
                })
            } catch (err) {
                return fail(reply, err)
            }
        },
    )

    // ── GET /positions ───────────────────────────────────────────────────────
    fastify.get(
        '/positions',
        {
            preHandler: [fastify.authenticate],
            schema: {
                tags: TAGS,
                summary: "List the caller's own positions",
                description:
                    'One row per (market, outcome), with the market and outcome it belongs to. `costBasisReal`/`costBasisBonus` remember how the position was funded, which is what a void refunds against.',
                querystring: {
                    type: 'object',
                    properties: {
                        status: {
                            type: 'string',
                            description: 'Comma-separated position statuses.',
                        },
                        marketId: { type: 'string' },
                        ...PAGING_PROPERTIES,
                    },
                },
            },
        },
        async (request, reply) => {
            const userId = (request.user as { id: string }).id
            const query = request.query as {
                status?: string
                marketId?: string
                limit?: number
                cursor?: string
            }
            try {
                const statuses = parseStatuses(
                    query.status,
                    PREDICTION_POSITION_STATUSES,
                    'position',
                )
                const limit = clampLimit(query.limit)

                const rows = await prisma.predictionPosition.findMany({
                    where: {
                        userId,
                        ...(query.marketId ? { marketId: query.marketId } : {}),
                        ...(statuses
                            ? { status: { in: statuses as PredictionPositionStatus[] } }
                            : {}),
                    },
                    include: {
                        market: { include: { outcomes: { orderBy: { sortOrder: 'asc' } } } },
                        outcome: true,
                    },
                    // `id` breaks ties so the page boundary is stable when a whole
                    // card's positions are created in the same transaction.
                    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                    take: limit + 1,
                    ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
                })

                const hasMore = rows.length > limit
                const positions = hasMore ? rows.slice(0, limit) : rows

                return reply.send({
                    positions: positions.map(serializePosition),
                    nextCursor: hasMore ? positions[positions.length - 1].id : null,
                })
            } catch (err) {
                return fail(reply, err)
            }
        },
    )
}

export default predictionRoutes
