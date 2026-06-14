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
              AND u."createdAt" >= date_trunc('week', now()) - (${weeks} * interval '1 week')
            GROUP BY 1 ORDER BY 1
        `)
        const activity = await prisma.$queryRaw<Array<{ cohort_week: Date; week_offset: number; active_users: number }>>(Prisma.sql`
            WITH cohorts AS (
                SELECT u.id, date_trunc('week', u."createdAt") AS cohort_week
                FROM users u
                WHERE ${NON_BOT_PLAYER}
                  AND u."createdAt" >= date_trunc('week', now()) - (${weeks} * interval '1 week')
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

    static buildFunnelStages(
        labels: string[],
        values: number[],
    ): Array<{ name: string; count: number; dropOffPct: number }> {
        return labels.map((name, i) => ({
            name,
            count: values[i] ?? 0,
            dropOffPct: i === 0 ? 0 : this.pct((values[i - 1] ?? 0) - (values[i] ?? 0), values[i - 1] ?? 0),
        }))
    }

    static async getBrowseFunnel(from: Date, to: Date) {
        const rows = await prisma.$queryRaw<Array<{
            visited: number; viewed_game: number; join_click: number;
            registered: number; deposited: number; played: number;
        }>>(Prisma.sql`
            WITH visited AS (
                SELECT DISTINCT coalesce("userId", "anonId") AS actor
                FROM analytics_events
                WHERE name = 'lobby_view' AND "createdAt" >= ${from} AND "createdAt" < ${to}
            ),
            viewed_game AS (
                SELECT DISTINCT coalesce("userId", "anonId") AS actor
                FROM analytics_events
                WHERE name = 'game_view' AND "createdAt" >= ${from} AND "createdAt" < ${to}
            ),
            join_click AS (
                SELECT DISTINCT coalesce("userId", "anonId") AS actor
                FROM analytics_events
                WHERE name = 'join_click' AND "createdAt" >= ${from} AND "createdAt" < ${to}
            ),
            registered AS (
                SELECT DISTINCT u.id AS user_id
                FROM users u
                WHERE u."createdAt" >= ${from} AND u."createdAt" < ${to}
                  AND u."passwordHash" != 'BOT_ACCOUNT'
            ),
            deposited AS (
                SELECT DISTINCT t."userId"
                FROM transactions t
                WHERE t.type = 'DEPOSIT' AND t.status = 'APPROVED'
                  AND t."createdAt" >= ${from} AND t."createdAt" < ${to}
                  AND t."userId" IN (SELECT user_id FROM registered)
            ),
            played AS (
                SELECT DISTINCT ge."userId"
                FROM game_entries ge
                WHERE ge."joinedAt" >= ${from} AND ge."joinedAt" < ${to}
                  AND ge."userId" IN (SELECT user_id FROM registered)
            )
            SELECT
                (SELECT count(*)::int FROM visited)      AS visited,
                (SELECT count(*)::int FROM viewed_game)  AS viewed_game,
                (SELECT count(*)::int FROM join_click)   AS join_click,
                (SELECT count(*)::int FROM registered)   AS registered,
                (SELECT count(*)::int FROM deposited)    AS deposited,
                (SELECT count(*)::int FROM played)       AS played
        `)
        const r = rows[0] ?? { visited: 0, viewed_game: 0, join_click: 0, registered: 0, deposited: 0, played: 0 }
        const labels = ['visited', 'viewed_game', 'join_click', 'registered', 'deposited', 'played']
        const values = [r.visited, r.viewed_game, r.join_click, r.registered, r.deposited, r.played]
        return { stages: this.buildFunnelStages(labels, values) }
    }

    static async getDepositFunnel(from: Date, to: Date) {
        const stageRows = await prisma.$queryRaw<Array<{
            modal_opened: number; method_selected: number; amount_entered: number;
            submitted: number; approved: number;
        }>>(Prisma.sql`
            SELECT
                count(DISTINCT CASE WHEN name = 'deposit_modal_opened'    THEN coalesce("userId", "anonId") END)::int AS modal_opened,
                count(DISTINCT CASE WHEN name = 'deposit_method_selected' THEN coalesce("userId", "anonId") END)::int AS method_selected,
                count(DISTINCT CASE WHEN name = 'deposit_amount_entered'  THEN coalesce("userId", "anonId") END)::int AS amount_entered,
                count(DISTINCT CASE WHEN name = 'deposit_submitted'       THEN "userId" END)::int AS submitted,
                (SELECT count(*)::int FROM transactions
                 WHERE type = 'DEPOSIT' AND status = 'APPROVED'
                   AND "createdAt" >= ${from} AND "createdAt" < ${to}) AS approved
            FROM analytics_events
            WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
              AND name IN ('deposit_modal_opened','deposit_method_selected','deposit_amount_entered','deposit_submitted')
        `)
        const methodRows = await prisma.$queryRaw<Array<{
            payment_method: string; submitted: number; approved: number;
        }>>(Prisma.sql`
            SELECT
                (ae.props->>'paymentMethod') AS payment_method,
                count(*)::int AS submitted,
                count(t.id)::int AS approved
            FROM analytics_events ae
            LEFT JOIN transactions t
                ON t.id = (ae.props->>'txId')
               AND t.status = 'APPROVED'
            WHERE ae.name = 'deposit_submitted'
              AND ae."createdAt" >= ${from} AND ae."createdAt" < ${to}
              AND ae.props->>'paymentMethod' IS NOT NULL
            GROUP BY 1
            ORDER BY submitted DESC
        `)
        const r = stageRows[0] ?? { modal_opened: 0, method_selected: 0, amount_entered: 0, submitted: 0, approved: 0 }
        const labels = ['modal_opened', 'method_selected', 'amount_entered', 'submitted', 'approved']
        const values = [r.modal_opened, r.method_selected, r.amount_entered, r.submitted, r.approved]
        return {
            stages: this.buildFunnelStages(labels, values),
            byMethod: methodRows.map(m => ({
                method: m.payment_method,
                submitted: m.submitted,
                approved: m.approved,
                conversionPct: this.pct(m.approved, m.submitted),
            })),
        }
    }

    static async getConversionKpis(from: Date, to: Date) {
        const rows = await prisma.$queryRaw<Array<{
            total_visitors: number; anon_visitors: number; registered: number;
            first_deposited: number; browse_sessions: number; join_clicks: number;
        }>>(Prisma.sql`
            SELECT
                count(DISTINCT coalesce("userId", "anonId"))::int AS total_visitors,
                count(DISTINCT CASE WHEN "userId" IS NULL THEN "anonId" END)::int AS anon_visitors,
                (SELECT count(*)::int FROM users u
                 WHERE u."createdAt" >= ${from} AND u."createdAt" < ${to}
                   AND u."passwordHash" != 'BOT_ACCOUNT') AS registered,
                (SELECT count(DISTINCT t."userId")::int FROM transactions t
                 WHERE t.type = 'DEPOSIT' AND t.status = 'APPROVED'
                   AND t."createdAt" >= ${from} AND t."createdAt" < ${to}
                   AND NOT EXISTS (
                     SELECT 1 FROM transactions t2
                     WHERE t2."userId" = t."userId" AND t2.type = 'DEPOSIT' AND t2.status = 'APPROVED'
                       AND t2."createdAt" < ${from}
                   )) AS first_deposited,
                count(DISTINCT "sessionId")::int AS browse_sessions,
                count(DISTINCT CASE WHEN name = 'join_click' THEN coalesce("userId", "anonId") END)::int AS join_clicks
            FROM analytics_events
            WHERE name = 'lobby_view'
              AND "createdAt" >= ${from} AND "createdAt" < ${to}
        `)
        const r = rows[0] ?? { total_visitors: 0, anon_visitors: 0, registered: 0, first_deposited: 0, browse_sessions: 0, join_clicks: 0 }
        return {
            totalVisitors: r.total_visitors,
            anonVisitors: r.anon_visitors,
            registered: r.registered,
            firstDeposited: r.first_deposited,
            visitorToRegPct: this.pct(r.registered, r.total_visitors),
            regToDepositPct: this.pct(r.first_deposited, r.registered),
            browseToJoinPct: this.pct(r.join_clicks, r.total_visitors),
        }
    }

    /** Per-game new-player return lift scorecard (bingo + provider games). */
    static async getGameRetentionScorecard(from: Date, to: Date) {
        const [cohortRows, stickinessRows] = await Promise.all([
            prisma.$queryRaw<Array<{
                game_key: string
                game_label: string
                game_type: string
                cohort_size: number
                returned_7d: number
                returned_next_day: number
                baseline_total: number
                baseline_returned: number
            }>>(Prisma.sql`
                WITH all_plays AS (
                    SELECT ge."userId",
                           CONCAT('bingo:', gt.id) AS game_key,
                           gt.title              AS game_label,
                           'bingo'::text         AS game_type,
                           ge."joinedAt"         AS played_at
                    FROM game_entries ge
                    JOIN games g ON g.id = ge."gameId"
                    JOIN game_templates gt ON gt.id = g."templateId"
                    JOIN users u ON u.id = ge."userId"
                    WHERE u."passwordHash" != 'BOT_ACCOUNT' AND u.role = 'PLAYER'

                    UNION ALL

                    SELECT tpt."userId",
                           CONCAT('provider:', tpt."gameCode")         AS game_key,
                           COALESCE(pg."gameName", tpt."gameCode")     AS game_label,
                           'provider'::text                            AS game_type,
                           DATE_TRUNC('day', MIN(tpt."createdAt"))     AS played_at
                    FROM third_party_transactions tpt
                    LEFT JOIN provider_games pg ON pg."gameCode" = tpt."gameCode"
                    JOIN users u ON u.id = tpt."userId"
                    WHERE tpt.amount < 0
                      AND tpt."gameCode" IS NOT NULL
                      AND u."passwordHash" != 'BOT_ACCOUNT' AND u.role = 'PLAYER'
                    GROUP BY tpt."userId", tpt."gameCode",
                             DATE_TRUNC('day', tpt."createdAt"), pg."gameName"
                ),
                player_first AS (
                    SELECT "userId", MIN(played_at) AS first_at
                    FROM all_plays
                    GROUP BY "userId"
                ),
                new_players AS (
                    SELECT pf."userId",
                           ap.game_key, ap.game_label, ap.game_type,
                           ap.played_at AS first_played_at
                    FROM player_first pf
                    JOIN all_plays ap
                      ON ap."userId" = pf."userId" AND ap.played_at = pf.first_at
                    WHERE pf.first_at >= ${from} AND pf.first_at < ${to}
                ),
                returns_7d AS (
                    SELECT DISTINCT np."userId"
                    FROM new_players np
                    WHERE EXISTS (
                        SELECT 1 FROM all_plays r
                        WHERE r."userId" = np."userId"
                          AND DATE(r.played_at) > DATE(np.first_played_at)
                          AND r.played_at < np.first_played_at + INTERVAL '7 days'
                    )
                ),
                returns_next_day AS (
                    SELECT DISTINCT np."userId"
                    FROM new_players np
                    WHERE EXISTS (
                        SELECT 1 FROM all_plays r
                        WHERE r."userId" = np."userId"
                          AND DATE(r.played_at) = DATE(np.first_played_at) + 1
                    )
                ),
                baseline AS (
                    SELECT
                        COUNT(DISTINCT np."userId")::int AS total,
                        COUNT(DISTINCT r."userId")::int  AS returned
                    FROM new_players np
                    LEFT JOIN returns_7d r ON r."userId" = np."userId"
                )
                SELECT
                    gs.game_key,
                    gs.game_label,
                    gs.game_type,
                    gs.cohort_size,
                    gs.returned_7d,
                    gs.returned_next_day,
                    b.total    AS baseline_total,
                    b.returned AS baseline_returned
                FROM (
                    SELECT
                        np.game_key,
                        MAX(np.game_label)                             AS game_label,
                        MAX(np.game_type)                              AS game_type,
                        COUNT(DISTINCT np."userId")::int               AS cohort_size,
                        COUNT(DISTINCT r7."userId")::int               AS returned_7d,
                        COUNT(DISTINCT rnd."userId")::int              AS returned_next_day
                    FROM new_players np
                    LEFT JOIN returns_7d r7    ON r7."userId"  = np."userId"
                    LEFT JOIN returns_next_day rnd ON rnd."userId" = np."userId"
                    GROUP BY np.game_key
                ) gs
                CROSS JOIN baseline b
                ORDER BY gs.cohort_size DESC
            `),

            prisma.$queryRaw<Array<{
                game_key: string
                total_sessions: number
                total_players: number
                replay_players: number
                avg_net_pnl: string | null
            }>>(Prisma.sql`
                WITH sessions AS (
                    SELECT ge."userId",
                           CONCAT('bingo:', gt.id) AS game_key,
                           DATE(ge."joinedAt")     AS play_date,
                           NULL::numeric           AS session_pnl
                    FROM game_entries ge
                    JOIN games g ON g.id = ge."gameId"
                    JOIN game_templates gt ON gt.id = g."templateId"
                    JOIN users u ON u.id = ge."userId"
                    WHERE u."passwordHash" != 'BOT_ACCOUNT' AND u.role = 'PLAYER'
                      AND ge."joinedAt" >= ${from} AND ge."joinedAt" < ${to}

                    UNION ALL

                    SELECT tpt."userId",
                           CONCAT('provider:', tpt."gameCode") AS game_key,
                           DATE(tpt."createdAt")               AS play_date,
                           SUM(tpt.amount)::numeric            AS session_pnl
                    FROM third_party_transactions tpt
                    JOIN users u ON u.id = tpt."userId"
                    WHERE tpt."gameCode" IS NOT NULL
                      AND u."passwordHash" != 'BOT_ACCOUNT' AND u.role = 'PLAYER'
                      AND tpt."createdAt" >= ${from} AND tpt."createdAt" < ${to}
                    GROUP BY tpt."userId", tpt."gameCode", DATE(tpt."createdAt")
                ),
                per_player AS (
                    SELECT "userId", game_key, COUNT(DISTINCT play_date)::int AS day_count
                    FROM sessions
                    GROUP BY "userId", game_key
                )
                SELECT
                    s.game_key,
                    COUNT(*)::int                                                 AS total_sessions,
                    COUNT(DISTINCT s."userId")::int                               AS total_players,
                    COUNT(DISTINCT CASE WHEN pp.day_count > 1 THEN s."userId" END)::int AS replay_players,
                    ROUND(AVG(s.session_pnl) FILTER (WHERE s.session_pnl IS NOT NULL), 2)::text AS avg_net_pnl
                FROM sessions s
                JOIN per_player pp ON pp."userId" = s."userId" AND pp.game_key = s.game_key
                GROUP BY s.game_key
            `),
        ])

        if (!cohortRows.length) return { rows: [], baselineReturn7dPct: 0 }

        const baselineReturn7dPct = this.pct(
            cohortRows[0]?.baseline_returned ?? 0,
            cohortRows[0]?.baseline_total ?? 0,
        )

        const stickyMap = new Map(stickinessRows.map(r => [r.game_key, r]))

        const rows = cohortRows.map(c => {
            const s = stickyMap.get(c.game_key)
            const returnRate7d = this.pct(c.returned_7d, c.cohort_size)
            const totalSessions = s?.total_sessions ?? 0
            const totalPlayers = s?.total_players ?? 0
            return {
                gameKey: c.game_key,
                gameLabel: c.game_label,
                gameType: c.game_type as 'bingo' | 'provider',
                firstGameCohort: c.cohort_size,
                returnRate7d,
                lift: Math.round((returnRate7d - baselineReturn7dPct) * 10) / 10,
                nextDayReturn: this.pct(c.returned_next_day, c.cohort_size),
                replayRate: this.pct(s?.replay_players ?? 0, totalPlayers),
                sessionsPerPlayer: totalPlayers ? Math.round((totalSessions / totalPlayers) * 10) / 10 : 0,
                avgNetPnl: s?.avg_net_pnl != null ? Number(s.avg_net_pnl) : null,
                lowSample: c.cohort_size < 10,
            }
        })

        return { rows, baselineReturn7dPct }
    }

    /** Provider browse funnel: viewed → launched → first_bet → returned_7d */
    static async getProviderBrowseFunnel(from: Date, to: Date) {
        const rows = await prisma.$queryRaw<Array<{
            viewed: number; launched: number; first_bet: number; returned_7d: number
        }>>(Prisma.sql`
            WITH viewed AS (
                SELECT DISTINCT coalesce("userId", "anonId") AS actor
                FROM analytics_events
                WHERE name = 'provider_game_view'
                  AND "createdAt" >= ${from} AND "createdAt" < ${to}
            ),
            launched AS (
                SELECT DISTINCT "userId" AS actor
                FROM analytics_events
                WHERE name = 'provider_game_launched'
                  AND "userId" IS NOT NULL
                  AND "createdAt" >= ${from} AND "createdAt" < ${to}
            ),
            first_betters AS (
                SELECT DISTINCT tpt."userId" AS actor
                FROM third_party_transactions tpt
                JOIN users u ON u.id = tpt."userId"
                WHERE tpt.amount < 0
                  AND tpt."gameCode" IS NOT NULL
                  AND u."passwordHash" != 'BOT_ACCOUNT' AND u.role = 'PLAYER'
                  AND tpt."createdAt" >= ${from} AND tpt."createdAt" < ${to}
            ),
            retained AS (
                SELECT DISTINCT fb.actor
                FROM first_betters fb
                WHERE EXISTS (
                    SELECT 1 FROM third_party_transactions tpt2
                    JOIN users u2 ON u2.id = tpt2."userId"
                    WHERE tpt2."userId" = fb.actor
                      AND tpt2.amount < 0
                      AND tpt2."createdAt" > ${to}
                      AND tpt2."createdAt" < ${to}::timestamptz + INTERVAL '7 days'
                      AND u2."passwordHash" != 'BOT_ACCOUNT' AND u2.role = 'PLAYER'
                )
            )
            SELECT
                (SELECT count(*)::int FROM viewed)       AS viewed,
                (SELECT count(*)::int FROM launched)     AS launched,
                (SELECT count(*)::int FROM first_betters) AS first_bet,
                (SELECT count(*)::int FROM retained)     AS returned_7d
        `)
        const r = rows[0] ?? { viewed: 0, launched: 0, first_bet: 0, returned_7d: 0 }
        const labels = ['viewed', 'launched', 'first_bet', 'returned_7d']
        const values = [r.viewed, r.launched, r.first_bet, r.returned_7d]
        return {
            stages: this.buildFunnelStages(labels, values),
            hasEnoughData: r.viewed >= 50,
        }
    }
}
