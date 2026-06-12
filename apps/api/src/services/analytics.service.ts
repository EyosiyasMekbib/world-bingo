import { Prisma } from '@prisma/client'
import prisma from '../lib/prisma'

// Excludes bot accounts (username bot_t<templateId>_<slot>) and staff roles.
// username is nullable (Telegram-only users), hence the IS NULL branch.
const NON_BOT_PLAYER = Prisma.sql`u."role" = 'PLAYER' AND (u."username" IS NULL OR u."username" NOT LIKE 'bot_t%')`

export class AnalyticsService {
    static parseRange(fromStr?: string, toStr?: string, now: Date = new Date()) {
        const to = toStr ? new Date(toStr) : now
        const from = fromStr ? new Date(fromStr) : new Date(to.getTime() - 30 * 24 * 3600 * 1000)
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('Invalid date')
        if (from.getTime() >= to.getTime()) throw new Error('from must be before to')
        return { from, to }
    }

    static pct(num: number, den: number): number {
        if (!den) return 0
        return Math.round((num / den) * 1000) / 10
    }

    static buildRetentionMatrix(
        sizes: Array<{ cohort_week: Date; size: number }>,
        activity: Array<{ cohort_week: Date; week_offset: number; active_users: number }>,
        maxOffsets: number,
    ) {
        return sizes.map(({ cohort_week, size }) => {
            const key = cohort_week.getTime()
            const offsets = Array.from({ length: maxOffsets }, (_, i) => {
                const hit = activity.find(a => a.cohort_week.getTime() === key && a.week_offset === i)
                return this.pct(hit?.active_users ?? 0, size)
            })
            return { week: cohort_week.toISOString().slice(0, 10), size, offsets }
        })
    }

    /** Signup cohort funnel: signed up → deposited → played → played 2+ games. */
    static async getFunnel(from: Date, to: Date) {
        const rows = await prisma.$queryRaw<Array<{
            signups: number; depositors: number; players: number; repeat_players: number
        }>>(Prisma.sql`
            WITH cohort AS (
                SELECT u.id FROM users u
                WHERE ${NON_BOT_PLAYER}
                  AND u."createdAt" >= ${from} AND u."createdAt" < ${to}
            ),
            deps AS (
                SELECT DISTINCT t."userId" AS id FROM transactions t
                JOIN cohort c ON c.id = t."userId"
                WHERE t.type = 'DEPOSIT' AND t.status = 'APPROVED'
            ),
            plays AS (
                SELECT ge."userId" AS id, count(DISTINCT ge."gameId") AS games
                FROM game_entries ge JOIN cohort c ON c.id = ge."userId"
                GROUP BY 1
            )
            SELECT
                (SELECT count(*) FROM cohort)::int AS signups,
                (SELECT count(*) FROM deps)::int AS depositors,
                (SELECT count(*) FROM plays)::int AS players,
                (SELECT count(*) FROM plays WHERE games >= 2)::int AS repeat_players
        `)
        const r = rows[0]
        return {
            signups: r.signups,
            depositors: r.depositors,
            players: r.players,
            repeatPlayers: r.repeat_players,
            rates: {
                signupToDeposit: this.pct(r.depositors, r.signups),
                depositToPlay: this.pct(r.players, r.depositors),
                playToRepeat: this.pct(r.repeat_players, r.players),
            },
        }
    }

