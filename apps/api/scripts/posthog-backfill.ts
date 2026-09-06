/**
 * Backfill PostHog with the history already in Postgres.
 *
 * USAGE (run from apps/api/)
 *   pnpm posthog:backfill -- --since 2026-02-20 [--until 2026-09-06] [--dry-run]
 *
 * Reads POSTHOG_KEY / POSTHOG_HOST / POSTHOG_BRAND (falls back to
 * DEPLOYMENT_CODE) from the root .env. Refuses to run without a key unless
 * --dry-run is given. With --dry-run, no PostHog client is constructed and
 * no events are sent, even if POSTHOG_KEY is configured.
 *
 * Safe to re-run: every event has a deterministic uuid and PostHog
 * de-duplicates on it. The client is created with historicalMigration so the
 * import does not count against real-time ingestion limits.
 *
 * Every page loop awaits a flush before reading the next page: the client
 * queue drops the OLDEST event when it fills, silently, so a paging loop that
 * outruns the network loses the beginning of history rather than the end. The
 * run finishes by reconciling events queued against events PostHog
 * acknowledged, and exits 1 on any shortfall.
 *
 * Bots and staff are excluded at the source with the same predicate
 * AnalyticsService uses. Phone numbers, names and account numbers never leave
 * the database — see lib/posthog-backfill.ts for exactly what is sent.
 */
import { PostHog } from 'posthog-node'
import prisma from '../src/lib/prisma'
import {
    analyticsEventRow,
    bonusEvent,
    depositEvents,
    gameFinishedEvents,
    gameJoinedEvents,
    gameRefundedEvents,
    userEvents,
    withdrawalEvents,
    type BackfillEvent,
    type BackfillAlias,
    type Entrant,
} from '../src/lib/posthog-backfill'

const PAGE = 1000

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 ? process.argv[i + 1] : undefined
}
const dryRun = process.argv.includes('--dry-run')
const since = new Date(arg('since') ?? '2026-02-20')
const until = arg('until') ? new Date(arg('until') as string) : new Date()
if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
    console.error('Invalid --since / --until date')
    process.exit(2)
}

const key = process.env.POSTHOG_KEY
if (!key && !dryRun) {
    console.error('POSTHOG_KEY is not set. Pass --dry-run to count without sending.')
    process.exit(2)
}
const brand = process.env.POSTHOG_BRAND || process.env.DEPLOYMENT_CODE || ''

const client = key && !dryRun
    ? new PostHog(key, {
          host: process.env.POSTHOG_HOST || 'https://eu.i.posthog.com',
          historicalMigration: true,
          flushAt: 100,
          flushInterval: 1000,
          // posthog-node defaults this to 10_000, and @posthog/core drops the
          // OLDEST queued event once the queue is full — a `logger.warn` that
          // only prints in debug mode, never an 'error' event. Postgres returns
          // a 1000-row page in milliseconds while a flush is 100 events per
          // HTTP round trip, so the queue used to saturate within a handful of
          // pages and silently discard everything but the last ~10k events.
          // The real fix is the per-page `await drain()` below; this is the
          // belt to its braces.
          maxQueueSize: Number.MAX_SAFE_INTEGER,
      })
    : null

const counts: Record<string, number> = {}
let failed = false
/** Events PostHog actually accepted, from the core client's own 'flush' event. */
let sent = 0
if (client) {
    client.on('error', (err: unknown) => {
        failed = true
        console.error('[posthog] batch error:', err)
    })
    // @posthog/core emits 'flush' with the array of messages it just shipped
    // (`this._events.emit('flush', sentMessages)`), so this counts sends, not
    // enqueues — which is exactly the number that used to go missing.
    client.on('flush', (messages: unknown) => {
        sent += Array.isArray(messages) ? messages.length : 0
    })
}

/**
 * Empty the queue before reading the next page. Without this the paging loop
 * outruns the network by orders of magnitude and the queue eats itself.
 */
async function drain(): Promise<void> {
    if (!client) return
    try {
        await client.flush()
    } catch (err) {
        failed = true
        console.error('[posthog] flush failed:', err)
    }
}

function send(ev: BackfillEvent | BackfillAlias): void {
    if ('alias' in ev) {
        counts.$create_alias = (counts.$create_alias ?? 0) + 1
        if (client) client.alias({ distinctId: ev.distinctId, alias: ev.alias })
        return
    }
    counts[ev.event] = (counts[ev.event] ?? 0) + 1
    if (client) {
        client.capture({
            distinctId: ev.distinctId,
            event: ev.event,
            properties: { ...ev.properties, brand },
            timestamp: ev.timestamp,
            uuid: ev.uuid,
        })
    }
}

async function excludedUserIds(): Promise<Set<string>> {
    const rows = await prisma.user.findMany({
        where: {
            OR: [
                { role: { not: 'PLAYER' } },
                { username: { startsWith: 'bot_t' } },
                { passwordHash: 'BOT_ACCOUNT' },
            ],
        },
        select: { id: true },
    })
    return new Set(rows.map((r) => r.id))
}

async function backfillUsers(excluded: Set<string>): Promise<void> {
    let cursor: string | undefined
    for (;;) {
        const rows = await prisma.user.findMany({
            where: { createdAt: { gte: since, lt: until } },
            select: { id: true, serial: true, telegramId: true, referredById: true, createdAt: true },
            orderBy: { id: 'asc' },
            take: PAGE,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        })
        if (!rows.length) break
        for (const u of rows) {
            if (excluded.has(u.id)) continue
            userEvents(u).forEach(send)
        }
        await drain()
        cursor = rows[rows.length - 1].id
    }
}

