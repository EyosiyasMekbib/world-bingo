/**
 * Prediction Market Gateway — room `prediction:<marketId>`.
 *
 * Four broadcasts, matching the design's Realtime table:
 *
 *   prediction:book     full depth for both sides, coalesced
 *   prediction:trade    one fill, never coalesced
 *   prediction:status   a lifecycle transition
 *   prediction:settled  terminal: payouts credited, fee booked
 *
 * **Why book emits coalesce and trade emits do not.** A single marketable order
 * can sweep a dozen resting orders, and every one of those fills changes the
 * book. Emitting full depth per fill would send twelve payloads describing
 * twelve intermediate states nobody needs — only the final one is true. A trade
 * is the opposite: each fill is a distinct event on the tape, and dropping one
 * loses information that cannot be recovered from the next emit.
 *
 * Coalescing is leading-edge + trailing: the first call broadcasts immediately
 * (so a quiet book stays instant), and any calls arriving inside the following
 * second collapse into a single trailing broadcast. Both read the book fresh at
 * emit time, so the trailing payload reflects the state after the burst, not
 * whatever was true when the emit was requested.
 *
 * Every emit is best-effort: `getIo()` throws before `initSocket` and in unit
 * tests, and a missed broadcast must never fail the transaction that produced
 * it. All money crosses the wire as decimal strings, never as JS numbers.
 */

import type { Prisma } from '@prisma/client'
import { getIo } from '../lib/socket.js'
import prisma from '../lib/prisma.js'
import { PredictionBookService } from '../services/prediction/book.service.js'
import {
    PREDICTION_EVENTS,
    type PredictionBookPayload,
    type PredictionSettledPayload,
    type PredictionStatusPayload,
    type PredictionTradePayload,
} from '@world-bingo/shared-types'

/** At most one book broadcast per market per second. */
const BOOK_COALESCE_MS = 1000

/** A money value as it reaches a gateway: a Decimal from Prisma, or already serialized. */
type MoneyIn = Prisma.Decimal | string

interface BookWindow {
    timer: ReturnType<typeof setTimeout>
    /** Set when another emit is requested while this window is open. */
    trailing: boolean
}

/**
 * Open coalescing windows, keyed by market id.
 *
 * The entry is deleted inside the timer callback — before the trailing
 * broadcast is even attempted — so the map holds at most one entry per market
 * with live traffic and drops back to empty one second after the last fill. A
 * rejected broadcast cannot strand an entry and block the market's future
 * emits, which is the leak this shape exists to prevent.
 */
const bookWindows = new Map<string, BookWindow>()

/**
 * The tail of each market's publish chain.
 *
 * The leading and trailing emits of a coalescing window each run their own book
 * query, and nothing about the two orders their completion: under pool pressure
 * a leading read can take longer than the whole window and broadcast its stale
 * snapshot AFTER the trailing one. Because the trailing emit is usually a
 * market's last, that stale depth would then stand until the next fill — and on
 * a settled or voided market, forever.
 *
 * Chaining the reads makes the last broadcast the last state, always. The entry
 * is dropped once the chain drains, so an idle market holds nothing.
 */
const publishChains = new Map<string, Promise<void>>()

function roomFor(marketId: string): string {
    return `prediction:${marketId}`
}

function toMoneyString(value: MoneyIn): string {
    return typeof value === 'string' ? value : value.toString()
}

function broadcast(marketId: string, event: string, payload: unknown): void {
    try {
        const io = getIo()
        // Prediction events are not in ServerToClientEvents yet — same cast the
        // game gateway uses for its untyped room emits.
        ; (io.to(roomFor(marketId)) as any).emit(event, payload)
    } catch {
        // Socket server not initialised (tests, or a worker process). Realtime
        // is an optimisation; the REST read is always authoritative.
    }
}

/**
 * Client room entry. Wired from `index.ts` beside `registerGameHandlers`, right
 * after `initSocket`, so browsers can subscribe to a market.
 */
export function registerPredictionHandlers(io: any) {
    io.on('connection', (socket: any) => {
        socket.on('prediction:join-room', ({ marketId }: { marketId: string }) => {
            if (typeof marketId === 'string' && marketId) socket.join(roomFor(marketId))
        })

        socket.on('prediction:leave-room', ({ marketId }: { marketId: string }) => {
            if (typeof marketId === 'string' && marketId) socket.leave(roomFor(marketId))
        })
    })
}

