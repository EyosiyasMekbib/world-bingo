/**
 * PostHog product analytics — server-side events.
 *
 * Fully env-gated: when POSTHOG_KEY is unset, initPostHog() never constructs a
 * client and every helper here is an inert no-op. Mirrors lib/sentry.ts.
 *
 * Rules every caller follows:
 *  - captureEvent() is fire-and-forget: `void captureEvent(...)`. Never await it
 *    on a request path.
 *  - It never throws and its promise never rejects. A PostHog outage costs
 *    events, never a request.
 *  - Emit AFTER the Prisma transaction resolves, never inside a $transaction
 *    callback — a rolled-back write must not leave a phantom event.
 *  - distinct_id is the user UUID. Phone, names, account numbers and receipt
 *    URLs are never properties.
 *  - Bots and staff are dropped here, once, so no caller has to remember.
 */
import { PostHog } from 'posthog-node'
import prisma from './prisma'
import { rootLogger } from './logger'

export interface PostHogClientLike {
    capture(msg: {
        distinctId: string
        event: string
        properties?: Record<string, unknown>
        timestamp?: Date
    }): void
    shutdown(): Promise<void>
}

let client: PostHogClientLike | null = null
let brand = ''

/**
 * userId → excluded. Bounded: cleared wholesale when full. Bot ids are a small
 * fixed set and players are looked up once per process lifetime.
 */
const EXCLUSION_CACHE_MAX = 10_000
const exclusionCache = new Map<string, boolean>()

/**
 * Same predicate as AnalyticsService.NON_BOT_PLAYER plus the second bot marker
 * bot.service.ts writes (passwordHash = 'BOT_ACCOUNT'). A missing row is
 * excluded: there is no player to attribute the event to.
 */
export function isExcludedUser(
    row: { username: string | null; passwordHash: string | null; role: string } | null,
): boolean {
    if (!row) return true
    if (row.role !== 'PLAYER') return true
    if (row.username?.startsWith('bot_t')) return true
    return row.passwordHash === 'BOT_ACCOUNT'
}

async function isExcluded(userId: string): Promise<boolean> {
    const cached = exclusionCache.get(userId)
    if (cached !== undefined) return cached
    const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { username: true, passwordHash: true, role: true },
    })
    const excluded = isExcludedUser(row)
    if (exclusionCache.size >= EXCLUSION_CACHE_MAX) exclusionCache.clear()
    exclusionCache.set(userId, excluded)
    return excluded
}

/**
 * Initialise ONLY when POSTHOG_KEY is set. Call once at process bootstrap,
 * right after initSentry(). Logs one line either way.
 */
export function initPostHog(): void {
    const key = process.env.POSTHOG_KEY
    if (!key) {
        rootLogger.info('[posthog] POSTHOG_KEY not set — product analytics disabled')
        return
    }
    brand = process.env.POSTHOG_BRAND || process.env.DEPLOYMENT_CODE || ''
    const instance = new PostHog(key, {
        host: process.env.POSTHOG_HOST || 'https://eu.i.posthog.com',
        flushAt: 20,
        flushInterval: 5_000,
    })
    ;(instance as unknown as { on?: (e: string, cb: (err: unknown) => void) => void }).on?.(
        'error',
        (err: unknown) => {
            rootLogger.warn({ err }, '[posthog] client error')
        },
    )
    client = instance
    rootLogger.info({ brand }, '[posthog] product analytics enabled')
}

/** Test seam: install a fake client without touching env. Clears the cache. */
export function _setClientForTests(fake: PostHogClientLike | null, fakeBrand = ''): void {
    client = fake
    brand = fakeBrand
    exclusionCache.clear()
}

export function isPostHogEnabled(): boolean {
    return client !== null
}

export interface CaptureOptions {
    /** Person properties to `$set` alongside this event. */
    set?: Record<string, unknown>
    /** Historical timestamp — backfill only. */
    timestamp?: Date
}

/**
 * Record one event for one player. No-op when disabled or when the user is a
 * bot / staff / unknown. Never throws; the returned promise never rejects.
 */
export async function captureEvent(
    userId: string,
    event: string,
    properties: Record<string, unknown> = {},
    opts: CaptureOptions = {},
): Promise<void> {
    if (!client) return
    try {
        if (await isExcluded(userId)) return
        client.capture({
            distinctId: userId,
            event,
            properties: {
                ...properties,
                brand,
                ...(opts.set ? { $set: { ...opts.set, brand } } : {}),
            },
            ...(opts.timestamp ? { timestamp: opts.timestamp } : {}),
        })
    } catch (err) {
        rootLogger.warn({ err, event }, '[posthog] capture failed')
    }
}

/** Flush the queue and release the client. Call after queues close on shutdown. */
export async function shutdownPostHog(): Promise<void> {
    if (!client) return
    try {
        await client.shutdown()
    } catch {
        // Swallow — shutdown must not fail because analytics did.
    }
    client = null
}