async function backfillTransactions(excluded: Set<string>): Promise<void> {
    const methods = new Set((await prisma.paymentMethod.findMany({ select: { code: true } })).map((m) => m.code))
    let cursor: string | undefined
    for (;;) {
        const rows = await prisma.transaction.findMany({
            where: { createdAt: { gte: since, lt: until } },
            select: {
                id: true, userId: true, type: true, amount: true, status: true,
                note: true, gateway: true, referenceId: true, createdAt: true,
            },
            orderBy: { id: 'asc' },
            take: PAGE,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        })
        if (!rows.length) break
        for (const t of rows) {
            if (excluded.has(t.userId)) continue
            if (t.type === 'DEPOSIT') depositEvents(t, methods).forEach(send)
            else if (t.type === 'WITHDRAWAL') withdrawalEvents(t).forEach(send)
            else {
                const b = bonusEvent(t)
                if (b) send(b)
            }
        }
        await drain()
        cursor = rows[rows.length - 1].id
    }
}

async function backfillGames(excluded: Set<string>): Promise<void> {
    let cursor: string | undefined
    for (;;) {
        const games = await prisma.game.findMany({
            where: { createdAt: { gte: since, lt: until }, status: { in: ['COMPLETED', 'CANCELLED'] } },
            select: {
                id: true, templateId: true, ticketPrice: true, houseEdgePct: true, status: true,
                winnerId: true, createdAt: true, startedAt: true, endedAt: true,
            },
            orderBy: { id: 'asc' },
            take: 200,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        })
        if (!games.length) break
        const ids = games.map((g) => g.id)
        const grouped = await prisma.gameEntry.groupBy({
            by: ['gameId', 'userId'],
            where: { gameId: { in: ids } },
            _count: { _all: true },
            _min: { joinedAt: true },
        })
        const entrantsByGame = new Map<string, Entrant[]>()
        for (const g of grouped) {
            if (excluded.has(g.userId) || !g._min.joinedAt) continue
            const list = entrantsByGame.get(g.gameId) ?? []
            list.push({ userId: g.userId, cartelas: g._count._all, firstJoinedAt: g._min.joinedAt })
            entrantsByGame.set(g.gameId, list)
        }
        const refunds = await prisma.transaction.findMany({
            where: { type: 'REFUND', referenceId: { in: ids } },
            select: { userId: true, amount: true, referenceId: true },
        })
        const refundsByGame = new Map<string, Array<{ userId: string; amount: number }>>()
        for (const r of refunds) {
            if (!r.referenceId || excluded.has(r.userId)) continue
            const list = refundsByGame.get(r.referenceId) ?? []
            list.push({ userId: r.userId, amount: Number(r.amount) })
            refundsByGame.set(r.referenceId, list)
        }
        for (const game of games) {
            const entrants = entrantsByGame.get(game.id) ?? []
            gameJoinedEvents(game, entrants).forEach(send)
            if (game.status === 'COMPLETED') gameFinishedEvents(game, entrants).forEach(send)
            else gameRefundedEvents(game, refundsByGame.get(game.id) ?? []).forEach(send)
        }
        await drain()
        cursor = games[games.length - 1].id
    }
}

async function backfillAnalyticsEvents(excluded: Set<string>): Promise<void> {
    let cursor: string | undefined
    for (;;) {
        const rows = await prisma.analyticsEvent.findMany({
            where: { createdAt: { gte: since, lt: until } },
            select: { id: true, name: true, userId: true, anonId: true, createdAt: true, props: true },
            orderBy: { id: 'asc' },
            take: PAGE,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        })
        if (!rows.length) break
        for (const e of rows) {
            if (e.userId && excluded.has(e.userId)) continue
            const mapped = analyticsEventRow(e)
            if (mapped) send(mapped)
        }
        await drain()
        cursor = rows[rows.length - 1].id
    }
}

async function main(): Promise<void> {
    console.log(`PostHog backfill ${dryRun ? '(DRY RUN) ' : ''}${since.toISOString()} → ${until.toISOString()} brand=${brand || '(none)'}`)
    const excluded = await excludedUserIds()
    console.log(`excluding ${excluded.size} bot/staff accounts`)
    await backfillUsers(excluded)
    await backfillTransactions(excluded)
    await backfillGames(excluded)
    await backfillAnalyticsEvents(excluded)
    // Default is 30 s, which is not enough to drain a large tail. Every page
    // already flushed, so this normally has little left to do.
    if (client) await client.shutdown(600_000)
    await prisma.$disconnect()
    console.table(counts)

    const queued = Object.values(counts).reduce((a, b) => a + b, 0)
    if (client) {
        console.log(`queued ${queued} events, PostHog acknowledged ${sent}`)
        if (sent < queued) {
            console.error(`SHORTFALL: ${queued - sent} events were never sent. Re-run: deterministic uuids make that safe.`)
            failed = true
        }
    } else {
        console.log(`counted ${queued} events (dry run — nothing sent)`)
    }
    if (failed) {
        console.error('Some batches failed. Re-run: deterministic uuids make that safe.')
        process.exit(1)
    }
}

main().catch(async (err) => {
    console.error(err)
    await prisma.$disconnect().catch(() => {})
    process.exit(1)
})
