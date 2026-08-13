/**
 * Admin API for the binary order-book prediction market.
 *
 * Mounted so these resolve under `/admin/prediction/...`:
 *
 *   GET    /markets                 list every market, any status
 *   GET    /markets/:id             one market with both outcomes
 *   POST   /markets                 create (always DRAFT)
 *   PATCH  /markets/:id             edit — frozen fields 409 once published
 *   POST   /markets/:id/publish     DRAFT     → OPEN
 *   POST   /markets/:id/close       OPEN      → CLOSED (idempotent)
 *   POST   /markets/:id/resolve     CLOSED    → RESOLVING   { outcomeId }
 *   POST   /markets/:id/unresolve   RESOLVING → CLOSED (inside the dispute window)
 *   POST   /markets/:id/void        any non-terminal → VOIDED { reason }
 *   GET    /markets/:id/book        aggregated depth both sides + the tape
 *   GET    /markets/:id/positions   holders, with per-outcome payout obligation
 *   GET    /markets/:id/orders      every order on the market
 *
 * THIS FILE IS A BOUNDARY, NOT A BRAIN. Every lifecycle rule, every money
 * movement and every `AuditLog` row lives in the services — the routes parse the
 * request, call one service method, and map the error. Two consequences worth
 * stating because they are easy to undo by accident:
 *
 * - **No audit writes here.** `PredictionMarketService` already writes an
 *   `AuditLog` targeting `prediction_market:<id>` for create, update, publish,
 *   close, resolve, unresolve and void. Writing a second row from the route
 *   would double every entry in the trail.
 * - **No hardcoded 100.** `shareValue` is per-market data. The only arithmetic
 *   in this file is the payout obligation on the positions summary, and it
 *   multiplies the market's own `shareValue` — as a `Prisma.Decimal`, never a
 *   JS float.
 *
 * Errors: the services throw `Error` objects carrying a `statusCode`, so the
 * spec's status codes (409 for an illegal transition or a frozen-field edit, 400
 * for bad input, 404 for a missing market) are decided at the throw site and
 * merely forwarded here.
 */

import type { FastifyInstance, FastifyReply } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import {
    CreatePredictionMarketSchema,
    PredictionMarketStatusSchema,
    PredictionOrderStatusSchema,
    PredictionPositionStatusSchema,
    ResolvePredictionMarketSchema,
    UpdatePredictionMarketSchema,
    VoidPredictionMarketSchema,
} from '@world-bingo/shared-types'
import prisma from '../../../lib/prisma.js'
import { PredictionBookService } from '../../../services/prediction/book.service.js'
import { PredictionMarketService } from '../../../services/prediction/market.service.js'
import { PredictionOrderService } from '../../../services/prediction/order.service.js'
import type {
    CreateMarketInput,
    MarketListFilter,
    PredictionMarketWithOutcomes,
    UpdateMarketPatch,
} from '../../../services/prediction/market.service.js'
import type { OrderListFilter } from '../../../services/prediction/order.service.js'

// ─── Feature flag ────────────────────────────────────────────────────────────

const FEATURE_FLAG = 'feature_prediction_market'

/**
 * Off — or missing, which is the shipped default — means the whole surface does
 * not exist. Read live rather than cached: an operator toggling the flag expects
 * the next click to obey it, and this is a handful of admin requests a minute.
 */
async function featureEnabled(): Promise<boolean> {
    const row = await prisma.siteSetting
        .findUnique({ where: { key: FEATURE_FLAG } })
        .catch(() => null)
    return row?.value === 'true'
}

// ─── Query schemas ───────────────────────────────────────────────────────────

/** `?status=OPEN&status=CLOSED` and `?status=OPEN,CLOSED` both mean the same thing. */
const toStatusList = (value: unknown) =>
    typeof value === 'string'
        ? value.split(',').map((part) => part.trim()).filter(Boolean)
        : value

const marketStatusesSchema = z.preprocess(toStatusList, z.array(PredictionMarketStatusSchema).min(1))
const orderStatusesSchema = z.preprocess(toStatusList, z.array(PredictionOrderStatusSchema).min(1))
const positionStatusesSchema = z.preprocess(
    toStatusList,
    z.array(PredictionPositionStatusSchema).min(1),
)

const listMarketsQuerySchema = z.object({
    status: marketStatusesSchema.optional(),
    eventName: z.string().trim().min(1).max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().uuid().optional(),
})

const bookQuerySchema = z.object({
    /** How much of the tape to return alongside the depth. 0 skips it. */
    fills: z.coerce.number().int().min(0).max(200).optional(),
})