    /** Weekly retention cohorts over the trailing `weeks` weeks. */
    static async getRetention(weeks = 8) {
        const sizes = await prisma.$queryRaw<Array<{ cohort_week: Date; size: number }>>(Prisma.sql`
            SELECT date_trunc('week', u."createdAt") AS cohort_week, count(*)::int AS size
            FROM users u
            WHERE ${NON_BOT_PLAYER}
              AND u."createdAt" >= date_trunc('week', now()) - make_interval(weeks => ${weeks})
            GROUP BY 1 ORDER BY 1
        `)
        const activity = await prisma.$queryRaw<Array<{ cohort_week: Date; week_offset: number; active_users: number }>>(Prisma.sql`
            WITH cohorts AS (
                SELECT u.id, date_trunc('week', u."createdAt") AS cohort_week
                FROM users u
                WHERE ${NON_BOT_PLAYER}
                  AND u."createdAt" >= date_trunc('week', now()) - make_interval(weeks => ${weeks})
            ),
            weekly_activity AS (
                SELECT ge."userId", date_trunc('week', ge."joinedAt") AS active_week
                FROM game_entries ge
                GROUP BY 1, 2
            )
            SELECT c.cohort_week,
                   (extract(epoch FROM (a.active_week - c.cohort_week)) / 604800)::int AS week_offset,
                   count(DISTINCT c.id)::int AS active_users
            FROM cohorts c
            JOIN weekly_activity a ON a."userId" = c.id AND a.active_week >= c.cohort_week
            GROUP BY 1, 2 ORDER BY 1, 2
        `)
        return { cohorts: this.buildRetentionMatrix(sizes, activity, weeks) }
    }

    /** Daily game supply/cancellation series plus average human fill of completed games. */
    static async getGamesHealth(from: Date, to: Date) {
        const daily = await prisma.$queryRaw<Array<{
            day: Date; created: number; completed: number; cancelled: number; avg_secs_to_start: string | null
        }>>(Prisma.sql`
            SELECT date_trunc('day', g."createdAt")::date AS day,
                   count(*)::int AS created,
                   count(*) FILTER (WHERE g.status = 'COMPLETED')::int AS completed,
                   count(*) FILTER (WHERE g.status = 'CANCELLED')::int AS cancelled,
                   avg(extract(epoch FROM (g."startedAt" - g."createdAt")))
                       FILTER (WHERE g."startedAt" IS NOT NULL) AS avg_secs_to_start
            FROM games g
            WHERE g."createdAt" >= ${from} AND g."createdAt" < ${to}
            GROUP BY 1 ORDER BY 1
        `)
        const fill = await prisma.$queryRaw<Array<{ avg_fill: string | null; bot_share: string | null }>>(Prisma.sql`
            SELECT avg(e.human_entries::numeric / NULLIF(g."maxPlayers", 0)) AS avg_fill,
                   avg(e.bot_entries::numeric / NULLIF(e.human_entries + e.bot_entries, 0)) AS bot_share
            FROM games g
            JOIN LATERAL (
                SELECT count(*) FILTER (WHERE usr."username" IS NULL OR usr."username" NOT LIKE 'bot_t%')::int AS human_entries,
                       count(*) FILTER (WHERE usr."username" LIKE 'bot_t%')::int AS bot_entries
                FROM game_entries ge JOIN users usr ON usr.id = ge."userId"
                WHERE ge."gameId" = g.id
            ) e ON true
            WHERE g.status = 'COMPLETED' AND g."createdAt" >= ${from} AND g."createdAt" < ${to}
        `)
        return {
            daily: daily.map(d => ({
                day: d.day instanceof Date ? d.day.toISOString().slice(0, 10) : String(d.day),
                created: d.created,
                completed: d.completed,
                cancelled: d.cancelled,
                cancellationPct: this.pct(d.cancelled, d.created),
                avgSecsToStart: d.avg_secs_to_start == null ? null : Math.round(Number(d.avg_secs_to_start)),
            })),
            fill: {
                avgHumanFillPct: fill[0]?.avg_fill == null ? 0 : Math.round(Number(fill[0].avg_fill) * 1000) / 10,
                botSharePct: fill[0]?.bot_share == null ? 0 : Math.round(Number(fill[0].bot_share) * 1000) / 10,
            },
        }
    }

