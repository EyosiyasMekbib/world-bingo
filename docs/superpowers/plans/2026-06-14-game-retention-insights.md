# Game Retention Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-game retention scorecard (bingo + provider) to the admin analytics page that shows which games cause new players to return and which drive them away, plus lightweight provider game instrumentation for future funnel analysis.

**Architecture:** Two new `AnalyticsService` static methods backed by raw SQL (`getGameRetentionScorecard`, `getProviderBrowseFunnel`) drive two new admin-only endpoints and a new "Game Retention" section on the existing `/analytics` page. Tier 2 adds three new event names to the existing `EventService` allowlist, emits `provider_game_launched` from the API launch handler, and instruments the frontend play page with `provider_game_view` / `provider_session_ended` via `useAnalytics()`.

**Tech Stack:** Prisma 5 `$queryRaw` + `Prisma.sql`, Fastify v5 admin routes, Vitest mocked-prisma tests, Nuxt 3 + Vue 3 composable.

---

## Domain context

- **Bingo play** = 1 `GameEntry` row; cost = `Transaction.type = 'GAME_ENTRY'` (negative amount, `referenceId = gameId`); prize = `Transaction.type = 'PRIZE_WIN'` (positive, `referenceId = gameId`).
- **Provider play** = all `ThirdPartyTransaction` rows for one `(userId, gameCode, calendar-day)` grouped into a session; bets have `amount < 0`, wins have `amount > 0`.
- **Bot exclusion:** `users."passwordHash" != 'BOT_ACCOUNT' AND users.role = 'PLAYER'` (same as Layer 1).
- **New-player cohort:** users whose very first play (bingo OR provider, across all time) fell within the query date window.
- **Return window:** 7 days from the first play date (configurable only via `from`/`to` query params for now; the 7-day lookforward is fixed in the SQL).
- **Low sample guard:** `firstGameCohort < 10` → `lowSample: true` on that row.
- **Lift:** `returnRate7d(game) − baselineReturnRate` (both as 0-100 percentages from `pct()`).
- Camelcase DB columns must be double-quoted in raw SQL: `"userId"`, `"gameCode"`, `"gameName"`, `"joinedAt"`, `"passwordHash"`, `"templateId"`, `"gameId"`, `"referenceId"`.

## File map

| File | Action |
|------|--------|
| `apps/api/src/services/event.service.ts` | Add 3 new names to `ALLOWED_EVENTS` |
| `apps/api/src/services/analytics.service.ts` | Add `getGameRetentionScorecard`, `getProviderBrowseFunnel` |
| `apps/api/src/test/game-retention.service.test.ts` | New Vitest unit tests |
| `apps/api/src/routes/admin/analytics.ts` | Add `GET /game-retention`, `GET /provider-browse-funnel` |
| `apps/api/src/routes/game-provider/index.ts` | Fire `provider_game_launched` in launch handler |
| `apps/admin/composables/useAdminApi.ts` | 2 new typed client methods |
| `apps/admin/pages/analytics.vue` | New "Game Retention" section (scorecard table + provider funnel) |
| `apps/web/pages/play/[providerCode]/[gameCode].vue` | Track `provider_game_view`, `provider_game_launched`, `provider_session_ended` |

---

### Task 1: Extend EventService allowlist

**Files:**
- Modify: `apps/api/src/services/event.service.ts`

- [ ] **Step 1: Add three new event names to the allowlist**

Replace the `ALLOWED_EVENTS` array in `apps/api/src/services/event.service.ts`. Change:

```ts
export const ALLOWED_EVENTS = [
    'lobby_view',
    'game_view',
    'join_click',
    'deposit_modal_opened',
    'deposit_method_selected',
    'deposit_amount_entered',
    'deposit_submitted',
    'identify',
] as const
```

To:

```ts
export const ALLOWED_EVENTS = [
    'lobby_view',
    'game_view',
    'join_click',
    'deposit_modal_opened',
    'deposit_method_selected',
    'deposit_amount_entered',
    'deposit_submitted',
    'identify',
    'provider_game_view',
    'provider_game_launched',
    'provider_session_ended',
] as const
```

- [ ] **Step 2: Run existing EventService tests to confirm they still pass**

```bash
cd apps/api && pnpm vitest run src/test/event.service.test.ts 2>&1 | tail -8
```

