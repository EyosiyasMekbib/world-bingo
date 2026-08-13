import { z } from 'zod'
import { PredictionMoneySchema, PredictionSharesSchema, PredictionTimestampSchema } from './common'

/**
 * Entity contracts — one schema per Prisma model, field for field.
 *
 * Money is a string, shares are integers, timestamps are ISO strings; see
 * `./common` for the reasoning. Prisma-optional scalars are `.nullable()`
 * because that is what the API serializes for them — `null`, not an absent key.
 */

// ─── Status enums (mirror the Prisma enums exactly) ───────────────────────────

export const PREDICTION_MARKET_STATUSES = [
    'DRAFT',
    'OPEN',
    'CLOSED',
    'RESOLVING',
    'SETTLED',
    'VOIDED',
] as const

export const PREDICTION_ORDER_STATUSES = ['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED'] as const

export const PREDICTION_POSITION_STATUSES = ['OPEN', 'WON', 'LOST', 'REFUNDED'] as const

export const PredictionMarketStatusSchema = z.enum(PREDICTION_MARKET_STATUSES)
export const PredictionOrderStatusSchema = z.enum(PREDICTION_ORDER_STATUSES)
export const PredictionPositionStatusSchema = z.enum(PREDICTION_POSITION_STATUSES)

export type PredictionMarketStatus = z.infer<typeof PredictionMarketStatusSchema>
export type PredictionOrderStatus = z.infer<typeof PredictionOrderStatusSchema>
export type PredictionPositionStatus = z.infer<typeof PredictionPositionStatusSchema>

/** Orders may only be placed while the market is OPEN. */
export const PREDICTION_TERMINAL_STATUSES: readonly PredictionMarketStatus[] = ['SETTLED', 'VOIDED']

// ─── Models ───────────────────────────────────────────────────────────────────

/**
 * `shareValue` is the denomination of the market, snapshotted at creation. Every
 * price bound, escrow amount and payout is computed from it — it is deliberately
 * per-market data rather than a constant, so a future card can run a different
 * denomination without a migration.
 */
export const PredictionMarketSchema = z.object({
    id: z.string().uuid(),
    eventName: z.string(),
    question: z.string(),
    description: z.string().nullable(),
    imageUrl: z.string().nullable(),
    status: PredictionMarketStatusSchema,
    closesAt: PredictionTimestampSchema,
    resolvesAt: PredictionTimestampSchema.nullable(),
    /** ETB paid by a winning share. Default 100. */
    shareValue: PredictionMoneySchema,
    /** Percent of PROFIT taken from a winning position, never of gross payout. */
    feePct: PredictionMoneySchema,
    minOrderShares: z.number().int(),
    maxOrderShares: z.number().int(),
    /** Matched share pairs. */
    totalShares: PredictionSharesSchema,
    /** ETB escrowed — always `totalShares × shareValue`. */
    totalVolume: PredictionMoneySchema,
    winningOutcomeId: z.string().uuid().nullable(),
    resolvedById: z.string().uuid().nullable(),
    resolvedAt: PredictionTimestampSchema.nullable(),
    disputeUntil: PredictionTimestampSchema.nullable(),
    settledAt: PredictionTimestampSchema.nullable(),
    voidReason: z.string().nullable(),
    createdById: z.string().uuid().nullable(),
    createdAt: PredictionTimestampSchema,
    updatedAt: PredictionTimestampSchema,
})

export const PredictionOutcomeSchema = z.object({
    id: z.string().uuid(),
    marketId: z.string().uuid(),
    label: z.string(),
    /** 0 or 1 — a binary market has exactly two. */
    sortOrder: z.number().int(),
    /** Last traded price for this side; null until the first fill. */
    lastPrice: PredictionMoneySchema.nullable(),
})

/**
 * Money leaves the wallet at order time, not at fill time, so a resting order is
 * always fully funded: `reservedReal + reservedBonus` covers the unfilled
 * remainder plus whatever the fills already consumed, in the proportion it was
 * drawn (bonus first, then real).
 */
export const PredictionOrderSchema = z.object({
    id: z.string().uuid(),
    marketId: z.string().uuid(),
    outcomeId: z.string().uuid(),
    userId: z.string().uuid(),
    /** 1.00 .. shareValue - 1.00, in whole 1 ETB ticks. */
    limitPrice: PredictionMoneySchema,
    quantity: PredictionSharesSchema,
    filledQuantity: PredictionSharesSchema,
    reservedReal: PredictionMoneySchema,
    reservedBonus: PredictionMoneySchema,
    status: PredictionOrderStatusSchema,
    createdAt: PredictionTimestampSchema,
    updatedAt: PredictionTimestampSchema,
})

/**
 * One matched pair. `takerPrice + makerPrice == shareValue` always: the pair
 * escrows exactly one share value per share, which is what makes the book
 * provably solvent and keeps the house out of every position.
 */
export const PredictionFillSchema = z.object({
    id: z.string().uuid(),
    marketId: z.string().uuid(),
    quantity: PredictionSharesSchema,
    takerOrderId: z.string().uuid(),
    makerOrderId: z.string().uuid(),
    takerOutcomeId: z.string().uuid(),
    makerOutcomeId: z.string().uuid(),
    takerPrice: PredictionMoneySchema,
    makerPrice: PredictionMoneySchema,
    createdAt: PredictionTimestampSchema,
})

/**
 * A position remembers how much of it was bonus-funded, because a void refunds
 * `costBasisBonus` to the bonus balance and `costBasisReal` to real — refunding
 * promotional credit as cash would launder it.
 */
export const PredictionPositionSchema = z.object({
    id: z.string().uuid(),
    marketId: z.string().uuid(),
    outcomeId: z.string().uuid(),
    userId: z.string().uuid(),
    shares: PredictionSharesSchema,
    costBasisReal: PredictionMoneySchema,
    costBasisBonus: PredictionMoneySchema,
    status: PredictionPositionStatusSchema,
    payout: PredictionMoneySchema,
    feePaid: PredictionMoneySchema,
    settledAt: PredictionTimestampSchema.nullable(),
    createdAt: PredictionTimestampSchema,
    updatedAt: PredictionTimestampSchema,
})

export type PredictionMarketDto = z.infer<typeof PredictionMarketSchema>
export type PredictionOutcomeDto = z.infer<typeof PredictionOutcomeSchema>
export type PredictionOrderDto = z.infer<typeof PredictionOrderSchema>
export type PredictionFillDto = z.infer<typeof PredictionFillSchema>
export type PredictionPositionDto = z.infer<typeof PredictionPositionSchema>
