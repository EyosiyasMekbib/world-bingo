import prisma from '../../lib/prisma'
import { Prisma } from '@prisma/client'

/**
 * Rebuilds the PlayerMetrics rollup that every segment query reads.
 *
 * The invariant that makes this safe to re-run, retry, or run twice concurrently:
 * **every value is an absolute recompute, never an increment.** A row is derived
 * from source rows each time, so overlapping runs converge on the same answer
 * instead of drifting. There is no compensating logic anywhere in this file.
 *
 * The rollup is a single INSERT ... SELECT ... ON CONFLICT DO UPDATE rather than
 * six groupBy queries merged in Node. At 100k players the merge approach ships
 * every aggregate row over the wire to be joined in JS; Postgres does the same
 * work without the transfer, and does it atomically.
 */

const WATERMARK_KEY = 'crm.metrics.lastRefreshAt'

export interface RefreshResult {
    rows: number
    ms: number
}

/**
 * The rollup body. `userFilter` is spliced in as a *literal SQL fragment we own*
 * — never user input — so the same statement serves both the full rebuild and the
 * incremental pass.
 */
function rollupSql(userFilter: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`
        INSERT INTO player_metrics (
            "userId",
            "lifetimeDeposits", "depositCount", "firstDepositAt", "lastDepositAt",
            "lifetimeWithdrawals", "withdrawalCount", "lastWithdrawalAt",
            "gamesPlayed", "cartelasBought", "firstPlayedAt", "lastPlayedAt",
            "totalStaked", "totalWon", "netLoss",
            "tpStaked", "tpWon", "lastTpPlayedAt",
            "bonusReceived", "referralCount", "avgDailyDeposit",
            "daysSinceLastDeposit", "daysSinceLastPlay", "tenureDays",
            "realBalance", "bonusBalance", "isActive", "registeredAt",
            "serial", "username", "phone", "telegramId",
            "refreshedAt"
        )
        SELECT
            u.id,

            COALESCE(dep.total, 0),
            COALESCE(dep.cnt, 0),
            dep.first_at,
            dep.last_at,

            COALESCE(wd.total, 0),
            COALESCE(wd.cnt, 0),
            wd.last_at,

            COALESCE(ge.games, 0),
            COALESCE(ge.cartelas, 0),
            ge.first_at,
            ge.last_at,

            COALESCE(stake.total, 0),
            COALESCE(win.total, 0),
            -- True net loss across BOTH products: what they staked minus what they
            -- won, bingo and casino together. A player who loses at bingo and wins
            -- it back on Palace is not a "big loser" and must not land in a
            -- loss-based segment.
            (COALESCE(stake.total, 0) + COALESCE(tp.staked, 0))
                - (COALESCE(win.total, 0) + COALESCE(tp.won, 0)),

            COALESCE(tp.staked, 0),
            COALESCE(tp.won, 0),
            tp.last_at,

            COALESCE(bonus.total, 0),
            COALESCE(ref.cnt, 0),

            CASE WHEN dep.first_at IS NULL THEN NULL
                 ELSE COALESCE(dep.total, 0)
                      / GREATEST(1, FLOOR(EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - dep.first_at)) / 86400))
            END,

            CASE WHEN dep.last_at IS NULL THEN NULL
                 ELSE GREATEST(0, ((NOW() AT TIME ZONE 'UTC')::date - dep.last_at::date)) END,
            CASE WHEN ge.last_at IS NULL THEN NULL
                 ELSE GREATEST(0, ((NOW() AT TIME ZONE 'UTC')::date - ge.last_at::date)) END,
            GREATEST(0, ((NOW() AT TIME ZONE 'UTC')::date - u."createdAt"::date)),

            COALESCE(w."realBalance", 0),
            COALESCE(w."bonusBalance", 0),
            u."isActive",
            u."createdAt",
            u.serial,
            u.username,
            u.phone,
            u."telegramId",

            NOW()
        FROM users u
        LEFT JOIN wallets w ON w."userId" = u.id

        -- Deposits and withdrawals count ONLY at APPROVED. Receipts sitting in
        -- PENDING_REVIEW must never inflate a VIP segment.
        LEFT JOIN (
            SELECT "userId",
                   SUM(amount) AS total,
                   COUNT(*)    AS cnt,
                   MIN("createdAt") AS first_at,
                   MAX("createdAt") AS last_at
            FROM transactions
            WHERE type = 'DEPOSIT' AND status = 'APPROVED'
            GROUP BY "userId"
        ) dep ON dep."userId" = u.id

        LEFT JOIN (
            SELECT "userId", SUM(amount) AS total, COUNT(*) AS cnt, MAX("createdAt") AS last_at
            FROM transactions
            WHERE type = 'WITHDRAWAL' AND status = 'APPROVED'
            GROUP BY "userId"
        ) wd ON wd."userId" = u.id

        LEFT JOIN (
            SELECT "userId", SUM(amount) AS total
            FROM transactions
            WHERE type = 'GAME_ENTRY' AND status = 'APPROVED'
            GROUP BY "userId"
        ) stake ON stake."userId" = u.id

        LEFT JOIN (
            SELECT "userId", SUM(amount) AS total
            FROM transactions
            WHERE type = 'PRIZE_WIN' AND status = 'APPROVED'
            GROUP BY "userId"
        ) win ON win."userId" = u.id

        LEFT JOIN (
            SELECT "userId", SUM(amount) AS total
            FROM transactions
            WHERE type IN ('FIRST_DEPOSIT_BONUS', 'CASHBACK_BONUS', 'ADMIN_BONUS_ADJUSTMENT', 'DAILY_DEPOSIT_BONUS', 'WEEKLY_DEPOSIT_BONUS')
              AND status = 'APPROVED'
            GROUP BY "userId"
        ) bonus ON bonus."userId" = u.id

        -- One GameEntry row per cartela, so games played is the DISTINCT game count.
        LEFT JOIN (
            SELECT "userId",
                   COUNT(DISTINCT "gameId") AS games,
                   COUNT(*)                 AS cartelas,
                   MIN("joinedAt")          AS first_at,
                   MAX("joinedAt")          AS last_at
            FROM game_entries
            GROUP BY "userId"
        ) ge ON ge."userId" = u.id

        -- Third-party ledger: negative amounts are bets, positive are wins.
        LEFT JOIN (
            SELECT "userId",
                   COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS staked,
                   COALESCE(SUM(CASE WHEN amount > 0 THEN  amount ELSE 0 END), 0) AS won,
                   MAX("createdAt") AS last_at
            FROM third_party_transactions
            GROUP BY "userId"
        ) tp ON tp."userId" = u.id

        LEFT JOIN (
            SELECT "referredById" AS "userId", COUNT(*) AS cnt
            FROM users
            WHERE "referredById" IS NOT NULL
            GROUP BY "referredById"
        ) ref ON ref."userId" = u.id

        WHERE u.role = 'PLAYER'
          -- Bot accounts are house-funded; their play would pollute every
          -- aggregate and they must never be reachable by a campaign. Excluded at
          -- the source rather than filtered per-query, so a future query cannot
          -- forget to. BOTH markers are checked because the codebase itself uses
          -- them interchangeably — bot.service.ts sets passwordHash='BOT_ACCOUNT'
          -- (:104) but matches on the username prefix elsewhere (:184, :289), so
          -- either alone would miss a bot created by the other path.
          AND u."passwordHash" IS DISTINCT FROM 'BOT_ACCOUNT'
          AND (u.username IS NULL OR u.username NOT LIKE 'bot\\_t%')
          ${userFilter}

        ON CONFLICT ("userId") DO UPDATE SET
            "lifetimeDeposits"     = EXCLUDED."lifetimeDeposits",
            "depositCount"         = EXCLUDED."depositCount",
            "firstDepositAt"       = EXCLUDED."firstDepositAt",
            "lastDepositAt"        = EXCLUDED."lastDepositAt",
            "lifetimeWithdrawals"  = EXCLUDED."lifetimeWithdrawals",
            "withdrawalCount"      = EXCLUDED."withdrawalCount",
            "lastWithdrawalAt"     = EXCLUDED."lastWithdrawalAt",
            "gamesPlayed"          = EXCLUDED."gamesPlayed",
            "cartelasBought"       = EXCLUDED."cartelasBought",
            "firstPlayedAt"        = EXCLUDED."firstPlayedAt",
            "lastPlayedAt"         = EXCLUDED."lastPlayedAt",
            "totalStaked"          = EXCLUDED."totalStaked",
            "totalWon"             = EXCLUDED."totalWon",
            "netLoss"              = EXCLUDED."netLoss",
            "tpStaked"             = EXCLUDED."tpStaked",
            "tpWon"                = EXCLUDED."tpWon",
            "lastTpPlayedAt"       = EXCLUDED."lastTpPlayedAt",
            "bonusReceived"        = EXCLUDED."bonusReceived",
            "referralCount"        = EXCLUDED."referralCount",
            "avgDailyDeposit"      = EXCLUDED."avgDailyDeposit",
            "daysSinceLastDeposit" = EXCLUDED."daysSinceLastDeposit",
            "daysSinceLastPlay"    = EXCLUDED."daysSinceLastPlay",
            "tenureDays"           = EXCLUDED."tenureDays",
            "realBalance"          = EXCLUDED."realBalance",
            "bonusBalance"         = EXCLUDED."bonusBalance",
            "isActive"             = EXCLUDED."isActive",
            "registeredAt"         = EXCLUDED."registeredAt",
            "phone"                = EXCLUDED."phone",
            "telegramId"           = EXCLUDED."telegramId",
            "refreshedAt"          = EXCLUDED."refreshedAt"
    `
}