Expected: `Tests 5 passed (5)`

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/event.service.ts
git commit -m "feat: add provider_game_view/launched/session_ended to analytics allowlist"
```

---

### Task 2: `getGameRetentionScorecard` (TDD)

**Files:**
- Create: `apps/api/src/test/game-retention.service.test.ts`
- Modify: `apps/api/src/services/analytics.service.ts`

The method runs **two parallel raw SQL queries**:
1. **Cohort query** — finds new players in the window, groups by their first game, counts 7-day and next-day returns, and computes a cross-join baseline.
2. **Stickiness query** — scoped to the window, counts total sessions, unique players, replay players (>1 distinct day), and avg net P&L per game.

TypeScript merges the results and computes rates.

- [ ] **Step 1: Write failing tests**

Create `apps/api/src/test/game-retention.service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
    default: { $queryRaw: vi.fn() },
}))
import prisma from '../lib/prisma'
const queryRaw = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>

import { AnalyticsService } from '../services/analytics.service'

beforeEach(() => vi.clearAllMocks())

describe('AnalyticsService.getGameRetentionScorecard', () => {
    it('shapes cohort + stickiness rows into scorecard rows', async () => {
        // cohortRows (query 1): one per game
        queryRaw.mockResolvedValueOnce([
            {
                game_key: 'bingo:t1',
                game_label: 'Quick 10',
                game_type: 'bingo',
                cohort_size: 100,
                returned_7d: 60,
                returned_next_day: 40,
                baseline_total: 200,
                baseline_returned: 80,
            },
            {
                game_key: 'provider:SLOTS_001',
                game_label: 'Lucky Spin',
                game_type: 'provider',
                cohort_size: 50,
                returned_7d: 20,
                returned_next_day: 10,
                baseline_total: 200,
                baseline_returned: 80,
            },
        ])
        // stickinessRows (query 2): one per game
        queryRaw.mockResolvedValueOnce([
            {
                game_key: 'bingo:t1',
                total_sessions: 300,
                total_players: 150,
                replay_players: 90,
                avg_net_pnl: null,
            },
            {
                game_key: 'provider:SLOTS_001',
                total_sessions: 200,
                total_players: 100,
                replay_players: 30,
                avg_net_pnl: '-12.50',
            },
        ])

        const out = await AnalyticsService.getGameRetentionScorecard(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )

        expect(out.rows).toHaveLength(2)
        expect(out.baselineReturn7dPct).toBe(40)

        const bingo = out.rows.find(r => r.gameKey === 'bingo:t1')!
        expect(bingo.gameLabel).toBe('Quick 10')
        expect(bingo.gameType).toBe('bingo')
        expect(bingo.firstGameCohort).toBe(100)
        expect(bingo.returnRate7d).toBe(60)       // pct(60, 100)
        expect(bingo.lift).toBe(20)               // 60 - 40
        expect(bingo.nextDayReturn).toBe(40)      // pct(40, 100)
        expect(bingo.replayRate).toBe(60)         // pct(90, 150)
        expect(bingo.sessionsPerPlayer).toBe(2)   // 300/150
        expect(bingo.avgNetPnl).toBeNull()
        expect(bingo.lowSample).toBe(false)

        const provider = out.rows.find(r => r.gameKey === 'provider:SLOTS_001')!
        expect(provider.returnRate7d).toBe(40)    // pct(20, 50)
        expect(provider.lift).toBe(0)             // 40 - 40
        expect(provider.avgNetPnl).toBe(-12.5)
        expect(provider.lowSample).toBe(false)
    })

    it('marks low-sample rows (cohort < 10)', async () => {
        queryRaw.mockResolvedValueOnce([{
            game_key: 'bingo:t2', game_label: 'Rare', game_type: 'bingo',
            cohort_size: 5, returned_7d: 3, returned_next_day: 2,
            baseline_total: 100, baseline_returned: 50,
        }])
        queryRaw.mockResolvedValueOnce([{
            game_key: 'bingo:t2', total_sessions: 5, total_players: 5,
            replay_players: 0, avg_net_pnl: null,
        }])
        const out = await AnalyticsService.getGameRetentionScorecard(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )
        expect(out.rows[0].lowSample).toBe(true)
    })

    it('handles empty result gracefully', async () => {
        queryRaw.mockResolvedValueOnce([])
        queryRaw.mockResolvedValueOnce([])
        const out = await AnalyticsService.getGameRetentionScorecard(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )
        expect(out.rows).toHaveLength(0)
        expect(out.baselineReturn7dPct).toBe(0)
    })
})