/** Read the book as it stands right now and broadcast it. Never throws. */
async function publishBook(marketId: string): Promise<void> {
    try {
        const book = await PredictionBookService.getBook(marketId)
        const payload: PredictionBookPayload = {
            marketId: book.marketId,
            outcomes: book.outcomes,
        }
        broadcast(marketId, PREDICTION_EVENTS.BOOK, payload)
    } catch (err: any) {
        console.error(`[PredictionGateway] Book emit failed for ${marketId}:`, err?.message)
    }
}

/**
 * Queue a book read behind whatever is already reading this market's book, so
 * the broadcasts leave in the order they were requested. `publishBook` never
 * throws, so the chain cannot be poisoned by one failed read.
 */
function queuePublish(marketId: string): void {
    const previous = publishChains.get(marketId) ?? Promise.resolve()
    const next = previous.then(() => publishBook(marketId))

    publishChains.set(marketId, next)

    void next.then(() => {
        // Only the tail clears the entry; an earlier link finishing must not
        // drop a chain that still has work queued behind it.
        if (publishChains.get(marketId) === next) publishChains.delete(marketId)
    })
}

/**
 * Request a book broadcast. Fire-and-forget: the caller is usually finishing a
 * matching transaction and must not await, or fail on, a socket write.
 */
export function emitBook(marketId: string): void {
    const open = bookWindows.get(marketId)

    if (open) {
        // Inside the window — collapse into one trailing emit.
        open.trailing = true
        return
    }

    queuePublish(marketId)

    const timer = setTimeout(() => {
        const window = bookWindows.get(marketId)
        // Delete first: the entry's only job is to suppress emits for one
        // second, and it has now done it.
        bookWindows.delete(marketId)
        if (window?.trailing) queuePublish(marketId)
    }, BOOK_COALESCE_MS)

    // A pending coalesce must not hold the process (or a vitest run) open.
    ; (timer as any).unref?.()

    bookWindows.set(marketId, { timer, trailing: false })
}

/**
 * One fill, from the perspective of one side. The matching engine calls this
 * once per outcome per fill — the two sides trade at complementary prices that
 * sum to the market's `shareValue`.
 */
export function emitTrade(marketId: string, outcomeId: string, price: MoneyIn, quantity: number): void {
    const payload: PredictionTradePayload = {
        marketId,
        outcomeId,
        price: toMoneyString(price),
        quantity,
        at: new Date().toISOString(),
    }
    broadcast(marketId, PREDICTION_EVENTS.TRADE, payload)
}

/**
 * A lifecycle transition. Reads the market so the payload always reports the
 * committed status rather than what the caller believed it was setting.
 */
export async function emitStatus(marketId: string): Promise<void> {
    try {
        const market = await prisma.predictionMarket.findUnique({
            where: { id: marketId },
            select: { id: true, status: true, winningOutcomeId: true, disputeUntil: true },
        })

        if (!market) return

        const payload: PredictionStatusPayload = {
            marketId: market.id,
            status: market.status,
            winningOutcomeId: market.winningOutcomeId,
            disputeUntil: market.disputeUntil ? market.disputeUntil.toISOString() : null,
        }
        broadcast(marketId, PREDICTION_EVENTS.STATUS, payload)
    } catch (err: any) {
        console.error(`[PredictionGateway] Status emit failed for ${marketId}:`, err?.message)
    }
}

/** Terminal broadcast: winners paid, house fee booked. */
export function emitSettled(
    marketId: string,
    winningOutcomeId: string,
    totalShares: number,
    totalFee: MoneyIn,
): void {
    const payload: PredictionSettledPayload = {
        marketId,
        winningOutcomeId,
        totalShares,
        totalFee: toMoneyString(totalFee),
    }
    broadcast(marketId, PREDICTION_EVENTS.SETTLED, payload)
}

/**
 * Drop every pending coalesce window. For shutdown and for tests that would
 * otherwise leave a timer behind between cases.
 */
export function clearBookCoalescing(): void {
    for (const window of bookWindows.values()) {
        clearTimeout(window.timer)
    }
    bookWindows.clear()
    publishChains.clear()
}