const positionsQuerySchema = z.object({
    status: positionStatusesSchema.optional(),
    outcomeId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().uuid().optional(),
})

const ordersQuerySchema = z.object({
    status: orderStatusesSchema.optional(),
    outcomeId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().uuid().optional(),
})

const DEFAULT_FILL_LIMIT = 50
const DEFAULT_POSITION_LIMIT = 50

// ─── Serialization ───────────────────────────────────────────────────────────
//
// The wire convention from `@world-bingo/shared-types` `prediction/common.ts`:
// money is the string form of a Decimal, share counts are integers, timestamps
// are ISO-8601. Serializing explicitly rather than returning the Prisma row
// keeps the admin client parsing the same shapes the player client does.

const money = (value: Prisma.Decimal): string => value.toString()

const maybeMoney = (value: Prisma.Decimal | null): string | null =>
    value === null || value === undefined ? null : value.toString()

const iso = (value: Date | null): string | null =>
    value === null || value === undefined ? null : value.toISOString()

function serializeOutcome(outcome: {
    id: string
    marketId: string
    label: string
    sortOrder: number
    lastPrice: Prisma.Decimal | null
}) {
    return {
        id: outcome.id,
        marketId: outcome.marketId,
        label: outcome.label,
        sortOrder: outcome.sortOrder,
        lastPrice: maybeMoney(outcome.lastPrice),
    }
}

function serializeMarket(market: PredictionMarketWithOutcomes) {
    return {
        id: market.id,
        eventName: market.eventName,
        question: market.question,
        description: market.description,
        imageUrl: market.imageUrl,
        status: market.status,
        closesAt: market.closesAt.toISOString(),
        resolvesAt: iso(market.resolvesAt),
        shareValue: money(market.shareValue),
        feePct: money(market.feePct),
        minOrderShares: market.minOrderShares,
        maxOrderShares: market.maxOrderShares,
        totalShares: market.totalShares,
        totalVolume: money(market.totalVolume),
        winningOutcomeId: market.winningOutcomeId,
        resolvedById: market.resolvedById,
        resolvedAt: iso(market.resolvedAt),
        disputeUntil: iso(market.disputeUntil),
        settledAt: iso(market.settledAt),
        voidReason: market.voidReason,
        createdById: market.createdById,
        createdAt: market.createdAt.toISOString(),
        updatedAt: market.updatedAt.toISOString(),
        outcomes: market.outcomes.map(serializeOutcome),
    }
}

/** The trader behind an order or a position. Enough to identify, no more. */
type AdminUserRef = { id: string; username: string | null; phone: string | null } | null

function serializeOrder(order: any, user: AdminUserRef) {
    return {
        id: order.id,
        marketId: order.marketId,
        outcomeId: order.outcomeId,
        userId: order.userId,
        limitPrice: money(order.limitPrice),
        quantity: order.quantity,
        filledQuantity: order.filledQuantity,
        reservedReal: money(order.reservedReal),
        reservedBonus: money(order.reservedBonus),
        status: order.status,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
        outcome: order.outcome
            ? { id: order.outcome.id, label: order.outcome.label, sortOrder: order.outcome.sortOrder }
            : null,
        user,
    }
}

function serializePosition(position: any) {
    return {
        id: position.id,
        marketId: position.marketId,
        outcomeId: position.outcomeId,
        userId: position.userId,
        shares: position.shares,
        costBasisReal: money(position.costBasisReal),
        costBasisBonus: money(position.costBasisBonus),
        status: position.status,
        payout: money(position.payout),
        feePaid: money(position.feePaid),
        settledAt: iso(position.settledAt),
        createdAt: position.createdAt.toISOString(),
        updatedAt: position.updatedAt.toISOString(),
        outcome: position.outcome
            ? {
                  id: position.outcome.id,
                  label: position.outcome.label,
                  sortOrder: position.outcome.sortOrder,
              }
            : null,
        user: position.user
            ? { id: position.user.id, username: position.user.username, phone: position.user.phone }
            : null,
    }
}

// ─── Error mapping ───────────────────────────────────────────────────────────

/**
 * The services attach `statusCode` to everything they throw deliberately — 409
 * for an illegal transition or a frozen-field edit, 400 for bad input, 404 for a
 * market that does not exist. Anything without one is a bug, not a rejection:
 * it is logged and answered 500 rather than being flattened into a 400 that
 * would read to the operator as "you typed it wrong".
 */
