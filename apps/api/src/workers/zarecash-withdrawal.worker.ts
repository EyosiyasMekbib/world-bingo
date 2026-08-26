/**
 * ZareCash withdrawal worker.
 *
 * The player is already debited when this runs. `submitWithdrawal` refunds on a
 * permanent failure and rethrows on a retryable one; when retries are exhausted,
 * the `failed` handler below performs the terminal refund — EXCEPT for
 * `withdrawal_pending`, which stays PENDING_REVIEW for the sweep/admin queue
 * because a payout may genuinely be in flight and refunding could double-pay.
 */

import { Worker, Job } from 'bullmq'
import { QUEUE_NAMES, ZARECASH_WITHDRAWAL_ATTEMPTS } from '../lib/queue.js'
import { ZareCashService } from '../services/zarecash.service.js'
import { WalletService } from '../services/wallet.service.js'
import { reportError } from '../lib/sentry.js'
import { ZareCashError } from '../gateways/payment/zarecash/types.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

export interface ZareCashWithdrawalJobData {
    transactionId: string
    methodCode: string
    destinationAccount: string
    destinationName?: string
}

/**
 * The worker's `failed` handler, pulled out as a standalone export so it can be
 * unit tested without constructing a real BullMQ `Worker` (which would open a
 * live Redis connection at import time — this codebase's other worker tests
 * exercise the underlying service instead; this handler has no service of its
 * own to delegate to, so it is exported directly).
 */
export async function handleWithdrawalFailure(
    job: Job<ZareCashWithdrawalJobData> | undefined,
    err: Error,
): Promise<void> {
    console.error(`[ZareCashWithdrawalWorker] Job ${job?.id} failed:`, err?.message)
    reportError(err as Error, { worker: 'zarecash-withdrawal' })

    if (!job) return

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
    // PENDING_REVIEW — the sweep (Task 11) and the admin queue resolve it from
    // there. Everything else exhausting retries (network errors, persistent
    // 5xxs, timeouts) means we were never able to confirm ZareCash accepted the
    // payout, so the idempotency key makes a refund-then-eventual-replay safe.
    const zc = err as ZareCashError
    if (zc?.code === 'withdrawal_pending') {
        console.error(
            `[ZareCashWithdrawalWorker] tx ${job.data.transactionId} exhausted retries on withdrawal_pending — ` +
                'NOT refunding (payout may be in flight). Left PENDING_REVIEW for the sweep/admin queue.',
        )
        reportError(err as Error, {
            worker: 'zarecash-withdrawal',
            phase: 'withdrawal-pending-exhausted',
            transactionId: job.data.transactionId,
        })
        return
    }

    try {
        await WalletService.rejectWithdrawal(
            job.data.transactionId,
            `Could not reach ZareCash after ${job.attemptsMade} attempts — refunded`,
        )
    } catch (refundErr) {
        console.error('[ZareCashWithdrawalWorker] terminal refund failed:', (refundErr as Error).message)
        reportError(refundErr as Error, { worker: 'zarecash-withdrawal', phase: 'terminal-refund' })
    }
}

const worker = new Worker<ZareCashWithdrawalJobData>(
    QUEUE_NAMES.ZARECASH_WITHDRAWAL,
    async (job: Job<ZareCashWithdrawalJobData>) => {
        await ZareCashService.submitWithdrawal(job.data)
    },
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