    /** All-time engagement: games-per-player distribution, churn signals, win experience, idle wallets. */
    static async getEngagement() {
        const dist = await prisma.$queryRaw<Array<{
            one_game: number; g2_5: number; g6_20: number; g20_plus: number; active_7d: number; total_players: number
        }>>(Prisma.sql`
            WITH per_player AS (
                SELECT ge."userId", count(DISTINCT ge."gameId")::int AS games, max(ge."joinedAt") AS last_played
                FROM game_entries ge JOIN users u ON u.id = ge."userId"
                WHERE ${NON_BOT_PLAYER}
                GROUP BY 1
            )
            SELECT count(*) FILTER (WHERE games = 1)::int AS one_game,
                   count(*) FILTER (WHERE games BETWEEN 2 AND 5)::int AS g2_5,
                   count(*) FILTER (WHERE games BETWEEN 6 AND 20)::int AS g6_20,
                   count(*) FILTER (WHERE games > 20)::int AS g20_plus,
                   count(*) FILTER (WHERE last_played >= now() - interval '7 days')::int AS active_7d,
                   count(*)::int AS total_players
            FROM per_player
        `)
        const winExp = await prisma.$queryRaw<Array<{
            winners_total: number; winners_active_7d: number; losers_total: number; losers_active_7d: number
        }>>(Prisma.sql`
            WITH per_player AS (
                SELECT ge."userId" AS id, max(ge."joinedAt") AS last_played
                FROM game_entries ge JOIN users u ON u.id = ge."userId"
                WHERE ${NON_BOT_PLAYER}
                GROUP BY 1 HAVING count(DISTINCT ge."gameId") >= 3
            ),
            winners AS (
                SELECT DISTINCT t."userId" AS id FROM transactions t WHERE t.type = 'PRIZE_WIN'
            )
            SELECT count(*) FILTER (WHERE w.id IS NOT NULL)::int AS winners_total,
                   count(*) FILTER (WHERE w.id IS NOT NULL AND p.last_played >= now() - interval '7 days')::int AS winners_active_7d,
                   count(*) FILTER (WHERE w.id IS NULL)::int AS losers_total,
                   count(*) FILTER (WHERE w.id IS NULL AND p.last_played >= now() - interval '7 days')::int AS losers_active_7d
            FROM per_player p LEFT JOIN winners w ON w.id = p.id
        `)
        const idle = await prisma.$queryRaw<Array<{ idle_wallets: number; idle_balance: string | null }>>(Prisma.sql`
            SELECT count(*)::int AS idle_wallets, coalesce(sum(w."realBalance"), 0) AS idle_balance
            FROM wallets w JOIN users u ON u.id = w."userId"
            WHERE ${NON_BOT_PLAYER}
              AND w."realBalance" >= (SELECT coalesce(min("ticketPrice"), 0) FROM game_templates WHERE active = true)
              AND NOT EXISTS (
                  SELECT 1 FROM game_entries ge
                  WHERE ge."userId" = u.id AND ge."joinedAt" >= now() - interval '7 days'
              )
        `)
        const d = dist[0] ?? { one_game: 0, g2_5: 0, g6_20: 0, g20_plus: 0, active_7d: 0, total_players: 0 }
        const w = winExp[0] ?? { winners_total: 0, winners_active_7d: 0, losers_total: 0, losers_active_7d: 0 }
        return {
            totalPlayers: d.total_players,
            active7d: d.active_7d,
            oneAndDonePct: this.pct(d.one_game, d.total_players),
            distribution: { '1': d.one_game, '2-5': d.g2_5, '6-20': d.g6_20, '20+': d.g20_plus },
            winExperience: {
                winners: { total: w.winners_total, active7dPct: this.pct(w.winners_active_7d, w.winners_total) },
                neverWon: { total: w.losers_total, active7dPct: this.pct(w.losers_active_7d, w.losers_total) },
            },
            idleMoney: {
                wallets: idle[0]?.idle_wallets ?? 0,
                balance: Number(idle[0]?.idle_balance ?? 0),
            },
        }
    }
}