function sendServiceError(reply: FastifyReply, err: any) {
    const status =
        typeof err?.statusCode === 'number'
            ? err.statusCode
            : /not found/i.test(String(err?.message ?? ''))
              ? 404
              : 500

    if (status >= 500) {
        reply.log.error({ err }, '[AdminPrediction] unhandled service error')
    }

    return reply.status(status).send({ error: err?.message ?? 'Unexpected error' })
}

function sendInvalid(reply: FastifyReply, error: z.ZodError) {
    return reply.status(400).send({ error: 'Invalid request', details: error.issues })
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export default async function adminPredictionRoutes(server: FastifyInstance) {
    // Flag off → the surface 404s before auth even runs, so a disabled feature
    // is indistinguishable from one that was never built.
    server.addHook('onRequest', async (_request, reply) => {
        if (await featureEnabled()) return
        return reply.status(404).send({ error: 'Not found' })
    })

    // ── GET /markets ─────────────────────────────────────────────────────────
    // Every market including drafts — this is the operator's view of the card.
    server.get('/markets', { preHandler: [server.requireAdmin] }, async (request, reply) => {
        const parsed = listMarketsQuerySchema.safeParse(request.query ?? {})
        if (!parsed.success) return sendInvalid(reply, parsed.error)

        const filter: MarketListFilter = {
            status: parsed.data.status,
            eventName: parsed.data.eventName,
            limit: parsed.data.limit,
            cursor: parsed.data.cursor,
        }

        try {
            const { markets, nextCursor } = await PredictionMarketService.listMarkets(filter)
            return reply.send({ markets: markets.map(serializeMarket), nextCursor })
        } catch (err) {
            return sendServiceError(reply, err)
        }
    })

    // ── GET /markets/:id ─────────────────────────────────────────────────────
    // One market with both outcomes. Additive to the spec's admin list, and the
    // only way to read a DRAFT by id: the player API hides unpublished markets,
    // so without this the admin market page cannot open one before it is live.
    server.get('/markets/:id', { preHandler: [server.requireAdmin] }, async (request: any, reply) => {
        try {
            const market = await PredictionMarketService.getMarket(request.params.id)
            return reply.send(serializeMarket(market))
        } catch (err) {
            return sendServiceError(reply, err)
        }
    })

    // ── POST /markets ────────────────────────────────────────────────────────
    // Always lands in DRAFT. Publishing is a separate, deliberate action.
    server.post('/markets', { preHandler: [server.requireAdmin] }, async (request: any, reply) => {
        const parsed = CreatePredictionMarketSchema.safeParse(request.body)
        if (!parsed.success) return sendInvalid(reply, parsed.error)

        // This package compiles with `strict: false`, so zod infers every field
        // as optional — restate the shape rather than passing `parsed.data`
        // straight through. The service re-validates all of it anyway.
        const body = parsed.data
        const input: CreateMarketInput = {
            eventName: body.eventName ?? '',
            question: body.question ?? '',
            description: body.description ?? null,
            imageUrl: body.imageUrl ?? null,
            closesAt: body.closesAt ?? '',
            resolvesAt: body.resolvesAt ?? null,
            shareValue: body.shareValue,
            feePct: body.feePct,
            minOrderShares: body.minOrderShares,
            maxOrderShares: body.maxOrderShares,
            outcomes: (body.outcomes ?? []).map((outcome) => ({
                label: outcome.label ?? '',
                sortOrder: outcome.sortOrder ?? 0,
            })),
        }

        try {
            const market = await PredictionMarketService.createMarket(input, request.user?.id)
            return reply.status(201).send(serializeMarket(market))
        } catch (err) {
            return sendServiceError(reply, err)
        }
    })

    // ── PATCH /markets/:id ───────────────────────────────────────────────────
    // The freeze is enforced in the service and is value-based, so re-posting an
    // unchanged `question` alongside a new `description` is not an edit of the
    // question and does not 409.
    server.patch('/markets/:id', { preHandler: [server.requireAdmin] }, async (request: any, reply) => {
        const parsed = UpdatePredictionMarketSchema.safeParse(request.body)
        if (!parsed.success) return sendInvalid(reply, parsed.error)

        // Only the keys actually present survive the parse, which is what makes
        // the freeze check above meaningful — an absent field is not an edit.
        const patch: UpdateMarketPatch = { ...parsed.data }

        try {
            const market = await PredictionMarketService.updateMarket(
                request.params.id,
                patch,
                request.user?.id,
            )
            return reply.send(serializeMarket(market))
        } catch (err) {
            return sendServiceError(reply, err)
        }
    })

    // ── POST /markets/:id/publish ────────────────────────────────────────────
    server.post(
        '/markets/:id/publish',
        { preHandler: [server.requireAdmin] },
        async (request: any, reply) => {
            try {
                const market = await PredictionMarketService.publishMarket(
                    request.params.id,
                    request.user?.id,
                )
                return reply.send(serializeMarket(market))
            } catch (err) {
                return sendServiceError(reply, err)
            }
        },
    )

    // ── POST /markets/:id/close ──────────────────────────────────────────────
    // Idempotent by design: the worker's 30s tick and an admin closing early
    // race, and neither should see a failure.
    server.post(
        '/markets/:id/close',
        { preHandler: [server.requireAdmin] },
        async (request: any, reply) => {
            try {
                const market = await PredictionMarketService.closeMarket(
                    request.params.id,
                    request.user?.id,
                )
                return reply.send(serializeMarket(market))
            } catch (err) {
                return sendServiceError(reply, err)
            }
        },
    )

    // ── POST /markets/:id/resolve ────────────────────────────────────────────
    // Names the winner and schedules the payout for the end of the dispute
    // window. No money moves here — the delayed settle job does that.
    server.post(
        '/markets/:id/resolve',
        { preHandler: [server.requireAdmin] },
        async (request: any, reply) => {
            const parsed = ResolvePredictionMarketSchema.safeParse(request.body)
            if (!parsed.success) return sendInvalid(reply, parsed.error)

            try {
                const market = await PredictionMarketService.resolveMarket(
                    request.params.id,
                    parsed.data.outcomeId ?? '',
                    request.user?.id,
                )
                return reply.send(serializeMarket(market))
            } catch (err) {
                return sendServiceError(reply, err)
            }
        },
    )

    // ── POST /markets/:id/unresolve ──────────────────────────────────────────
    // Takes a miscall back, but only from inside the dispute window; after it
    // the service 409s rather than clawing money out of wallets.
    server.post(
        '/markets/:id/unresolve',
        { preHandler: [server.requireAdmin] },
        async (request: any, reply) => {
            try {
                const market = await PredictionMarketService.unresolveMarket(
                    request.params.id,
                    request.user?.id,
                )
                return reply.send(serializeMarket(market))
            } catch (err) {
                return sendServiceError(reply, err)
            }
        },
    )

    // ── POST /markets/:id/void ───────────────────────────────────────────────
    // Draw, no-contest, or a cancelled bout: everyone is refunded at cost basis,
    // bonus back as bonus. Runs the refunds synchronously in the service.
    server.post(
        '/markets/:id/void',
        { preHandler: [server.requireAdmin] },
        async (request: any, reply) => {
            const parsed = VoidPredictionMarketSchema.safeParse(request.body)
            if (!parsed.success) return sendInvalid(reply, parsed.error)

            try {
                const market = await PredictionMarketService.voidMarket(
                    request.params.id,
                    parsed.data.reason ?? '',
                    request.user?.id,
                )
                return reply.send(serializeMarket(market))
            } catch (err) {
                return sendServiceError(reply, err)
            }
        },
    )

    // ── GET /markets/:id/book ────────────────────────────────────────────────
    // Depth on both sides plus the tape, so the market page renders from one
    // fetch. `shareValue` rides along on the book — the client never assumes 100.
    server.get(
        '/markets/:id/book',
        { preHandler: [server.requireAdmin] },
        async (request: any, reply) => {
            const parsed = bookQuerySchema.safeParse(request.query ?? {})
            if (!parsed.success) return sendInvalid(reply, parsed.error)

            const fillLimit = parsed.data.fills === undefined ? DEFAULT_FILL_LIMIT : parsed.data.fills

            try {
                const book = await PredictionBookService.getBook(request.params.id)
                const fills =
                    fillLimit > 0
                        ? await PredictionBookService.getRecentFills(request.params.id, fillLimit)
                        : []
                return reply.send({ ...book, fills })
            } catch (err) {
                return sendServiceError(reply, err)
            }
        },
    )

    // ── GET /markets/:id/positions ───────────────────────────────────────────
    // Who holds what, plus the per-outcome payout obligation: what that side
    // would be owed if it wins, which is one `shareValue` per share held.
    //
    // On a solvent book the two sides' obligations are equal and each equals
    // `totalShares × shareValue` — losers' escrow funds winners exactly. Showing
    // both makes a breach visible to the operator without reading a log.
    server.get(
        '/markets/:id/positions',
        { preHandler: [server.requireAdmin] },
        async (request: any, reply) => {
            const parsed = positionsQuerySchema.safeParse(request.query ?? {})
            if (!parsed.success) return sendInvalid(reply, parsed.error)

            const marketId = request.params.id as string
            const limit = parsed.data.limit ?? DEFAULT_POSITION_LIMIT

            try {
                // 404s on an unknown market, and gives us the outcome labels and
                // the market's own share value for the summary below.
                const market = await PredictionMarketService.getMarket(marketId)

                const where: Prisma.PredictionPositionWhereInput = { marketId }
                if (parsed.data.status) where.status = { in: parsed.data.status }
                if (parsed.data.outcomeId) where.outcomeId = parsed.data.outcomeId

                const rows = await prisma.predictionPosition.findMany({
                    where,
                    include: {
                        outcome: { select: { id: true, label: true, sortOrder: true } },
                        user: { select: { id: true, username: true, phone: true } },
                    },
                    // Biggest holders first — that is who a miscall costs most.
                    // `id` breaks ties so the cursor boundary is stable.
                    orderBy: [{ shares: 'desc' }, { id: 'asc' }],
                    take: limit + 1,
                    ...(parsed.data.cursor ? { skip: 1, cursor: { id: parsed.data.cursor } } : {}),
                })

                const hasMore = rows.length > limit
                const positions = hasMore ? rows.slice(0, limit) : rows

                // Summary is over the whole market, never the current page —
                // paginating an obligation total would make it a lie.
                const grouped = await prisma.predictionPosition.groupBy({
                    by: ['outcomeId'],
                    where: { marketId },
                    _sum: {
                        shares: true,
                        costBasisReal: true,
                        costBasisBonus: true,
                        payout: true,
                        feePaid: true,
                    },
                    _count: { _all: true },
                })

                const shareValue = new Prisma.Decimal(market.shareValue)

                const byOutcome = market.outcomes.map((outcome) => {
                    const row = grouped.find((entry) => entry.outcomeId === outcome.id)
                    const shares = row?._sum.shares ?? 0
                    return {
                        outcomeId: outcome.id,
                        label: outcome.label,
                        sortOrder: outcome.sortOrder,
                        holders: row?._count?._all ?? 0,
                        shares,
                        // Decimal × integer share count. Never a float.
                        obligation: shareValue.times(shares).toString(),
                        costBasisReal: new Prisma.Decimal(row?._sum.costBasisReal ?? 0).toString(),
                        costBasisBonus: new Prisma.Decimal(row?._sum.costBasisBonus ?? 0).toString(),
                        payout: new Prisma.Decimal(row?._sum.payout ?? 0).toString(),
                        feePaid: new Prisma.Decimal(row?._sum.feePaid ?? 0).toString(),
                    }
                })

                return reply.send({
                    marketId,
                    shareValue: money(market.shareValue),
                    totalShares: market.totalShares,
                    totalVolume: money(market.totalVolume),
                    outcomes: byOutcome,
                    positions: positions.map(serializePosition),
                    nextCursor: hasMore ? positions[positions.length - 1].id : null,
                })
            } catch (err) {
                return sendServiceError(reply, err)
            }
        },
    )

    // ── GET /markets/:id/orders ──────────────────────────────────────────────
    // Every order on the market, newest first — resting, filled and cancelled.
    server.get(
        '/markets/:id/orders',
        { preHandler: [server.requireAdmin] },
        async (request: any, reply) => {
            const parsed = ordersQuerySchema.safeParse(request.query ?? {})
            if (!parsed.success) return sendInvalid(reply, parsed.error)

            const marketId = request.params.id as string

            const filter: OrderListFilter = {
                status: parsed.data.status,
                outcomeId: parsed.data.outcomeId,
                userId: parsed.data.userId,
                limit: parsed.data.limit,
                cursor: parsed.data.cursor,
            }

            try {
                const market = await PredictionMarketService.getMarket(marketId)
                const { orders, nextCursor } = await PredictionOrderService.listMarketOrders(
                    marketId,
                    filter,
                )

                // One lookup for the whole page rather than a join per row; the
                // order service is shared with the player API, which has no
                // business loading other players' names.
                const userIds = [...new Set(orders.map((order) => order.userId))]
                const users = userIds.length
                    ? await prisma.user.findMany({
                          where: { id: { in: userIds } },
                          select: { id: true, username: true, phone: true },
                      })
                    : []
                const byId = new Map(users.map((user) => [user.id, user]))

                return reply.send({
                    marketId,
                    shareValue: money(market.shareValue),
                    orders: orders.map((order) => serializeOrder(order, byId.get(order.userId) ?? null)),
                    nextCursor,
                })
            } catch (err) {
                return sendServiceError(reply, err)
            }
        },
    )
}
