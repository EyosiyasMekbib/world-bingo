/**
 * Runtime metric collectors — attach async `collect()` callbacks to gauges that
 * need to be sampled on each scrape rather than incremented inline.
 *
 * All collectors are defensive: every callback is wrapped in try/catch and never
 * throws, so a transient DB/Redis hiccup leaves the previous gauge value in place
 * instead of breaking the /metrics endpoint.
 */
import prisma from './prisma.js'
import { getQueue, QUEUE_NAMES } from './queue.js'
import { gamesActive, wbBullmqJobs } from './metrics.js'

const BULLMQ_STATES = ['waiting', 'active', 'delayed', 'completed', 'failed', 'paused'] as const

/**
 * prom-client invokes each metric's `collect()` on every scrape, but the
 * published types don't expose it as an assignable property. This is the
 * documented runtime hook for per-scrape sampling.
 */
type Collectable = { collect: () => void | Promise<void> }

/**
 * Register all runtime collectors. Call once during boot.
 */
export function registerRuntimeCollectors(): void {
    // games_active — single cheap count of in-flight games on each scrape.
    // Corrects the old WAITING+IN_PROGRESS-only definition to include all
    // pre-completion states.
    ;(gamesActive as unknown as Collectable).collect = async () => {
        try {
            const count = await prisma.game.count({
                where: { status: { in: ['WAITING', 'STARTING', 'LOCKING', 'IN_PROGRESS'] as any } },
            })
            gamesActive.set(count)
        } catch {
            // Leave the prior value on error.
        }
    }

    // wb_bullmq_jobs — queue depth by queue + state, sampled per scrape.
    ;(wbBullmqJobs as unknown as Collectable).collect = async () => {
        await Promise.all(
            Object.values(QUEUE_NAMES).map(async (queueName) => {
                try {
                    const queue = getQueue(queueName)
                    const counts = await queue.getJobCounts(...BULLMQ_STATES)
                    for (const state of BULLMQ_STATES) {
                        wbBullmqJobs.labels(queueName, state).set(counts[state] ?? 0)
                    }
                } catch {
                    // Skip this queue on error; never throw.
                }
            }),
        )
    }
}