export class PlayerMetricsService {
    /** Full rebuild across every player. Self-heals any drift. */
    static async refreshAll(): Promise<RefreshResult> {
        const startedAt = Date.now()
        const rows = await prisma.$executeRaw(rollupSql(Prisma.empty))
        return { rows, ms: Date.now() - startedAt }
    }

    /** Rebuild only the named players. Same statement, same guarantees. */
    static async refreshUsers(userIds: string[]): Promise<RefreshResult> {
        if (!userIds.length) return { rows: 0, ms: 0 }
        const startedAt = Date.now()
        const rows = await prisma.$executeRaw(
            rollupSql(Prisma.sql`AND u.id IN (${Prisma.join(userIds)})`),
        )
        return { rows, ms: Date.now() - startedAt }
    }

    /**
     * Players touched since the watermark. Deliberately a union of the tables that
     * feed the rollup — anything that can change a metric must appear here, or
     * that player silently goes stale until the nightly rebuild.
     */
    static async findStaleUserIds(since: Date, limit = 50_000): Promise<string[]> {
        // The timestamp columns are `timestamp` WITHOUT time zone holding UTC, but
        // Prisma binds a JS Date as timestamptz. Postgres then reconciles the two
        // using the SESSION timezone, which silently shifts the stored value by the
        // server's UTC offset — on a +03 host every comparison returns false and
        // this query finds nothing, forever. Passing the instant as an ISO string
        // cast to `timestamp` compares naive-UTC to naive-UTC, with no session
        // timezone involved.
        const sinceUtc = since.toISOString()

        const rows = await prisma.$queryRaw<Array<{ userId: string }>>`
            SELECT DISTINCT "userId" FROM (
                SELECT "userId" FROM transactions             WHERE "createdAt" > ${sinceUtc}::timestamp
                UNION ALL
                SELECT "userId" FROM game_entries             WHERE "joinedAt"  > ${sinceUtc}::timestamp
                UNION ALL
                SELECT "userId" FROM third_party_transactions WHERE "createdAt" > ${sinceUtc}::timestamp
                UNION ALL
                SELECT id       FROM users                    WHERE "updatedAt" > ${sinceUtc}::timestamp
            ) touched
            LIMIT ${limit}
        `
        return rows.map((r) => r.userId)
    }

