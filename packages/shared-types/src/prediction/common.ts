import { z } from 'zod'

/**
 * Wire primitives for the binary order-book prediction market.
 *
 * THE WIRE CONVENTION, stated once and applied everywhere in this directory:
 *
 * - **Money and prices are strings on the way out.** Every one of these is a
 *   Prisma `Decimal` in the database, and a Decimal serializes to a decimal
 *   string. They are never parsed into a JS number by shared code — the server
 *   rebuilds a `Prisma.Decimal` from the string, the client renders it.
 * - **Share counts are numbers**, because shares are integers by construction.
 * - **Inbound prices are numbers** (`limitPrice`, `shareValue`, `feePct`) because
 *   a JSON request body carries them that way. They are constrained to whole
 *   1 ETB ticks (or, for `feePct`, two decimal places) so the number → Decimal
 *   conversion at the API boundary is exact.
 * - **Timestamps are ISO-8601 strings** in both directions.
 *
 * These schemas therefore describe the JSON on the wire, not a live Prisma row.
 * A row must be serialized before it will parse.
 */

/**
 * A money amount as it appears on the wire: the string form of a Decimal.
 * Accepts both '100' and '100.00' — Decimal.js drops trailing zeroes — and a
 * leading '-' for the columns that can legitimately go negative.
 */
export const PredictionMoneySchema = z
    .string()
    .regex(/^-?\d+(\.\d+)?$/, 'Expected a decimal amount as a string')

/** Share counts are whole. Never a Decimal, never a fraction. */
export const PredictionSharesSchema = z.number().int().nonnegative()

/** ISO-8601, with a 'Z' or an explicit offset. */
export const PredictionTimestampSchema = z.string().datetime({ offset: true })

/**
 * Prices move in whole 1 ETB ticks. On the default 100 ETB share that is one
 * probability point per tick, which is what makes the price readable as a
 * percentage.
 */
export const PREDICTION_PRICE_TICK = 1

/**
 * Static ceiling for a price arriving from a client, used only where the
 * market's own `shareValue` is not known at parse time. It is a sanity bound,
 * NOT the real limit — see `priceSchema`.
 */
export const PREDICTION_MAX_PRICE = 100_000

/** Sanity ceiling on any share quantity; the market's own bounds are tighter. */
export const PREDICTION_MAX_ORDER_SHARES = 1_000_000

const WHOLE_BIRR = /^(\d+)(?:\.(\d+))?$/

/**
 * Reads a whole-birr amount out of a money value.
 *
 * This is integer parsing, not a float parse of money: the fractional part is
 * inspected as text and rejected unless it is all zeroes, then only the integer
 * digits are converted. A share value carrying a real fraction has no valid
 * 1 ETB tick grid, so it cannot produce a price schema at all.
 */
export function toWholeBirr(value: number | string): number {
    const raw = typeof value === 'number' ? String(value) : value.trim()
    const match = WHOLE_BIRR.exec(raw)
    if (!match) {
        throw new Error(`Not a positive decimal amount: ${raw}`)
    }
    if (match[2] && /[1-9]/.test(match[2])) {
        throw new Error(`Amount ${raw} is not a whole number of birr`)
    }
    return Number.parseInt(match[1], 10)
}

/**
 * The real price rule, built from a market's actual `shareValue`.
 *
 * Valid limit prices are `1 .. shareValue - 1` in whole 1 ETB ticks. The bounds
 * exist because `shareValue` would be a free share and `0` a free option, and
 * because a matched pair must escrow exactly `shareValue`: a buy at `p` on one
 * outcome is a sale at `shareValue - p` on the other, so both ends must be
 * strictly inside the range.
 *
 * Pass the market's `shareValue` — a number of birr or its Decimal string. Never
 * a hardcoded 100.
 */
export function priceSchema(shareValue: number | string) {
    const share = toWholeBirr(shareValue)
    const max = share - PREDICTION_PRICE_TICK

    if (max < PREDICTION_PRICE_TICK) {
        throw new Error(`Share value ${share} leaves no valid price between 1 and ${max}`)
    }

    return z
        .number()
        .int(`Price must be a whole number of ${PREDICTION_PRICE_TICK} ETB ticks`)
        .min(PREDICTION_PRICE_TICK, `Price must be at least ${PREDICTION_PRICE_TICK} ETB`)
        .max(max, `Price must be at most ${max} ETB on a ${share} ETB share`)
}
