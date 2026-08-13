/**
 * Prediction Market Worker
 *
 * Three jobs on the `prediction` queue:
 *
 *   close-due-markets  repeatable, 30s — OPEN markets past `closesAt` become CLOSED
 *   settle-market      delayed to `disputeUntil`, jobId `settle:<marketId>:<resolvedAt>`
 *   void-market        on demand — the refund path
 *
 * The settle job id is DERIVABLE but not shared across resolutions. Derivable so
 * `unresolve` and the boot recovery below can name a job they did not create;
 * stamped with `resolvedAt` because BullMQ ignores an `add` whose jobId already
 * exists in any state, completed included — a bare `settle:<marketId>` would let
 * one finished attempt block every later one, silently. Within one resolution the
 * id is still stable, so the recovery below cannot double-schedule a payout.
 *
 * This module deliberately exports nothing but the worker. Anything that
 * imports it starts a BullMQ `Worker`, so services enqueue through
 * `getQueue(QUEUE_NAMES.PREDICTION)` rather than through a helper here.
 */

import { Worker, Job, Queue } from 'bullmq'
import { QUEUE_NAMES, getQueue } from '../lib/queue.js'
import prisma from '../lib/prisma.js'
import { PredictionMarketService, predictionSettleJobId } from '../services/prediction/market.service.js'
import { PredictionSettlementService } from '../services/prediction/settlement.service.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

/** Markets close on a 30s tick — a bout starts within half a minute of `closesAt`. */
const CLOSE_INTERVAL_MS = 30 * 1000

const JOB_CLOSE_DUE = 'close-due-markets'
const JOB_SETTLE = 'settle-market'
const JOB_VOID = 'void-market'

export interface PredictionJobData {
    marketId?: string
    reason?: string
}

const worker = new Worker<PredictionJobData>(
    QUEUE_NAMES.PREDICTION,
    async (job: Job<PredictionJobData>) => {
        switch (job.name) {
            case JOB_CLOSE_DUE: {
                const closed = await PredictionMarketService.closeDueMarkets()
                const count = closedCount(closed)
                // Silent on an idle tick — this runs twice a minute forever.
                if (count) console.log(`[PredictionWorker] Closed ${count} due market(s)`)
                return { closed: count }
            }

            case JOB_SETTLE: {
                const { marketId } = job.data
                if (!marketId) throw new Error('settle-market job is missing marketId')

                console.log(`[PredictionWorker] Settling market ${marketId}`)
                const result = await PredictionSettlementService.settleMarket(marketId)

                // Settlement no-ops quietly on a duplicate job, an open dispute
                // window, or an already-settled market — report which, rather
                // than logging a payout that did not happen.
                console.log(
                    result.settled
                        ? `[PredictionWorker] Settled ${marketId}: ${result.positionsWon} won, ` +
                        `${result.positionsLost} lost, ${result.ordersRefunded} order(s) refunded, ` +
                        `fee ${result.totalFee.toString()} ETB`
                        : `[PredictionWorker] Settle skipped for ${marketId}: ${result.reason ?? 'no reason given'}`,
                )
                return result
            }

            case JOB_VOID: {
                const { marketId } = job.data
                if (!marketId) throw new Error('void-market job is missing marketId')

                // A void always records why; a draw or no-contest enqueued without
                // one still must not write an empty reason onto the market.
                const reason = job.data.reason || 'Market voided'

                console.log(`[PredictionWorker] Voiding market ${marketId} — ${reason}`)
                const result = await PredictionSettlementService.voidMarket(marketId, reason)

                console.log(
                    result.voided
                        ? `[PredictionWorker] Voided ${marketId}: ${result.positionsRefunded} position(s) and ` +
                        `${result.ordersRefunded} order(s) refunded, ${result.totalRefunded.toString()} ETB returned`
                        : `[PredictionWorker] Void skipped for ${marketId}: ${result.reason ?? 'no reason given'}`,
                )
                return result
            }

            default:
                throw new Error(`[PredictionWorker] Unknown job name: ${job.name}`)
        }
    },
    {
        connection: {
            url: REDIS_URL,
            maxRetriesPerRequest: null as any,
            enableReadyCheck: false,
        } as any,
        // Settlement guards itself with a per-market Redlock and status-filtered
        // batches, so parallel jobs are safe and a long payout does not stall the
        // close tick behind it.
        concurrency: 3,
    },
)