    static async getWatermark(): Promise<Date | null> {
        const row = await prisma.siteSetting.findUnique({ where: { key: WATERMARK_KEY } })
        if (!row?.value) return null
        const parsed = new Date(row.value)
        return Number.isNaN(parsed.getTime()) ? null : parsed
    }

    /** Only ever called after a successful pass — a failed run must re-do its window. */
    static async setWatermark(at: Date): Promise<void> {
        await prisma.siteSetting.upsert({
            where: { key: WATERMARK_KEY },
            update: { value: at.toISOString() },
            create: { key: WATERMARK_KEY, value: at.toISOString() },
        })
    }

    /**
     * Incremental pass. Captures the clock BEFORE reading, so anything written
     * during the run is picked up next time rather than skipped — at worst a
     * player is recomputed twice, which is free because recomputes are absolute.
     */
    /**
     * Re-syncs liveness (isActive) for EVERY row, not just watermark-touched ones.
     *
     * `apps/api/scripts/freeze_flagged.sql` freezes accounts with a raw
     * `UPDATE users SET "isActive" = false`. Prisma's `@updatedAt` does not fire on
     * raw SQL, so a freeze bumps no timestamp and findStaleUserIds never sees it —
     * a frozen fraud account would keep `isActive: true` in the rollup, and stay
     * targetable by campaigns, until the nightly rebuild. That is the one staleness
     * window that must not exist, so it gets its own cheap full-table sync.
     */
    static async syncLiveness(): Promise<number> {
        return prisma.$executeRaw`
            UPDATE player_metrics pm
            SET "isActive" = u."isActive"
            FROM users u
            WHERE u.id = pm."userId"
              AND pm."isActive" IS DISTINCT FROM u."isActive"
        `
    }

