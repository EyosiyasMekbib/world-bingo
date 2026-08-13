import { z } from 'zod'
import { PredictionMoneySchema, PredictionSharesSchema } from './common'

/**
 * Aggregated depth. Open orders are grouped by `(outcomeId, limitPrice)` into
 * levels, best price first. There is one book per market quoted on both sides:
 * buying outcome B at `shareValue - p` is the counterparty to buying outcome A
 * at `p`, so the two outcome books are complements of each other.
 */

export const BookLevelSchema = z.object({
    /** Price per share in ETB, as a decimal string. */
    price: PredictionMoneySchema,
    /** Total unfilled shares resting at this price. */
    shares: PredictionSharesSchema,
})

export const OutcomeBookSchema = z.object({
    outcomeId: z.string().uuid(),
    /** Last traded price for this outcome; null until the first fill. */
    lastPrice: PredictionMoneySchema.nullable(),
    /** Best price first. */
    levels: z.array(BookLevelSchema),
})

export const MarketBookSchema = z.object({
    marketId: z.string().uuid(),
    /**
     * Carried on the book so a client can render prices as probabilities and
     * size an order ticket without a second fetch — and without assuming 100.
     */
    shareValue: PredictionMoneySchema,
    outcomes: z.array(OutcomeBookSchema),
})

export type PredictionBookLevel = z.infer<typeof BookLevelSchema>
export type PredictionOutcomeBook = z.infer<typeof OutcomeBookSchema>
export type PredictionMarketBook = z.infer<typeof MarketBookSchema>
