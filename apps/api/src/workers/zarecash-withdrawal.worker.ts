/**
 * ZareCash withdrawal worker.
 *
 * The player is already debited when this runs. `submitWithdrawal` refunds on a
 * permanent failure and rethrows on a retryable one; when retries are exhausted,
 * the `failed` handler below performs the terminal refund — EXCEPT when we have
 * ever seen `withdrawal_pending` on this job, which stays PENDING_REVIEW for the
 * sweep/admin queue because a payout may genuinely be in flight and refunding
 * could double-pay.
 */

import { Worker, Job } from 'bullmq'
import { getQueue, QUEUE_NAMES, ZARECASH_WITHDRAWAL_ATTEMPTS } from '../lib/queue.js'
import { ZareCashService } from '../services/zarecash.service.js'
import { WalletService } from '../services/wallet.service.js'
import { reportError } from '../lib/sentry.js'
import { ZareCashError } from '../gateways/payment/zarecash/types.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

/** Job name for the retryable terminal refund enqueued by the failure handler. */
export const TERMINAL_REFUND_JOB = 'terminal-refund'

export interface ZareCashWithdrawalJobData {
    transactionId: string
    methodCode: string
    destinationAccount: string
    destinationName?: string
    /**
     * Sticky across attempts: set the first time ANY attempt sees a
     * `withdrawal_pending` 409.
     *
     * The refund gate used to read only the FINAL error, which meant seven
     * attempts of `withdrawal_pending` followed by a single `network_error` on
     * the last attempt fired the terminal refund — refunding a payout ZareCash
     * has genuinely open, which is precisely the double-pay this gate exists to
     * prevent. Network errors are common during exactly the provider trouble
     * that produces state disagreement, so the marker has to outlive the attempt
     * that produced it.
     */
    sawWithdrawalPending?: boolean
}

export interface ZareCashTerminalRefundJobData {
    transactionId: string
    reason: string
}

/**
 * The worker's job processor, exported so the retry/stickiness behaviour can be
 * unit tested without constructing a real BullMQ `Worker` (which would open a
 * live Redis connection at import time).
 */
export async function processWithdrawalJob(
    job: Job<ZareCashWithdrawalJobData | ZareCashTerminalRefundJobData>,
): Promise<void> {
    if (job.name === TERMINAL_REFUND_JOB) {
        const data = job.data as ZareCashTerminalRefundJobData
        await refundOrTolerateTerminal(data.transactionId, data.reason)
        return
    }

    const data = job.data as ZareCashWithdrawalJobData
    try {
        await ZareCashService.submitWithdrawal(data)
    } catch (err) {
        if ((err as ZareCashError)?.code === 'withdrawal_pending' && !data.sawWithdrawalPending) {
            try {
                await job.updateData({ ...data, sawWithdrawalPending: true })
            } catch (markErr) {
                // Losing the marker means a later network_error could wrongly
                // trigger the terminal refund, so this must be visible — but it
                // must never replace the original failure, which is what BullMQ
                // and the failure handler need to see.
                console.error(
                    '[ZareCashWithdrawalWorker] could not persist withdrawal_pending marker on job %s:',
                    job.id,
                    (markErr as Error).message,
                )
                reportError(markErr as Error, {
                    worker: 'zarecash-withdrawal',
                    phase: 'withdrawal-pending-marker',
                    transactionId: data.transactionId,
                })
            }
        }
        throw err
    }
}

/**
 * Refund a payout, tolerating only the one benign outcome: the row is no longer
 * pending because something else already resolved it. Every other failure is
 * rethrown so BullMQ retries — a swallowed failure here leaves the player
 * permanently debited for a payout nobody sent.
 */
async function refundOrTolerateTerminal(transactionId: string, reason: string): Promise<void> {
    try {
        await WalletService.rejectWithdrawal(transactionId, reason)
    } catch (err) {
        if ((err as Error).message === 'Transaction is not pending review') {
            console.log(
                '[ZareCashWithdrawalWorker] tx %s already resolved — terminal refund not needed',
                transactionId,
            )
            return
        }
        throw err
    }
}

/**
 * The worker's `failed` handler, pulled out as a standalone export so it can be
 * unit tested without constructing a real BullMQ `Worker` (which would open a
 * live Redis connection at import time — this codebase's other worker tests
 * exercise the underlying service instead; this handler has no service of its
 * own to delegate to, so it is exported directly).
 */
