/**
 * Account status expiry.
 *
 * A restriction or suspension can carry an `expiresAt`. Nothing else lifts it:
 * without this pass a "48-hour hold" is a hold until somebody remembers, which
 * is the same failure mode the whole feature exists to remove.
 *
 * Runs hourly and reinstates through AccountStatusService like any other
 * transition, so the lift gets its own history row and audit entry with a null
 * actor — an account that came back on its own should say so.
 */

import { Worker, Job, Queue } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { AccountStatusService } from '../services/account-status.service.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

const connection = {
    url: REDIS_URL,
    maxRetriesPerRequest: null as any,
    enableReadyCheck: false,
} as any

const queue = new Queue(QUEUE_NAMES.ACCOUNT_STATUS_EXPIRY, {
    connection: { ...connection, lazyConnect: true },
})

/** Exported for unit tests — the sweep body without a live Worker. */
export async function processAccountStatusExpiry(): Promise<{ lifted: number; failed: number }> {
    const due = await AccountStatusService.findExpired()
    let lifted = 0
    let failed = 0

    for (const userId of due) {
        try {
            await AccountStatusService.reinstate(userId, {
                reason: 'Restriction expired',
                actorId: null,
            })
            lifted += 1
        } catch (err) {
            // One account that cannot be reinstated must not strand the rest of
            // the batch behind it.
            failed += 1
            console.error(
                '[AccountStatusExpiry] could not reinstate %s: %s',
                userId,
                (err as Error)?.message,
            )
        }
    }

    return { lifted, failed }
}

const worker = new Worker(
    QUEUE_NAMES.ACCOUNT_STATUS_EXPIRY,
    async (_job: Job) => {
        const result = await processAccountStatusExpiry()
        if (result.lifted || result.failed) {
            console.log(
                '[AccountStatusExpiry] lifted=%d failed=%d',
                result.lifted,
                result.failed,
            )
        }
        return result
    },
    { connection, concurrency: 1 },
)

async function setupRepeatingJob(): Promise<void> {
    await queue.add(
        'sweep-expired-status',
        {},
        {
            repeat: { every: SWEEP_INTERVAL_MS },
            jobId: 'account-status-expiry-sweep',
            removeOnComplete: { count: 24 },
            removeOnFail: { count: 24 },
        },
    )
}

setupRepeatingJob().catch((err) => {
    console.error('[AccountStatusExpiry] failed to schedule:', err?.message)
})

worker.on('failed', (job, err) => {
    console.error(`[AccountStatusExpiry] job ${job?.id} failed:`, err?.message)
    reportError(err as Error, { worker: 'account-status-expiry' })
})

export default worker