    /**
     * Full-table refresh of avgDailyDeposit alone. Its denominator (days since
     * firstDepositAt) grows every day whether or not the player does anything,
     * so — unlike every other rollup column — it cannot wait for the
     * watermark-driven incremental pass to notice the player was "touched".
     * Pure arithmetic over two already-stored columns: no join, cheap enough to
     * run on every incremental tick.
     */
    static async syncAvgDailyDeposit(): Promise<number> {
        return prisma.$executeRaw`
            UPDATE player_metrics
            SET "avgDailyDeposit" = CASE WHEN "firstDepositAt" IS NULL THEN NULL
                ELSE "lifetimeDeposits" / GREATEST(1, FLOOR(EXTRACT(EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - "firstDepositAt")) / 86400))
            END
        `
    }

    static async refreshIncremental(): Promise<
        RefreshResult & { candidates: number; livenessChanged: number }
    > {
        const runAt = new Date()
        const since = (await PlayerMetricsService.getWatermark()) ?? new Date(0)

        const userIds = await PlayerMetricsService.findStaleUserIds(since)

        // Always runs, even when nothing else is stale — a freeze is invisible to
        // the watermark, so it cannot be gated behind having found candidates.
        // avgDailyDeposit's denominator grows daily on its own for the same reason.
        const [livenessChanged] = await Promise.all([
            PlayerMetricsService.syncLiveness(),
            PlayerMetricsService.syncAvgDailyDeposit(),
        ])

        if (!userIds.length) {
            await PlayerMetricsService.setWatermark(runAt)
            return { rows: 0, ms: 0, candidates: 0, livenessChanged }
        }

        const result = await PlayerMetricsService.refreshUsers(userIds)
        await PlayerMetricsService.setWatermark(runAt)

        return { ...result, candidates: userIds.length, livenessChanged }
    }

    /** Staleness for the admin UI — "metrics as of 4 minutes ago". */
    static async getFreshness(): Promise<{ refreshedAt: Date | null; rowCount: number }> {
        const [agg, rowCount] = await Promise.all([
            prisma.playerMetrics.aggregate({ _max: { refreshedAt: true } }),
            prisma.playerMetrics.count(),
        ])
        return { refreshedAt: agg._max.refreshedAt ?? null, rowCount }
    }
}
