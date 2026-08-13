import { z } from 'zod'
import { PredictionMoneySchema, PredictionSharesSchema, PredictionTimestampSchema } from './common'
import { OutcomeBookSchema } from './book'
import { PredictionMarketStatusSchema } from './market'

/**
 * Socket payloads, broadcast to the room `prediction:<marketId>`.
 *
 * Book emits coalesce to at most one per second per market; trade emits do not
 * coalesce — every fill is a discrete event.
 */

export const PREDICTION_EVENTS = {
    BOOK: 'prediction:book',
    TRADE: 'prediction:trade',
    STATUS: 'prediction:status',
    SETTLED: 'prediction:settled',
} as const

export type PredictionEventName = (typeof PREDICTION_EVENTS)[keyof typeof PREDICTION_EVENTS]

/** Full depth for both sides after a change. */
export const PredictionBookPayloadSchema = z.object({
    marketId: z.string().uuid(),
    outcomes: z.array(OutcomeBookSchema),
})

/** One fill: the price that side traded at and how many shares changed hands. */
export const PredictionTradePayloadSchema = z.object({
    marketId: z.string().uuid(),
    outcomeId: z.string().uuid(),
    price: PredictionMoneySchema,
    quantity: PredictionSharesSchema,
    at: PredictionTimestampSchema,
})

/** Lifecycle transition. `winningOutcomeId`/`disputeUntil` appear from RESOLVING on. */
export const PredictionStatusPayloadSchema = z.object({
    marketId: z.string().uuid(),
    status: PredictionMarketStatusSchema,
    winningOutcomeId: z.string().uuid().nullish(),
    disputeUntil: PredictionTimestampSchema.nullish(),
})

/** Terminal: payouts are credited and the house fee is booked. */
export const PredictionSettledPayloadSchema = z.object({
    marketId: z.string().uuid(),
    winningOutcomeId: z.string().uuid(),
    /** Matched share pairs in the market. */
    totalShares: PredictionSharesSchema,
    /** Total fee taken from winners' profit, as a decimal string. */
    totalFee: PredictionMoneySchema,
})

export type PredictionBookPayload = z.infer<typeof PredictionBookPayloadSchema>
export type PredictionTradePayload = z.infer<typeof PredictionTradePayloadSchema>
export type PredictionStatusPayload = z.infer<typeof PredictionStatusPayloadSchema>
export type PredictionSettledPayload = z.infer<typeof PredictionSettledPayloadSchema>

/** Server → client map for the prediction room, mergeable into the socket types. */
export interface PredictionServerToClientEvents {
    'prediction:book': (payload: PredictionBookPayload) => void
    'prediction:trade': (payload: PredictionTradePayload) => void
    'prediction:status': (payload: PredictionStatusPayload) => void
    'prediction:settled': (payload: PredictionSettledPayload) => void
}
