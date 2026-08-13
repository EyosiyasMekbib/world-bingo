import { z } from 'zod'
import {
    PREDICTION_MAX_ORDER_SHARES,
    PREDICTION_MAX_PRICE,
    PREDICTION_PRICE_TICK,
    PredictionTimestampSchema,
} from './common'

/**
 * Request bodies. Inbound money is a NUMBER (that is how a JSON body carries it)
 * and is constrained here so the number → `Prisma.Decimal` conversion at the API
 * boundary is exact: prices and share values are whole birr, `feePct` has at
 * most two decimal places.
 */

// ─── Orders ───────────────────────────────────────────────────────────────────

/**
 * THE TWO-STAGE PRICE CHECK — read this before touching either half.
 *
 * A limit price is only valid against the market it is placed on: the real rule
 * is `1 <= limitPrice <= shareValue - 1` in whole 1 ETB ticks, and `shareValue`
 * is a per-market column that this schema cannot see. So the split is:
 *
 *   1. HERE (static): shape and generic bounds only — a positive whole number of
 *      birr, below an absolute sanity ceiling. This rejects 35.5, 0 and -1, but
 *      it CANNOT reject 100 on a 100 ETB market, because it does not know the
 *      market.
 *   2. SERVER (authoritative): `priceSchema(market.shareValue)` from `./common`,
 *      re-validated inside the order transaction after the market row is read.
 *      That is the check that enforces the upper bound and rejects a free share.
 *
 * Stage 1 is a fast fail for obviously malformed input. Stage 2 is the rule.
 * Never treat a value that passed only stage 1 as a validated price.
 */
export const PredictionLimitPriceSchema = z
    .number()
    .int(`Price must be a whole number of ${PREDICTION_PRICE_TICK} ETB ticks`)
    .min(PREDICTION_PRICE_TICK, `Price must be at least ${PREDICTION_PRICE_TICK} ETB`)
    .lt(PREDICTION_MAX_PRICE, `Price must be below ${PREDICTION_MAX_PRICE} ETB`)

/** The market's own `minOrderShares`/`maxOrderShares` are re-checked server-side. */
export const PredictionQuantitySchema = z
    .number()
    .int('Quantity must be a whole number of shares')
    .positive('Quantity must be at least 1 share')
    .max(PREDICTION_MAX_ORDER_SHARES)

export const PlaceOrderSchema = z.object({
    marketId: z.string().uuid(),
    outcomeId: z.string().uuid(),
    limitPrice: PredictionLimitPriceSchema,
    quantity: PredictionQuantitySchema,
})

// ─── Market admin ─────────────────────────────────────────────────────────────

export const PredictionOutcomeInputSchema = z.object({
    label: z.string().trim().min(1).max(64),
    /** 0 or 1 — a binary market has exactly two sides. */
    sortOrder: z.number().int().min(0).max(1),
})

/**
 * A share value below 2 leaves no valid price between 1 and `shareValue - 1`,
 * and a fractional one has no 1 ETB tick grid — hence whole birr, min 2.
 */
const MarketFieldsShape = z.object({
    eventName: z.string().trim().min(2).max(120),
    question: z.string().trim().min(4).max(240),
    description: z.string().max(2000).nullish(),
    imageUrl: z.string().url().max(500).nullish(),
    closesAt: PredictionTimestampSchema,
    resolvesAt: PredictionTimestampSchema.nullish(),
    shareValue: z
        .number()
        .int('Share value must be a whole number of birr')
        .min(2, 'Share value must be at least 2 ETB')
        .max(PREDICTION_MAX_PRICE)
        .optional(),
    feePct: z
        .number()
        .min(0)
        .max(100)
        .multipleOf(0.01, 'Fee percent supports at most two decimal places')
        .optional(),
    minOrderShares: z.number().int().min(1).max(PREDICTION_MAX_ORDER_SHARES).optional(),
    maxOrderShares: z.number().int().min(1).max(PREDICTION_MAX_ORDER_SHARES).optional(),
})

function refineOrderSizeBounds(
    value: { minOrderShares?: number; maxOrderShares?: number },
    ctx: z.RefinementCtx,
): void {
    if (
        value.minOrderShares !== undefined &&
        value.maxOrderShares !== undefined &&
        value.minOrderShares > value.maxOrderShares
    ) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['maxOrderShares'],
            message: 'Maximum order size must not be below the minimum',
        })
    }
}

export const CreatePredictionMarketSchema = MarketFieldsShape.extend({
    outcomes: z
        .array(PredictionOutcomeInputSchema)
        .length(2, 'A binary market needs exactly 2 outcomes'),
}).superRefine((value, ctx) => {
    refineOrderSizeBounds(value, ctx)

    const orders = value.outcomes.map((outcome) => outcome.sortOrder)
    if (!orders.includes(0) || !orders.includes(1)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['outcomes'],
            message: 'Outcome sortOrder must be 0 and 1',
        })
    }

    const labels = value.outcomes.map((outcome) => outcome.label.toLowerCase())
    if (labels[0] === labels[1]) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['outcomes'],
            message: 'The two outcomes must have different labels',
        })
    }
})

/**
 * Every field optional. Which of them are actually editable depends on status —
 * once a market is OPEN, `question`, `feePct`, `shareValue` and the outcome
 * labels are frozen and only `description`, `imageUrl` and an EXTENDED `closesAt`
 * may change. That freeze is enforced server-side, where the current status is
 * known; a schema cannot express it. Outcome labels are set at creation and are
 * not editable through this body.
 */
export const UpdatePredictionMarketSchema = MarketFieldsShape.partial()
    .superRefine(refineOrderSizeBounds)
    .refine((value) => Object.keys(value).length > 0, 'No fields to update')

export const ResolvePredictionMarketSchema = z.object({
    outcomeId: z.string().uuid(),
})

export const VoidPredictionMarketSchema = z.object({
    reason: z.string().trim().min(3).max(500),
})

export type PlaceOrderDto = z.infer<typeof PlaceOrderSchema>
export type PredictionOutcomeInputDto = z.infer<typeof PredictionOutcomeInputSchema>
export type CreatePredictionMarketDto = z.infer<typeof CreatePredictionMarketSchema>
export type UpdatePredictionMarketDto = z.infer<typeof UpdatePredictionMarketSchema>
export type ResolvePredictionMarketDto = z.infer<typeof ResolvePredictionMarketSchema>
export type VoidPredictionMarketDto = z.infer<typeof VoidPredictionMarketSchema>