/** `closeDueMarkets`' return shape is its own service's business; count it without assuming one. */
function closedCount(result: unknown): number {
    if (typeof result === 'number') return result
    if (Array.isArray(result)) return result.length
    if (result && typeof result === 'object' && typeof (result as any).count === 'number') {
        return (result as any).count
    }
    return 0
}

/**
 * Re-arm the repeatable close tick.
 *
 * BullMQ keys a repeatable by its name *and* its repeat options, so changing the
 * interval leaves the old schedule in Redis running alongside the new one — the
 * stacking every other worker in this repo clears the same way. Removing all
 * repeatables on the prediction queue first is safe because this worker owns
 * every repeatable on it.
 */
async function setupRepeatingJob(queue: Queue<PredictionJobData>) {
    const repeatableJobs = await queue.getRepeatableJobs()
    for (const rj of repeatableJobs) {
        await queue.removeRepeatableByKey(rj.key)
    }

    await queue.add(
        JOB_CLOSE_DUE,
        {},
        {
            repeat: { every: CLOSE_INTERVAL_MS },
            removeOnComplete: { count: 20 },
            removeOnFail: { count: 20 },
        },
    )

    console.log(`[PredictionWorker] Repeating close job set up (every ${CLOSE_INTERVAL_MS / 1000}s)`)
}

/**
 * A market left in RESOLVING has a payout that was scheduled as a delayed job.
 * If the process died before it ran — or Redis was flushed — nothing would ever
 * pay those winners out, so re-enqueue on boot with the remaining dispute
 * window. The id derived from `resolvedAt` makes this a no-op when the original
 * delayed job for THAT resolution is still sitting in Redis, while still letting
 * a fresh resolution schedule its own.
 */
async function requeueStuckSettlements(queue: Queue<PredictionJobData>) {
    const stuck = await prisma.predictionMarket.findMany({
        where: { status: 'RESOLVING' },
        select: { id: true, disputeUntil: true, resolvedAt: true },
    })

    if (stuck.length === 0) return

    const now = Date.now()
    let requeued = 0

    for (const market of stuck) {
        // Without `resolvedAt` there is no id to schedule under. A RESOLVING row
        // that lacks it is corrupt, not routine — say so rather than invent one.
        if (!market.resolvedAt) {
            console.error(
                `[PredictionWorker] Market ${market.id} is RESOLVING with no resolvedAt — cannot schedule its payout`,
            )
            continue
        }

        // A dispute window that has already expired settles immediately.
        const delay = Math.max(0, (market.disputeUntil?.getTime() ?? now) - now)

        await queue.add(
            JOB_SETTLE,
            { marketId: market.id },
            {
                jobId: predictionSettleJobId(market.id, market.resolvedAt),
                delay,
                removeOnComplete: { count: 50 },
                removeOnFail: { count: 50 },
            },
        )
        requeued += 1
    }

    console.log(`[PredictionWorker] Re-enqueued settlement for ${requeued} market(s) in RESOLVING`)
}

async function setup() {
    const queue = getQueue(QUEUE_NAMES.PREDICTION) as Queue<PredictionJobData>
    await setupRepeatingJob(queue)
    await requeueStuckSettlements(queue)
}

setup().catch((err) => {
    console.error('[PredictionWorker] Failed to set up jobs:', err.message)
    reportError(err, { worker: 'prediction', phase: 'setup' })
})

worker.on('completed', (job) => {
    console.log(`[PredictionWorker] Job ${job.name}:${job.id} completed`)
})

worker.on('failed', (job, err) => {
    console.error(`[PredictionWorker] Job ${job?.name}:${job?.id} failed:`, err.message)
    reportError(err, { worker: 'prediction', job: job?.name, marketId: job?.data?.marketId })
})

worker.on('error', (err) => {
    console.error('[PredictionWorker] Worker error:', err.message)
    reportError(err, { worker: 'prediction' })
})

export default worker