export async function handleWithdrawalFailure(
    job: Job<ZareCashWithdrawalJobData | ZareCashTerminalRefundJobData> | undefined,
    err: Error,
): Promise<void> {
    console.error(`[ZareCashWithdrawalWorker] Job ${job?.id} failed:`, err?.message)
    reportError(err as Error, { worker: 'zarecash-withdrawal' })

    if (!job) return

    // A terminal-refund job that has exhausted ITS retries must not recurse into
    // another terminal refund. Nothing further is automatic from here: the player
    // is still debited and the row is still PENDING_REVIEW behind the admin
    // guard, so this has to be unmistakable.
    if (job.name === TERMINAL_REFUND_JOB) {
        console.error(
            '[ZareCashWithdrawalWorker] terminal refund for tx %s exhausted its own retries — ' +
                'the player is STILL DEBITED and needs manual intervention',
            (job.data as ZareCashTerminalRefundJobData).transactionId,
        )
        reportError(err as Error, {
            worker: 'zarecash-withdrawal',
            phase: 'terminal-refund-exhausted',
            transactionId: (job.data as ZareCashTerminalRefundJobData).transactionId,
        })
        return
    }

    const data = job.data as ZareCashWithdrawalJobData

    // job.opts.attempts is the number BullMQ actually used for this job — the
    // producer (wallet.service.ts) passes ZARECASH_WITHDRAWAL_ATTEMPTS explicitly
    // on `.add()` so this should always equal the shared constant. Surface it
    // loudly if it ever doesn't, since that means the producer and this worker
    // have drifted (e.g. a caller enqueuing without the option).
    if (job.opts.attempts !== ZARECASH_WITHDRAWAL_ATTEMPTS) {
        console.warn(
            `[ZareCashWithdrawalWorker] job ${job.id} was enqueued with attempts=${job.opts.attempts}, ` +
                `expected ${ZARECASH_WITHDRAWAL_ATTEMPTS} — producer and worker have drifted`,
        )
    }

    // Defensive fallback: if `attempts` were ever absent from job.opts, BullMQ's
    // own default is 1 attempt (no retries) — so assume 1 here too. The wrong
    // direction for a refund gate is a fallback that waits for a count BullMQ
    // never actually uses; that would silently suppress the refund forever
    // instead of firing it after the single attempt BullMQ really made.
    const effectiveAttempts = job.opts.attempts ?? 1
    if (job.attemptsMade < effectiveAttempts) return

    // Retries exhausted. `withdrawal_pending` is the one case that must NOT
    // refund here: it means our state and ZareCash's disagree, and a payout may
    // genuinely be in flight. Refunding would double-pay. Leave the row
    // PENDING_REVIEW — the sweep and the admin queue resolve it from there.
    //
    // The check is on the STICKY marker as well as the final error: having seen
    // `withdrawal_pending` even once on this job is enough to disqualify the
    // refund forever, because a later network_error tells us nothing about
    // whether that in-flight payout landed. Everything else exhausting retries
    // (network errors, persistent 5xxs, timeouts) means we were never able to
    // confirm ZareCash accepted the payout, so the idempotency key makes a
    // refund-then-eventual-replay safe.
    const zc = err as ZareCashError
    if (zc?.code === 'withdrawal_pending' || data.sawWithdrawalPending) {
        console.error(
            `[ZareCashWithdrawalWorker] tx ${data.transactionId} exhausted retries after seeing withdrawal_pending — ` +
                'NOT refunding (payout may be in flight). Left PENDING_REVIEW for the sweep/admin queue.',
        )
        reportError(err as Error, {
            worker: 'zarecash-withdrawal',
            phase: 'withdrawal-pending-exhausted',
            transactionId: data.transactionId,
            finalErrorCode: zc?.code,
            stickyMarker: data.sawWithdrawalPending === true,
        })
        return
    }

    const reason = `Could not reach ZareCash after ${job.attemptsMade} attempts — refunded`

    try {
        await refundOrTolerateTerminal(data.transactionId, reason)
        return
    } catch (refundErr) {
        // A genuine refund failure — a DB blip, an exhausted pool. This used to be
        // logged and dropped, which left the player permanently debited for a
        // payout that was never sent, with nothing anywhere that would ever try
        // again. Hand it to BullMQ so it actually gets retried.
        console.error(
            '[ZareCashWithdrawalWorker] terminal refund failed, re-enqueuing for retry:',
            (refundErr as Error).message,
        )
        reportError(refundErr as Error, {
            worker: 'zarecash-withdrawal',
            phase: 'terminal-refund',
            transactionId: data.transactionId,
        })
    }

    try {
        await getQueue(QUEUE_NAMES.ZARECASH_WITHDRAWAL).add(
            TERMINAL_REFUND_JOB,
            { transactionId: data.transactionId, reason },
            { attempts: ZARECASH_WITHDRAWAL_ATTEMPTS },
        )
    } catch (enqueueErr) {
        // Both the direct refund and the retry enqueue failed. Nothing automatic
        // remains; the player is debited and the row sits PENDING_REVIEW.
        console.error(
            '[ZareCashWithdrawalWorker] could not enqueue the terminal refund retry for tx %s — ' +
                'the player is STILL DEBITED and needs manual intervention:',
            data.transactionId,
            (enqueueErr as Error).message,
        )
        reportError(enqueueErr as Error, {
            worker: 'zarecash-withdrawal',
            phase: 'terminal-refund-unrecoverable',
            transactionId: data.transactionId,
        })
    }
}

const worker = new Worker<ZareCashWithdrawalJobData | ZareCashTerminalRefundJobData>(
    QUEUE_NAMES.ZARECASH_WITHDRAWAL,
    processWithdrawalJob,
    {
        connection: {
            url: REDIS_URL,
            maxRetriesPerRequest: null as any,
            enableReadyCheck: false,
        } as any,
        concurrency: 2,
    },
)

worker.on('failed', handleWithdrawalFailure)

worker.on('error', (err) => {
    console.error('[ZareCashWithdrawalWorker] Worker error:', err.message)
    reportError(err, { worker: 'zarecash-withdrawal' })
})

export default worker
