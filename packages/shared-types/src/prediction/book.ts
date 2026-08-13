import { z } from 'zod'
import { PredictionMoneySchema, PredictionSharesSchema, PredictionTimestampSchema } from './common'

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

/**
 * Price history — the trajectory a probability-over-time chart is drawn from.
 *
 * One point per trade. Because the market is binary, a single line tells the
 * whole story: `price` is the reference outcome's price at that fill, and the
 * other outcome is always `shareValue - price`, so the second line would be a
 * perfect mirror and is not sent. On the default 100 ETB share the price reads
 * directly as that outcome's implied chance in percent.
 *
 * The series is time-ascending (oldest first) so a client can plot it without
 * re-sorting, and empty until the first trade — a market with no fills has no
 * history, which is a real state the chart renders as an empty plot, not an error.
 */
export const PredictionHistoryPointSchema = z.object({
    /** When the trade that set this price happened. */
    t: PredictionTimestampSchema,
    /** The reference outcome's price at this fill, a decimal string in ETB. */
    price: PredictionMoneySchema,
    /** Shares traded in this fill — the point's weight, for optional volume cues. */
    shares: PredictionSharesSchema,
})

export const PredictionPriceHistorySchema = z.object({
    marketId: z.string().uuid(),
    /** The outcome the line tracks — the first outcome (sortOrder 0). */
    outcomeId: z.string().uuid(),
    outcomeLabel: z.string(),
    /** Carried so the client renders price as a percentage without assuming 100. */
    shareValue: PredictionMoneySchema,
    /** Time-ascending; empty until the first trade. */
    points: z.array(PredictionHistoryPointSchema),
})

export type PredictionHistoryPoint = z.infer<typeof PredictionHistoryPointSchema>
export type PredictionPriceHistory = z.infer<typeof PredictionPriceHistorySchema>
