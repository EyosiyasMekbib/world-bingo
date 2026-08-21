/**
 * Bonus Expiry Worker
 *
 * Runs every 15 minutes: finds every ACTIVE lot past its expiresAt, expires it
 * per-user inside one transaction (BonusService.expireForUser), and writes a
 * BONUS_EXPIRED transaction so a balance dropping overnight has an audit row.
 */

import { Worker, Job, Queue } from 'bullmq'
import { Decimal } from '@prisma/client/runtime/library'
import { QUEUE_NAMES } from '../lib/queue.js'
import prisma from '../lib/prisma.js'
import { BonusService } from '../services/bonus.service.js'
import { NotificationService } from '../services/notification.service.js'
import { TransactionType, PaymentStatus } from '@world-bingo/shared-types'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const SWEEP_INTERVAL_MS = 15 * 60 * 1000

export interface BonusExpiryJobData {
    action: 'sweep'
}

const bonusExpiryQueue = new Queue<BonusExpiryJobData>(QUEUE_NAMES.BONUS_EXPIRY, {
    connection: {
        url: REDIS_URL,
        maxRetriesPerRequest: null as any,
        enableReadyCheck: false,
        lazyConnect: true,
    } as any,
})

export async function sweepExpiredBonuses(): Promise<{ usersProcessed: number; totalExpired: string }> {
    const now = new Date()
    // See the identical note in BonusService.expireForUser — bind the ISO
    // string and cast explicitly; a raw Date here would compare against
    // "expiresAt" (naive timestamp) using the session timezone.
    const nowUtc = now.toISOString()
    const dueUsers = await prisma.$queryRaw<Array<{ userId: string }>>`
        SELECT DISTINCT "userId" FROM bonus_grants WHERE status = 'ACTIVE' AND "expiresAt" <= ${nowUtc}::timestamp
    `

    let usersProcessed = 0
    let totalExpired = new Decimal(0)

    for (const { userId } of dueUsers) {
        const result = await prisma.$transaction(async (tx) => {
            const expireResult = await BonusService.expireForUser(tx, userId, now)
            if (!expireResult) return null
            await tx.transaction.create({
                data: {
                    userId,
                    type: TransactionType.BONUS_EXPIRED,
                    amount: expireResult.expired,
                    status: PaymentStatus.APPROVED,
                    note: 'Bonus expired',
                    bonusBalanceBefore: expireResult.bonusBalanceBefore,
                    bonusBalanceAfter: expireResult.bonusBalanceAfter,
                },
            })
            return expireResult
        })
        if (!result) continue

        usersProcessed++
        totalExpired = totalExpired.plus(result.expired)

        const wallet = await prisma.wallet.findUnique({ where: { userId } })
        if (wallet) {
            NotificationService.pushWalletUpdate(userId, Number(wallet.realBalance), Number(wallet.bonusBalance))
        }
    }

    return { usersProcessed, totalExpired: totalExpired.toFixed(2) }
}

const worker = new Worker<BonusExpiryJobData>(
    QUEUE_NAMES.BONUS_EXPIRY,
    async (_job: Job<BonusExpiryJobData>) => {
        console.log('[BonusExpiryWorker] Sweeping expired bonus lots...')
        const result = await sweepExpiredBonuses()
        console.log(`[BonusExpiryWorker] Done — ${result.usersProcessed} players affected, ${result.totalExpired} ETB expired`)
        return result
    },
    {
        connection: {
            url: REDIS_URL,
            maxRetriesPerRequest: null as any,
            enableReadyCheck: false,
        } as any,
        concurrency: 1,
    },
)

async function setupRepeatingJob() {
    const repeatableJobs = await bonusExpiryQueue.getRepeatableJobs()
    for (const rj of repeatableJobs) {
        await bonusExpiryQueue.removeRepeatableByKey(rj.key)
    }

    await bonusExpiryQueue.add(
        'sweep-expired-bonuses',
        { action: 'sweep' },
        {
            repeat: { every: SWEEP_INTERVAL_MS },
            removeOnComplete: { count: 24 },
            removeOnFail: { count: 24 },
        },
    )

    await bonusExpiryQueue.add(
        'sweep-expired-bonuses-now',
        { action: 'sweep' },
        {
            removeOnComplete: { count: 5 },
            removeOnFail: { count: 5 },
        },
    )

    console.log('[BonusExpiryWorker] Repeating job set up (every 15 minutes)')
}

setupRepeatingJob().catch((err) => {
    console.error('[BonusExpiryWorker] Failed to set up repeating job:', err)
})

worker.on('completed', (job) => {
    console.log(`[BonusExpiryWorker] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
    console.error(`[BonusExpiryWorker] Job ${job?.id} failed:`, err.message)
    reportError(err, { worker: 'bonus-expiry' })
})
