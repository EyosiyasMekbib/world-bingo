/**
 * Deposit Verification Worker
 *
 * Consumes { transactionId } jobs, runs the auto-verification pipeline, and either
 * auto-credits (via WalletService.approveDeposit inside the service) or leaves the
 * deposit for manual review. Rate-limit-aware: a RATE_LIMITED upstream pauses the whole
 * queue and retries without consuming an attempt.
 */

import { Worker, Job } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { DepositVerificationService, RateLimitSignal } from '../services/deposit-verification.service.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

// Static aggregate floor across all instances sharing this queue (env-tunable).
const RATE_MAX = Number(process.env.DEPOSIT_VERIFY_RATE_MAX || '20')
const RATE_WINDOW_MS = Number(process.env.DEPOSIT_VERIFY_RATE_WINDOW_MS || '60000')
// Dynamic cooldown applied when the upstream signals a rate limit.
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.DEPOSIT_VERIFY_COOLDOWN_MS || '30000')

interface DepositVerifyJobData {
    transactionId: string
}

const worker = new Worker<DepositVerifyJobData>(
    QUEUE_NAMES.DEPOSIT_VERIFICATION,
    async (job: Job<DepositVerifyJobData>) => {
        try {
            const result = await DepositVerificationService.runVerification(job.data.transactionId)
            console.log(
                `[DepositVerifyWorker] tx=${job.data.transactionId} → ${result.status} [${result.reasons.join(',')}]`,
            )
            return result
        } catch (err) {
            if (err instanceof RateLimitSignal) {
                await worker.rateLimit(RATE_LIMIT_COOLDOWN_MS)
                throw Worker.RateLimitError()
            }
            throw err
        }
    },
    {
        connection: {
            url: REDIS_URL,
            maxRetriesPerRequest: null as any,
            enableReadyCheck: false,
        } as any,
        concurrency: 1,
        limiter: { max: RATE_MAX, duration: RATE_WINDOW_MS },
    },
)

worker.on('failed', (job, err) => {
    if (err?.name === 'RateLimitError') return // expected pause, not a failure
    console.error(`[DepositVerifyWorker] Job ${job?.id} failed:`, err?.message)
    reportError(err as Error, { worker: 'deposit-verification' })
})

worker.on('error', (err) => {
    console.error('[DepositVerifyWorker] Worker error:', err.message)
    reportError(err, { worker: 'deposit-verification' })
})

export default worker
