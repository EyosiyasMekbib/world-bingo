/**
 * ZareCash withdrawal worker.
 *
 * The player is already debited when this runs. `submitWithdrawal` refunds on a
 * permanent failure and rethrows on a retryable one; when retries are exhausted,
 * the `failed` handler below performs the terminal refund.
 */

import { Worker, Job } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { ZareCashService } from '../services/zarecash.service.js'
import { WalletService } from '../services/wallet.service.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const MAX_ATTEMPTS = Number(process.env.ZARECASH_WITHDRAWAL_ATTEMPTS || '8')

interface ZareCashWithdrawalJobData {
    transactionId: string
    methodCode: string
    destinationAccount: string
    destinationName?: string
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

worker.on('failed', async (job, err) => {
    console.error(`[ZareCashWithdrawalWorker] Job ${job?.id} failed:`, err?.message)
    reportError(err as Error, { worker: 'zarecash-withdrawal' })

    // Retries exhausted: the player is still debited for a payout that was never
    // accepted. Refund is the only safe terminal state.
    if (job && job.attemptsMade >= (job.opts.attempts ?? MAX_ATTEMPTS)) {
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
})

worker.on('error', (err) => {
    console.error('[ZareCashWithdrawalWorker] Worker error:', err.message)
    reportError(err, { worker: 'zarecash-withdrawal' })
})

export default worker