describe('AnalyticsService.getProviderBrowseFunnel', () => {
    it('returns stages with drop-off pcts', async () => {
        queryRaw.mockResolvedValueOnce([{
            viewed: 400,
            launched: 300,
            first_bet: 200,
            returned_7d: 80,
        }])
        const out = await AnalyticsService.getProviderBrowseFunnel(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )
        expect(out.stages).toHaveLength(4)
        expect(out.stages[0]).toEqual({ name: 'viewed', count: 400, dropOffPct: 0 })
        expect(out.stages[1]).toEqual({ name: 'launched', count: 300, dropOffPct: 25 })
        expect(out.stages[2]).toEqual({ name: 'first_bet', count: 200, dropOffPct: 33.3 })
        expect(out.stages[3]).toEqual({ name: 'returned_7d', count: 80, dropOffPct: 60 })
        expect(out.hasEnoughData).toBe(true)
    })

    it('returns hasEnoughData false when viewed < 50', async () => {
        queryRaw.mockResolvedValueOnce([{ viewed: 30, launched: 20, first_bet: 10, returned_7d: 5 }])
        const out = await AnalyticsService.getProviderBrowseFunnel(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )
        expect(out.hasEnoughData).toBe(false)
    })

    it('handles empty result', async () => {
        queryRaw.mockResolvedValueOnce([])
        const out = await AnalyticsService.getProviderBrowseFunnel(
            new Date('2026-06-01'),
            new Date('2026-06-13'),
        )
        expect(out.stages.every(s => s.count === 0)).toBe(true)
        expect(out.hasEnoughData).toBe(false)
    })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd apps/api && pnpm vitest run src/test/game-retention.service.test.ts 2>&1 | tail -8
```

Expected: FAIL — `getGameRetentionScorecard is not a function`

- [ ] **Step 3: Add the two methods to AnalyticsService**

Append inside the `AnalyticsService` class in `apps/api/src/services/analytics.service.ts`, after the closing brace of `getConversionKpis`:

```ts
    /** Per-game new-player return lift scorecard (bingo + provider games). */
    static async getGameRetentionScorecard(from: Date, to: Date) {
        const [cohortRows, stickinessRows] = await Promise.all([
            // ── Query 1: cohort + return stats ────────────────────────────────────
            // Uses full history for all_plays (no date filter) so first-play detection
            // is accurate for players who joined before the report window.
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

            // ── Query 2: stickiness + P&L (window-scoped) ─────────────────────
            prisma.$queryRaw<Array<{
                game_key: string
                total_sessions: number
                total_players: number
                replay_players: number
                avg_net_pnl: string | null
            }>>(Prisma.sql`
                WITH sessions AS (
                    -- Bingo (one row = one game entry = one session)
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

                    -- Provider (grouped by user+game+day)
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
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd apps/api && pnpm vitest run src/test/game-retention.service.test.ts 2>&1 | tail -10
```

Expected: `Tests 6 passed (6)`

- [ ] **Step 5: Run the full analytics test suite**

```bash
cd apps/api && pnpm vitest run src/test/ 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @world-bingo/api typecheck 2>&1 | grep -v minio | grep -i error | head -10
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/analytics.service.ts apps/api/src/test/game-retention.service.test.ts
git commit -m "feat: getGameRetentionScorecard and getProviderBrowseFunnel analytics methods"
```

---

### Task 3: Admin endpoints + API client methods

**Files:**
- Modify: `apps/api/src/routes/admin/analytics.ts`
- Modify: `apps/admin/composables/useAdminApi.ts`

- [ ] **Step 1: Add two endpoints to the analytics routes plugin**

In `apps/api/src/routes/admin/analytics.ts`, append inside the `analyticsRoutes` plugin (after the `conversion-kpis` route, before the closing `}`):

```ts
    fastify.get('/game-retention', async (req: any, reply) => {
        const parsed = rangeQuerySchema.safeParse(req.query)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', details: parsed.error.issues })
        try {
            const { from, to } = AnalyticsService.parseRange(parsed.data.from, parsed.data.to)
            return await AnalyticsService.getGameRetentionScorecard(from, to)
        } catch (err: any) {
            return reply.status(400).send({ error: err.message })
        }
    })

    fastify.get('/provider-browse-funnel', async (req: any, reply) => {
        const parsed = rangeQuerySchema.safeParse(req.query)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', details: parsed.error.issues })
        try {
            const { from, to } = AnalyticsService.parseRange(parsed.data.from, parsed.data.to)
            return await AnalyticsService.getProviderBrowseFunnel(from, to)
        } catch (err: any) {
            return reply.status(400).send({ error: err.message })
        }
    })
```

- [ ] **Step 2: Add typed client methods to the admin API composable**

In `apps/admin/composables/useAdminApi.ts`, add inside the returned object after `getAnalyticsConversionKpis`:

```ts
        getGameRetentionScorecard: (params?: { from?: string; to?: string }) => {
            const qs = new URLSearchParams()
            if (params?.from) qs.set('from', params.from)
            if (params?.to) qs.set('to', params.to)
            const query = qs.toString()
            return apiFetch<{
                rows: Array<{
                    gameKey: string
                    gameLabel: string
                    gameType: 'bingo' | 'provider'
                    firstGameCohort: number
                    returnRate7d: number
                    lift: number
                    nextDayReturn: number
                    replayRate: number
                    sessionsPerPlayer: number
                    avgNetPnl: number | null
                    lowSample: boolean
                }>
                baselineReturn7dPct: number
            }>(`/admin/analytics/game-retention${query ? `?${query}` : ''}`)
        },

        getProviderBrowseFunnel: (params?: { from?: string; to?: string }) => {
            const qs = new URLSearchParams()
            if (params?.from) qs.set('from', params.from)
            if (params?.to) qs.set('to', params.to)
            const query = qs.toString()
            return apiFetch<{
                stages: Array<{ name: string; count: number; dropOffPct: number }>
                hasEnoughData: boolean
            }>(`/admin/analytics/provider-browse-funnel${query ? `?${query}` : ''}`)
        },
```

- [ ] **Step 3: Typecheck both packages**

```bash
pnpm --filter @world-bingo/api typecheck 2>&1 | grep -v minio | grep -i error | head -5
pnpm --filter @world-bingo/admin typecheck 2>&1 | grep -i error | head -5
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/admin/analytics.ts apps/admin/composables/useAdminApi.ts
git commit -m "feat: admin game-retention and provider-browse-funnel endpoints"
```

---

### Task 4: Analytics page — Game Retention section

**Files:**
- Modify: `apps/admin/pages/analytics.vue`

This adds the "Game Retention" section to the admin analytics page. The section includes:
1. A baseline KPI chip ("Baseline 7-day return: X%")
2. A sortable scorecard table with color-coded lift column
3. A provider browse funnel (shown only when `hasEnoughData`)

- [ ] **Step 1: Add refs and load calls to the script setup**

In `apps/admin/pages/analytics.vue`, in `<script setup>`, add after the existing `conversionKpis` ref:

```ts
const gameRetention = ref<Awaited<ReturnType<typeof api.getGameRetentionScorecard>> | null>(null)
const providerFunnel = ref<Awaited<ReturnType<typeof api.getProviderBrowseFunnel>> | null>(null)
const retentionSortKey = ref<'lift' | 'firstGameCohort' | 'returnRate7d' | 'replayRate'>('lift')
const retentionSortDir = ref<'asc' | 'desc'>('desc')
```

- [ ] **Step 2: Add load calls**

In the existing `load()` function, extend the `Promise.all` destructure to add `gr` and `pf`:

Change:
```ts
    const [f, r, g, e, bf, df, ck] = await Promise.all([
      api.getAnalyticsFunnel({ from }),
      api.getAnalyticsRetention(8),
      api.getAnalyticsGamesHealth({ from }),
      api.getAnalyticsEngagement(),
      api.getAnalyticsBrowseFunnel({ from }),
      api.getAnalyticsDepositFunnel({ from }),
      api.getAnalyticsConversionKpis({ from }),
    ])
    funnel.value = f
    retention.value = r
    gamesHealth.value = g
    engagement.value = e
    browseFunnel.value = bf
    depositFunnel.value = df
    conversionKpis.value = ck
```

To:

```ts
    const [f, r, g, e, bf, df, ck, gr, pf] = await Promise.all([
      api.getAnalyticsFunnel({ from }),
      api.getAnalyticsRetention(8),
      api.getAnalyticsGamesHealth({ from }),
      api.getAnalyticsEngagement(),
      api.getAnalyticsBrowseFunnel({ from }),
      api.getAnalyticsDepositFunnel({ from }),
      api.getAnalyticsConversionKpis({ from }),
      api.getGameRetentionScorecard({ from }),
      api.getProviderBrowseFunnel({ from }),
    ])
    funnel.value = f
    retention.value = r
    gamesHealth.value = g
    engagement.value = e
    browseFunnel.value = bf
    depositFunnel.value = df
    conversionKpis.value = ck
    gameRetention.value = gr
    providerFunnel.value = pf
```

- [ ] **Step 3: Add sorted rows computed property**

After the existing computed properties in the script section, add:

```ts
const sortedRetentionRows = computed(() => {
  if (!gameRetention.value) return []
  const rows = [...gameRetention.value.rows]
  const key = retentionSortKey.value
  const dir = retentionSortDir.value === 'desc' ? -1 : 1
  return rows.sort((a, b) => (a[key] - b[key]) * dir)
})

function toggleSort(key: typeof retentionSortKey.value) {
  if (retentionSortKey.value === key) {
    retentionSortDir.value = retentionSortDir.value === 'desc' ? 'asc' : 'desc'
  } else {
    retentionSortKey.value = key
    retentionSortDir.value = 'desc'
  }
}
```

- [ ] **Step 4: Add the Game Retention HTML section**

In the `<template v-else>` section of `analytics.vue`, add this block **after** the deposit funnel section and **before** the retention matrix section (i.e. after the `</section>` that closes the deposit funnel, before `<!-- ── Retention matrix`):

```html
      <!-- ── Game Retention Scorecard ────────────────────────────── -->
      <section class="card" v-if="gameRetention">
        <h2 class="card-title">
          Which games retain new players?
          <span class="card-hint">
            baseline 7-day return: {{ gameRetention.baselineReturn7dPct }}%
          </span>
        </h2>
        <div class="retention-scroll">
          <table class="scorecard-table">
            <thead>
              <tr>
                <th class="sc-name">Game</th>
                <th class="sc-type">Type</th>
                <th class="sc-num" @click="toggleSort('firstGameCohort')" style="cursor:pointer">
                  Cohort <span v-if="retentionSortKey === 'firstGameCohort'">{{ retentionSortDir === 'desc' ? '↓' : '↑' }}</span>
                </th>
                <th class="sc-num" @click="toggleSort('returnRate7d')" style="cursor:pointer">
                  Return 7d <span v-if="retentionSortKey === 'returnRate7d'">{{ retentionSortDir === 'desc' ? '↓' : '↑' }}</span>
                </th>
                <th class="sc-num" @click="toggleSort('lift')" style="cursor:pointer">
                  Lift <span v-if="retentionSortKey === 'lift'">{{ retentionSortDir === 'desc' ? '↓' : '↑' }}</span>
                </th>
                <th class="sc-num">Next-day</th>
                <th class="sc-num" @click="toggleSort('replayRate')" style="cursor:pointer">
                  Replay <span v-if="retentionSortKey === 'replayRate'">{{ retentionSortDir === 'desc' ? '↓' : '↑' }}</span>
                </th>
                <th class="sc-num">Plays/player</th>
                <th class="sc-num">Avg P&L</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in sortedRetentionRows"
                :key="row.gameKey"
                :class="{
                  'sc-row--retaining': row.lift > 5,
                  'sc-row--churn': row.lift < -5,
                }"
              >
                <td class="sc-name">
                  {{ row.gameLabel }}
                  <span v-if="row.lowSample" class="sc-low-sample" title="Small cohort — treat with caution">⚠</span>
                </td>
                <td class="sc-type">
                  <span class="sc-badge" :class="row.gameType === 'bingo' ? 'sc-badge--bingo' : 'sc-badge--provider'">
                    {{ row.gameType === 'bingo' ? 'Bingo' : 'Slot' }}
                  </span>
                </td>
                <td class="sc-num">{{ row.firstGameCohort.toLocaleString() }}</td>
                <td class="sc-num">{{ row.returnRate7d }}%</td>
                <td class="sc-num sc-lift" :class="row.lift > 0 ? 'sc-lift--up' : row.lift < 0 ? 'sc-lift--down' : ''">
                  {{ row.lift > 0 ? '+' : '' }}{{ row.lift }}%
                </td>
                <td class="sc-num">{{ row.nextDayReturn }}%</td>
                <td class="sc-num">{{ row.replayRate }}%</td>
                <td class="sc-num">{{ row.sessionsPerPlayer }}×</td>
                <td class="sc-num" :class="row.avgNetPnl != null && row.avgNetPnl < 0 ? 'sc-pnl--neg' : 'sc-pnl--pos'">
                  {{ row.avgNetPnl != null ? (row.avgNetPnl >= 0 ? '+' : '') + row.avgNetPnl.toFixed(2) : '—' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Provider browse funnel sub-section (only when Tier 2 data exists) -->
        <template v-if="providerFunnel">
          <div v-if="!providerFunnel.hasEnoughData" class="sc-no-data">
            Provider browse funnel — not enough data yet (need ≥ 50 provider game views in the window)
          </div>
          <template v-else>
            <h3 class="sc-subtitle">Provider browse funnel</h3>
            <div class="funnel">
              <div v-for="stage in providerFunnel.stages" :key="stage.name" class="funnel-row">
                <span class="funnel-label">{{ { viewed: 'Viewed game', launched: 'Launched', first_bet: 'Placed first bet', returned_7d: 'Returned 7d' }[stage.name] ?? stage.name }}</span>
                <div class="funnel-track">
                  <div
                    class="funnel-bar funnel-bar--blue"
                    :style="{ width: (providerFunnel.stages[0]?.count ? (stage.count / providerFunnel.stages[0].count) * 100 : 0) + '%' }"
                  />
                </div>
                <span class="funnel-count">{{ stage.count.toLocaleString() }}</span>
                <span class="funnel-pct" :class="stage.dropOffPct > 40 ? 'funnel-pct--warn' : ''">
                  {{ stage.dropOffPct > 0 ? `-${stage.dropOffPct}%` : '—' }}
                </span>
              </div>
            </div>
          </template>
        </template>
      </section>
```

- [ ] **Step 5: Add scoped styles**

In the `<style scoped>` section at the bottom of `analytics.vue`, append:

```css
/* Game Retention Scorecard */
.scorecard-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.scorecard-table th { padding: 6px 10px; text-align: right; color: var(--text-muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--surface-border); white-space: nowrap; }
.scorecard-table th.sc-name, .scorecard-table td.sc-name { text-align: left; }
.scorecard-table td { padding: 7px 10px; border-bottom: 1px solid rgba(255,255,255,0.04); color: var(--text-primary); }
.sc-num { text-align: right; font-variant-numeric: tabular-nums; }
.sc-type { text-align: center; }
.sc-row--retaining td { background: rgba(52,211,153,0.04); }
.sc-row--churn td { background: rgba(248,113,113,0.05); }
.sc-lift { font-weight: 700; }
.sc-lift--up { color: #34d399; }
.sc-lift--down { color: #f87171; }
.sc-pnl--neg { color: #f87171; }
.sc-pnl--pos { color: #34d399; }
.sc-low-sample { color: #fbbf24; font-size: 10px; margin-left: 4px; cursor: help; }
.sc-badge { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
.sc-badge--bingo { background: rgba(245,158,11,0.15); color: #f59e0b; }
.sc-badge--provider { background: rgba(99,102,241,0.15); color: #818cf8; }
.sc-subtitle { font-size: 12px; font-weight: 600; color: var(--text-muted); margin: 16px 0 10px; text-transform: uppercase; letter-spacing: 0.06em; }
.sc-no-data { font-size: 12px; color: var(--text-muted); padding: 12px 0; margin-top: 12px; border-top: 1px solid var(--surface-border); }
```

- [ ] **Step 6: Typecheck the admin app**

```bash
pnpm --filter @world-bingo/admin typecheck 2>&1 | grep -i error | head -10
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/admin/pages/analytics.vue
git commit -m "feat: game retention scorecard section on admin analytics page"
```

---

### Task 5: Backend — provider launch instrumentation

**Files:**
- Modify: `apps/api/src/routes/game-provider/index.ts`

Fire `provider_game_launched` with `balanceBefore` (the player's real balance at launch time) after the game URL is obtained. Non-blocking — must not fail the launch if the event write fails.

- [ ] **Step 1: Add EventService import**

At the top of `apps/api/src/routes/game-provider/index.ts`, add:

```ts
import { EventService } from '../../services/event.service.js'
```

- [ ] **Step 2: Fetch wallet balance and emit event in the launch handler**

In the launch handler (around line 87), after `return { gameUrl, token }` is reached, add the event fire. The full launch handler becomes:

```ts
    fastify.post('/:providerCode/games/:gameCode/launch', {
        preValidation: [fastify.authenticate],
        handler: async (req) => {
            const { providerCode, gameCode } = req.params as {
                providerCode: string
                gameCode: string
            }
            const user = (req as any).user as { id: string; username: string }
            const { language = 'en', platform = 'WEB' } =
                req.body as { language?: string; platform?: 'WEB' | 'H5' }

            const ipAddress =
                (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip

            const gateway = getGameProviderGateway(providerCode)
            const rawBase = process.env.WEB_BASE_URL || 'https://www.aradabingo.bet'
            const lobbyUrl = rawBase.startsWith('http') ? rawBase.replace(/\/$/, '') + '/' : `https://${rawBase.replace(/\/$/, '')}/`

            const gaseaUsername = user.id.replace(/-/g, '')

            const { gameUrl, token } = await gateway.getGameUrl({
                username: gaseaUsername,
                gameCode,
                language,
                platform,
                currency: process.env.GASEA_DEFAULT_CURRENCY ?? 'ETB',
                lobbyUrl,
                ipAddress,
            })

            if (token) {
                await redis.setex(`tp:token:${token}`, TOKEN_TTL, user.id)
            }

            // Fire analytics event non-blocking — never fail the launch
            Promise.all([
                prisma.wallet.findUnique({ where: { userId: user.id }, select: { realBalance: true } }),
            ]).then(([wallet]) => {
                EventService.record([{
                    name: 'provider_game_launched',
                    props: {
                        providerCode,
                        gameCode,
                        balanceBefore: wallet ? Number(wallet.realBalance) : null,
                    },
                }], { userId: user.id }).catch(() => {})
            }).catch(() => {})

            return { gameUrl, token }
        },
    })
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @world-bingo/api typecheck 2>&1 | grep -v minio | grep -i error | head -5
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/game-provider/index.ts
git commit -m "feat: emit provider_game_launched analytics event on game launch"
```

---

### Task 6: Frontend — provider game page instrumentation

**Files:**
- Modify: `apps/web/pages/play/[providerCode]/[gameCode].vue`

Add three tracking calls:
- `provider_game_view` — on mount, before the launch API call
- `provider_game_launched` — after `gameUrl.value` is set successfully (frontend signal, complements the backend event)
- `provider_session_ended` — on page visibility change to hidden and on beforeunload; captures session duration and approximate balance delta (stored from the `auth.balance` store value at session start and end, for the "broke" bucket heuristic only)

- [ ] **Step 1: Replace the full script section**

Replace the entire `<script setup lang="ts">` block with:

```ts
<script setup lang="ts">
import { useAuthStore } from '~/store/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const { track } = useAnalytics()

const providerCode = route.params.providerCode as string
const gameCode = route.params.gameCode as string

const gameUrl = ref<string | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

// Session tracking
const sessionStartedAt = ref<number | null>(null)
const balanceAtStart = ref<number | null>(null)

function fireSessionEnd() {
  if (!sessionStartedAt.value) return
  const durationSecs = Math.round((Date.now() - sessionStartedAt.value) / 1000)
  const currentBalance = typeof auth.user?.balance === 'number' ? auth.user.balance : null
  const balanceDelta = balanceAtStart.value != null && currentBalance != null
    ? Math.round((currentBalance - balanceAtStart.value) * 100) / 100
    : null
  track('provider_session_ended', { providerCode, gameCode, sessionDurationSecs: durationSecs, balanceDelta })
  sessionStartedAt.value = null
}

onMounted(async () => {
  if (!auth.isAuthenticated) {
    router.replace(`/auth/login?redirect=${encodeURIComponent(route.fullPath)}`)
    return
  }

  // Track that user viewed this game page
  track('provider_game_view', { providerCode, gameCode })

  try {
    const lobbyUrl = `${window.location.origin}/`
    const result = await auth.apiFetch<{ gameUrl: string; token: string }>(
      `/providers/${providerCode}/games/${gameCode}/launch`,
      {
        method: 'POST',
        body: { lobbyUrl, language: 'en', currency: 'ETB' },
      },
    )
    gameUrl.value = result.gameUrl
    sessionStartedAt.value = Date.now()
    balanceAtStart.value = typeof auth.user?.balance === 'number' ? auth.user.balance : null
  } catch (e: any) {
    error.value = e?.data?.message ?? e?.message ?? 'Failed to launch game'
  } finally {
    loading.value = false
  }

  // Session-end signals
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') fireSessionEnd()
  })
  window.addEventListener('beforeunload', fireSessionEnd)
})

onUnmounted(() => {
  fireSessionEnd()
})

useHead({
  title: `Playing ${gameCode}`,
})
</script>
```

- [ ] **Step 2: Verify the auth store exposes `auth.user?.balance`**

```bash
grep -n "balance\|user\b" apps/web/store/auth.ts | head -20
```

If `auth.user` doesn't have a `balance` field, replace `auth.user?.balance` with `null` (the `balanceDelta` will be null, which is safe — it only affects the broke-bucket heuristic):

```ts
const balanceAtStart = ref<number | null>(null)
// In onMounted, after launch success:
balanceAtStart.value = null  // set to null if no balance in store
// In fireSessionEnd:
const balanceDelta = null   // set to null if no balance tracking
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @world-bingo/web typecheck 2>&1 | grep -i error | head -10
```

Expected: no errors (or adjust `auth.user?.balance` access if needed).

- [ ] **Step 4: Commit**

```bash
git add "apps/web/pages/play/[providerCode]/[gameCode].vue"
git commit -m "feat: track provider_game_view, provider_game_launched, provider_session_ended"
```

---

### Task 7: End-to-end verification

- [ ] **Step 1: Run the full API test suite**

```bash
cd apps/api && pnpm test 2>&1 | tail -15
```

Expected: all tests pass including `game-retention.service.test.ts`.

- [ ] **Step 2: Typecheck all apps**

```bash
cd /Users/eyosiyasmekbib/Documents/Projects/world-bingo && pnpm typecheck 2>&1 | grep -v minio | grep -i error | head -20
```

Expected: no errors.

- [ ] **Step 3: Smoke test the API against dev stack**

```bash
pnpm infra:up
pnpm --filter @world-bingo/api dev &
sleep 8

TOKEN=$(curl -s -X POST http://localhost:8080/auth/admin/login \
  -H 'content-type: application/json' \
  -d '{"username":"kira","password":"password123"}' | jq -r .accessToken)

# Game retention scorecard
curl -s "http://localhost:8080/admin/analytics/game-retention" \
  -H "Authorization: Bearer $TOKEN" | jq '{baselineReturn7dPct, rowCount: (.rows | length)}'

# Provider browse funnel
curl -s "http://localhost:8080/admin/analytics/provider-browse-funnel" \
  -H "Authorization: Bearer $TOKEN" | jq '{hasEnoughData, stages: [.stages[].name]}'

# Event ingestion — provider_game_view (anonymous)
curl -s -X POST http://localhost:8080/events \
  -H 'content-type: application/json' \
  -d '{"events":[{"name":"provider_game_view","props":{"gameCode":"SLOT_001","providerCode":"gasea"}}],"anonId":"test-anon","sessionId":"sess-1"}' \
  -w "\n%{http_code}\n"
```

Expected:
- `game-retention` → `{ baselineReturn7dPct: 0, rowCount: 0 }` (fresh dev DB)
- `provider-browse-funnel` → `{ hasEnoughData: false, stages: ["viewed","launched","first_bet","returned_7d"] }`
- Event ingestion → `204`

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A && git commit -m "fix: game retention verification fixes" 2>/dev/null || echo "nothing to fix"
```
