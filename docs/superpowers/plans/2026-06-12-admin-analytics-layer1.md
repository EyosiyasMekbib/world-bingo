# Admin Analytics (Layer 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer "why aren't players playing more / converting" using only existing Postgres data, exposed as four admin API endpoints and a new Analytics page in the admin app.

**Architecture:** A new `AnalyticsService` runs raw SQL (`prisma.$queryRaw`) against existing tables (`users`, `transactions`, `game_entries`, `games`, `wallets`, `game_templates`). Pure shaping helpers (date-range parsing, retention matrix building) are static methods covered by unit tests; SQL methods are covered by mocked-prisma shaping tests plus a manual verification pass against the dev stack. New routes register under the existing admin-only Fastify sub-plugin at `/admin/analytics/*`. The admin app gets a `/analytics` page using the already-installed `chart.js` + `vue-chartjs`.

**Tech Stack:** Fastify v5, Prisma 5 (`$queryRaw` with `Prisma.sql`), Zod, Vitest, Nuxt 3, chart.js 4 + vue-chartjs 5.

---

## Domain context the engineer needs

- **Bots are real `User` rows** with `role = 'PLAYER'` and `username LIKE 'bot_t%'` (see `apps/api/src/services/bot.service.ts:93`). Every analytics query MUST exclude them: `(u."username" IS NULL OR u."username" NOT LIKE 'bot_t%')`. `username` is nullable (Telegram users), so the `IS NULL` clause is required.
- **Table names are snake_case** via `@@map`: `users`, `wallets`, `games`, `game_templates`, `game_entries`, `transactions`. Column names stay camelCase and need double quotes in SQL: `"createdAt"`, `"userId"`.
- **Postgres `count(*)` returns `bigint`** which Prisma maps to JS `BigInt`, which Fastify cannot JSON-serialize. Cast every count to `::int` in SQL. `avg()`/`sum()` return `numeric` → arrives as string or Decimal; wrap with `Number()` in the service.
- **Funnel stages** (per signup cohort): signed up → made ≥1 APPROVED DEPOSIT → entered ≥1 game → entered ≥2 distinct games. Stages are computed over the same cohort but are not forced subsets (a player can play on bonus without depositing); that is intentional and documented in the endpoint response.
- **Money/transaction semantics:** `TransactionType.DEPOSIT` + `PaymentStatus.APPROVED` = real deposit; `PRIZE_WIN` = player won a game.

## File structure

| File | Action | Responsibility |
|---|---|---|
| `apps/api/src/services/analytics.service.ts` | Create | All SQL queries + pure shaping helpers |
| `apps/api/src/test/analytics.service.test.ts` | Create | Unit tests for pure helpers + mocked-prisma shaping tests |
| `apps/api/src/routes/admin/analytics.ts` | Create | Fastify plugin: 4 GET endpoints, Zod query validation |
| `apps/api/src/routes/admin/index.ts` | Modify | Register analytics plugin inside admin-only block |
| `apps/admin/composables/useAdminApi.ts` | Modify | Typed client methods for the 4 endpoints |
| `apps/admin/pages/analytics.vue` | Create | Analytics page: funnel, retention matrix, game health charts, engagement |
| `apps/admin/layouts/default.vue` | Modify | Add "Analytics" nav item |

---

### Task 1: Pure helpers in AnalyticsService (TDD)

**Files:**
- Create: `apps/api/src/services/analytics.service.ts`
- Test: `apps/api/src/test/analytics.service.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/test/analytics.service.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { AnalyticsService } from '../services/analytics.service'

describe('AnalyticsService.parseRange', () => {
    it('defaults to last 30 days when no params given', () => {
        const now = new Date('2026-06-12T10:00:00Z')
        const { from, to } = AnalyticsService.parseRange(undefined, undefined, now)
        expect(to.getTime()).toBe(now.getTime())
        expect(from.getTime()).toBe(now.getTime() - 30 * 24 * 3600 * 1000)
    })

    it('parses explicit ISO dates', () => {
        const { from, to } = AnalyticsService.parseRange('2026-01-01', '2026-02-01')
        expect(from.toISOString()).toBe('2026-01-01T00:00:00.000Z')
        expect(to.toISOString()).toBe('2026-02-01T00:00:00.000Z')
    })

    it('throws when from is after to', () => {
        expect(() => AnalyticsService.parseRange('2026-02-01', '2026-01-01')).toThrow('from must be before to')
    })

    it('throws on invalid date strings', () => {
        expect(() => AnalyticsService.parseRange('not-a-date', undefined)).toThrow('Invalid date')
    })
})

describe('AnalyticsService.pct', () => {
    it('computes a rounded percentage', () => {
        expect(AnalyticsService.pct(1, 3)).toBe(33.3)
        expect(AnalyticsService.pct(2, 4)).toBe(50)
    })

    it('returns 0 when the denominator is 0', () => {
        expect(AnalyticsService.pct(5, 0)).toBe(0)
    })
})

describe('AnalyticsService.buildRetentionMatrix', () => {
    const sizes = [
        { cohort_week: new Date('2026-05-18T00:00:00Z'), size: 10 },
        { cohort_week: new Date('2026-05-25T00:00:00Z'), size: 4 },
    ]
    const activity = [
        { cohort_week: new Date('2026-05-18T00:00:00Z'), week_offset: 0, active_users: 6 },
        { cohort_week: new Date('2026-05-18T00:00:00Z'), week_offset: 1, active_users: 3 },
        { cohort_week: new Date('2026-05-25T00:00:00Z'), week_offset: 0, active_users: 4 },
    ]

    it('builds one row per cohort with pct per week offset', () => {
        const rows = AnalyticsService.buildRetentionMatrix(sizes, activity, 3)
        expect(rows).toEqual([
            { week: '2026-05-18', size: 10, offsets: [60, 30, 0] },
            { week: '2026-05-25', size: 4, offsets: [100, 0, 0] },
        ])
    })

    it('handles cohorts with zero activity', () => {
        const rows = AnalyticsService.buildRetentionMatrix(sizes, [], 2)
        expect(rows[0].offsets).toEqual([0, 0])
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @world-bingo/api test -- analytics`
Expected: FAIL — cannot resolve `../services/analytics.service`

- [ ] **Step 3: Implement the pure helpers**

Create `apps/api/src/services/analytics.service.ts`:

```ts
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
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @world-bingo/api test -- analytics`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/analytics.service.ts apps/api/src/test/analytics.service.test.ts
git commit -m "feat: analytics service pure helpers (range parsing, retention matrix)"
```

---

### Task 2: SQL query methods on AnalyticsService

**Files:**
- Modify: `apps/api/src/services/analytics.service.ts`
- Test: `apps/api/src/test/analytics.service.test.ts`

- [ ] **Step 1: Write the failing shaping tests (mocked prisma)**

Append to `apps/api/src/test/analytics.service.test.ts`. Add the mock at the very top of the file, before other imports take effect (vitest hoists `vi.mock`):

```ts
import { vi } from 'vitest'

vi.mock('../lib/prisma', () => ({
    default: { $queryRaw: vi.fn() },
}))
import prisma from '../lib/prisma'
const queryRaw = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>
```

Then append the test suites:

```ts
describe('AnalyticsService.getFunnel', () => {
    it('returns counts and conversion rates', async () => {
        queryRaw.mockResolvedValueOnce([
            { signups: 200, depositors: 80, players: 60, repeat_players: 30 },
        ])
        const out = await AnalyticsService.getFunnel(new Date('2026-05-01'), new Date('2026-06-01'))
        expect(out).toEqual({
            signups: 200,
            depositors: 80,
            players: 60,
            repeatPlayers: 30,
            rates: { signupToDeposit: 40, depositToPlay: 75, playToRepeat: 50 },
        })
    })
})

describe('AnalyticsService.getEngagement', () => {
    it('shapes distribution, activity, win-experience and idle money', async () => {
        queryRaw
            .mockResolvedValueOnce([{ one_game: 50, g2_5: 30, g6_20: 15, g20_plus: 5, active_7d: 20, total_players: 100 }])
            .mockResolvedValueOnce([{ winners_total: 40, winners_active_7d: 20, losers_total: 30, losers_active_7d: 3 }])
            .mockResolvedValueOnce([{ idle_wallets: 12, idle_balance: '340.50' }])
        const out = await AnalyticsService.getEngagement()
        expect(out.oneAndDonePct).toBe(50)
        expect(out.distribution).toEqual({ '1': 50, '2-5': 30, '6-20': 15, '20+': 5 })
        expect(out.winExperience).toEqual({
            winners: { total: 40, active7dPct: 50 },
            neverWon: { total: 30, active7dPct: 10 },
        })
        expect(out.idleMoney).toEqual({ wallets: 12, balance: 340.5 })
    })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm --filter @world-bingo/api test -- analytics`
Expected: FAIL — `getFunnel is not a function` (Task 1 tests still PASS; the prisma mock does not affect pure helpers)

- [ ] **Step 3: Implement the four query methods**

Append to the `AnalyticsService` class in `apps/api/src/services/analytics.service.ts`:

```ts
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
        // Win experience: among players with >= 3 games, compare 7-day activity of
        // those who have ever won a prize vs those who never have.
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
        // Idle money: wallets holding at least one ticket's worth of balance with no entry in 7 days.
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
        const d = dist[0]
        const w = winExp[0]
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
                wallets: idle[0].idle_wallets,
                balance: Number(idle[0].idle_balance ?? 0),
            },
        }
    }
```

- [ ] **Step 4: Run all analytics tests**

Run: `pnpm --filter @world-bingo/api test -- analytics`
Expected: PASS (10 tests)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @world-bingo/api typecheck`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/analytics.service.ts apps/api/src/test/analytics.service.test.ts
git commit -m "feat: analytics SQL queries (funnel, retention, games health, engagement)"
```

---

### Task 3: Admin analytics routes

**Files:**
- Create: `apps/api/src/routes/admin/analytics.ts`
- Modify: `apps/api/src/routes/admin/index.ts` (admin-only block, after line 141)

- [ ] **Step 1: Create the route plugin**

Create `apps/api/src/routes/admin/analytics.ts`:

```ts
import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { AnalyticsService } from '../../services/analytics.service'

const rangeQuerySchema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
})

const retentionQuerySchema = z.object({
    weeks: z.coerce.number().int().min(2).max(26).default(8),
})

// Registered inside the requireAdmin sub-plugin in ./index.ts — no extra auth here.
const analyticsRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/funnel', async (req: any, reply) => {
        const parsed = rangeQuerySchema.safeParse(req.query)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', details: parsed.error.issues })
        try {
            const { from, to } = AnalyticsService.parseRange(parsed.data.from, parsed.data.to)
            return await AnalyticsService.getFunnel(from, to)
        } catch (err: any) {
            return reply.status(400).send({ error: err.message })
        }
    })

    fastify.get('/retention', async (req: any, reply) => {
        const parsed = retentionQuerySchema.safeParse(req.query)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', details: parsed.error.issues })
        return AnalyticsService.getRetention(parsed.data.weeks)
    })

    fastify.get('/games-health', async (req: any, reply) => {
        const parsed = rangeQuerySchema.safeParse(req.query)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid query', details: parsed.error.issues })
        try {
            const { from, to } = AnalyticsService.parseRange(parsed.data.from, parsed.data.to)
            return await AnalyticsService.getGamesHealth(from, to)
        } catch (err: any) {
            return reply.status(400).send({ error: err.message })
        }
    })

    fastify.get('/engagement', async (_req, _reply) => {
        return AnalyticsService.getEngagement()
    })
}

export default analyticsRoutes
```

- [ ] **Step 2: Register the plugin in the admin-only block**

In `apps/api/src/routes/admin/index.ts`, add the import at the top with the other imports:

```ts
import analyticsRoutes from './analytics'
```

Inside the admin-only sub-plugin (the block starting `await fastify.register(async (f) => { f.addHook('preValidation', f.requireAdmin)` at line 140), add directly after the `preValidation` hook line:

```ts
        // ── Analytics ─────────────────────────────────────────────────────────
        await f.register(analyticsRoutes, { prefix: '/analytics' })
```

- [ ] **Step 3: Typecheck and run full API test suite**

Run: `pnpm --filter @world-bingo/api typecheck && pnpm --filter @world-bingo/api test`
Expected: typecheck exit 0, all tests PASS

- [ ] **Step 4: Smoke-test against the dev stack**

```bash
pnpm infra:up
pnpm --filter @world-bingo/api dev &
sleep 8
# Seeded super-admin from apps/api/prisma/seed.ts: kira / password123
TOKEN=$(curl -s -X POST http://localhost:8080/auth/admin/login -H 'content-type: application/json' \
  -d '{"username":"kira","password":"password123"}' | jq -r .accessToken)
curl -s http://localhost:8080/admin/analytics/funnel -H "Authorization: Bearer $TOKEN" | jq
curl -s http://localhost:8080/admin/analytics/retention -H "Authorization: Bearer $TOKEN" | jq
curl -s "http://localhost:8080/admin/analytics/games-health" -H "Authorization: Bearer $TOKEN" | jq
curl -s http://localhost:8080/admin/analytics/engagement -H "Authorization: Bearer $TOKEN" | jq
```

Expected: four JSON payloads, no 500s, no BigInt serialization errors. If the auth route shape differs, check `apps/api/src/routes/auth/` for the actual login path and request body.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin/analytics.ts apps/api/src/routes/admin/index.ts
git commit -m "feat: admin analytics endpoints (funnel, retention, games-health, engagement)"
```

---

### Task 4: Admin API client methods

**Files:**
- Modify: `apps/admin/composables/useAdminApi.ts`

- [ ] **Step 1: Add typed client methods**

In `apps/admin/composables/useAdminApi.ts`, add inside the returned object (after the `getStats` entry):

```ts
        // ── Analytics ─────────────────────────────────────────────────────
        getAnalyticsFunnel: (params?: { from?: string; to?: string }) => {
            const qs = new URLSearchParams()
            if (params?.from) qs.set('from', params.from)
            if (params?.to) qs.set('to', params.to)
            const query = qs.toString()
            return apiFetch<{
                signups: number
                depositors: number
                players: number
                repeatPlayers: number
                rates: { signupToDeposit: number; depositToPlay: number; playToRepeat: number }
            }>(`/admin/analytics/funnel${query ? `?${query}` : ''}`)
        },
        getAnalyticsRetention: (weeks?: number) =>
            apiFetch<{ cohorts: Array<{ week: string; size: number; offsets: number[] }> }>(
                `/admin/analytics/retention${weeks ? `?weeks=${weeks}` : ''}`,
            ),
        getAnalyticsGamesHealth: (params?: { from?: string; to?: string }) => {
            const qs = new URLSearchParams()
            if (params?.from) qs.set('from', params.from)
            if (params?.to) qs.set('to', params.to)
            const query = qs.toString()
            return apiFetch<{
                daily: Array<{ day: string; created: number; completed: number; cancelled: number; cancellationPct: number; avgSecsToStart: number | null }>
                fill: { avgHumanFillPct: number; botSharePct: number }
            }>(`/admin/analytics/games-health${query ? `?${query}` : ''}`)
        },
        getAnalyticsEngagement: () =>
            apiFetch<{
                totalPlayers: number
                active7d: number
                oneAndDonePct: number
                distribution: Record<string, number>
                winExperience: {
                    winners: { total: number; active7dPct: number }
                    neverWon: { total: number; active7dPct: number }
                }
                idleMoney: { wallets: number; balance: number }
            }>('/admin/analytics/engagement'),
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @world-bingo/admin typecheck`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add apps/admin/composables/useAdminApi.ts
git commit -m "feat: admin api client methods for analytics endpoints"
```

---

### Task 5: Analytics page

**Files:**
- Create: `apps/admin/pages/analytics.vue`

Follows existing admin styling conventions: CSS variables (`--surface-raised`, `--surface-border`, `--text-primary`, `--text-muted`, `--brand-primary`), card-based layout like `pages/index.vue`. Charts use the already-installed `chart.js` + `vue-chartjs`.

- [ ] **Step 1: Create the page**

Create `apps/admin/pages/analytics.vue`:

```vue
<script setup lang="ts">
import { Line, Bar } from 'vue-chartjs'
import {
  Chart, CategoryScale, LinearScale, PointElement, LineElement, BarElement,
  Tooltip, Legend, Filler,
} from 'chart.js'

Chart.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler)

const api = useAdminApi()

const rangeDays = ref(30)
const rangeOptions = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
]

const loading = ref(true)
const error = ref<string | null>(null)
const funnel = ref<Awaited<ReturnType<typeof api.getAnalyticsFunnel>> | null>(null)
const retention = ref<Awaited<ReturnType<typeof api.getAnalyticsRetention>> | null>(null)
const gamesHealth = ref<Awaited<ReturnType<typeof api.getAnalyticsGamesHealth>> | null>(null)
const engagement = ref<Awaited<ReturnType<typeof api.getAnalyticsEngagement>> | null>(null)

async function load() {
  loading.value = true
  error.value = null
  const from = new Date(Date.now() - rangeDays.value * 24 * 3600 * 1000).toISOString()
  try {
    const [f, r, g, e] = await Promise.all([
      api.getAnalyticsFunnel({ from }),
      api.getAnalyticsRetention(8),
      api.getAnalyticsGamesHealth({ from }),
      api.getAnalyticsEngagement(),
    ])
    funnel.value = f
    retention.value = r
    gamesHealth.value = g
    engagement.value = e
  } catch (err: any) {
    error.value = err?.data?.error ?? err?.message ?? 'Failed to load analytics'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(rangeDays, load)

const funnelStages = computed(() => {
  if (!funnel.value) return []
  const f = funnel.value
  const max = Math.max(f.signups, 1)
  return [
    { label: 'Signed up', count: f.signups, pct: 100, width: 100 },
    { label: 'Deposited', count: f.depositors, pct: f.rates.signupToDeposit, width: (f.depositors / max) * 100 },
    { label: 'Played a game', count: f.players, pct: f.rates.depositToPlay, width: (f.players / max) * 100 },
    { label: 'Played again', count: f.repeatPlayers, pct: f.rates.playToRepeat, width: (f.repeatPlayers / max) * 100 },
  ]
})

const gamesChartData = computed(() => ({
  labels: gamesHealth.value?.daily.map(d => d.day) ?? [],
  datasets: [
    {
      label: 'Completed',
      data: gamesHealth.value?.daily.map(d => d.completed) ?? [],
      borderColor: '#34d399',
      backgroundColor: 'rgba(52, 211, 153, 0.12)',
      fill: true,
      tension: 0.3,
    },
    {
      label: 'Cancelled',
      data: gamesHealth.value?.daily.map(d => d.cancelled) ?? [],
      borderColor: '#f87171',
      backgroundColor: 'rgba(248, 113, 113, 0.12)',
      fill: true,
      tension: 0.3,
    },
  ],
}))

const distributionChartData = computed(() => ({
  labels: Object.keys(engagement.value?.distribution ?? {}),
  datasets: [{
    label: 'Players',
    data: Object.values(engagement.value?.distribution ?? {}),
    backgroundColor: 'rgba(245, 158, 11, 0.6)',
    borderColor: '#f59e0b',
    borderWidth: 1,
  }],
}))

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { labels: { color: 'rgba(255,255,255,0.7)' } } },
  scales: {
    x: { ticks: { color: 'rgba(255,255,255,0.5)' }, grid: { color: 'rgba(255,255,255,0.06)' } },
    y: { ticks: { color: 'rgba(255,255,255,0.5)' }, grid: { color: 'rgba(255,255,255,0.06)' }, beginAtZero: true },
  },
}

function retentionCellStyle(pct: number) {
  return { background: `rgba(245, 158, 11, ${Math.min(pct / 100, 1) * 0.75})` }
}
</script>

<template>
  <div class="analytics-page">
    <div class="page-head">
      <div>
        <h1 class="page-title">Analytics</h1>
        <p class="page-sub">Conversion funnel, retention and game health — bots excluded</p>
      </div>
      <USelectMenu v-model="rangeDays" :options="rangeOptions" value-attribute="value" option-attribute="label" class="w-32" />
    </div>

    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-else-if="loading" class="loading-state">Loading analytics…</div>

    <template v-else>
      <!-- ── Funnel ──────────────────────────────────────────────── -->
      <section class="card">
        <h2 class="card-title">Conversion funnel <span class="card-hint">signups in last {{ rangeDays }} days</span></h2>
        <div class="funnel">
          <div v-for="stage in funnelStages" :key="stage.label" class="funnel-row">
            <span class="funnel-label">{{ stage.label }}</span>
            <div class="funnel-track">
              <div class="funnel-bar" :style="{ width: stage.width + '%' }" />
            </div>
            <span class="funnel-count">{{ stage.count }}</span>
            <span class="funnel-pct">{{ stage.pct }}%</span>
          </div>
        </div>
      </section>

      <!-- ── KPI cards ───────────────────────────────────────────── -->
      <div class="kpi-grid" v-if="engagement && gamesHealth">
        <div class="card kpi">
          <span class="kpi-value">{{ engagement.oneAndDonePct }}%</span>
          <span class="kpi-label">One-and-done players</span>
        </div>
        <div class="card kpi">
          <span class="kpi-value">{{ engagement.active7d }} / {{ engagement.totalPlayers }}</span>
          <span class="kpi-label">Players active last 7 days</span>
        </div>
        <div class="card kpi">
          <span class="kpi-value">{{ gamesHealth.fill.avgHumanFillPct }}%</span>
          <span class="kpi-label">Avg human fill (completed games)</span>
        </div>
        <div class="card kpi">
          <span class="kpi-value">{{ engagement.idleMoney.wallets }} · {{ engagement.idleMoney.balance.toFixed(0) }} ETB</span>
          <span class="kpi-label">Idle wallets (can afford a ticket, 7d inactive)</span>
        </div>
      </div>

      <!-- ── Win experience ──────────────────────────────────────── -->
      <section class="card" v-if="engagement">
        <h2 class="card-title">Win experience vs retention <span class="card-hint">players with ≥3 games</span></h2>
        <div class="winexp-grid">
          <div class="winexp-cell">
            <span class="winexp-num">{{ engagement.winExperience.winners.active7dPct }}%</span>
            <span class="winexp-label">of {{ engagement.winExperience.winners.total }} winners still active (7d)</span>
          </div>
          <div class="winexp-cell">
            <span class="winexp-num winexp-num--bad">{{ engagement.winExperience.neverWon.active7dPct }}%</span>
            <span class="winexp-label">of {{ engagement.winExperience.neverWon.total }} never-won players still active (7d)</span>
          </div>
        </div>
      </section>

      <!-- ── Games health chart ──────────────────────────────────── -->
      <section class="card">
        <h2 class="card-title">Game supply &amp; cancellations <span class="card-hint">bot share of entries: {{ gamesHealth?.fill.botSharePct }}%</span></h2>
        <div class="chart-box">
          <Line :data="gamesChartData" :options="chartOptions" />
        </div>
      </section>

      <!-- ── Engagement distribution ─────────────────────────────── -->
      <section class="card">
        <h2 class="card-title">Games played per player <span class="card-hint">all time</span></h2>
        <div class="chart-box">
          <Bar :data="distributionChartData" :options="chartOptions" />
        </div>
      </section>

      <!-- ── Retention matrix ────────────────────────────────────── -->
      <section class="card" v-if="retention">
        <h2 class="card-title">Weekly retention cohorts <span class="card-hint">% of signup cohort playing in week N</span></h2>
        <div class="retention-scroll">
          <table class="retention-table">
            <thead>
              <tr>
                <th>Cohort</th>
                <th>Size</th>
                <th v-for="(_, i) in retention.cohorts[0]?.offsets ?? []" :key="i">W{{ i }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in retention.cohorts" :key="c.week">
                <td class="retention-week">{{ c.week }}</td>
                <td class="retention-size">{{ c.size }}</td>
                <td v-for="(pct, i) in c.offsets" :key="i" class="retention-cell" :style="retentionCellStyle(pct)">
                  {{ pct > 0 ? pct + '%' : '·' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.analytics-page { display: flex; flex-direction: column; gap: 20px; max-width: 1100px; }

.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.page-title { font-size: 22px; font-weight: 700; color: var(--text-primary); }
.page-sub { font-size: 13px; color: var(--text-muted); margin-top: 2px; }

.error-banner {
  padding: 12px 16px; border-radius: 8px; font-size: 13px;
  background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); color: #f87171;
}
.loading-state { padding: 40px; text-align: center; color: var(--text-muted); font-size: 14px; }

.card {
  background: var(--surface-raised); border: 1px solid var(--surface-border);
  border-radius: 10px; padding: 18px 20px;
}
.card-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 14px; }
.card-hint { font-size: 11px; font-weight: 500; color: var(--text-muted); margin-left: 8px; }

/* Funnel */
.funnel { display: flex; flex-direction: column; gap: 10px; }
.funnel-row { display: grid; grid-template-columns: 110px 1fr 64px 52px; align-items: center; gap: 12px; }
.funnel-label { font-size: 12px; color: var(--text-secondary); }
.funnel-track { height: 22px; background: rgba(255,255,255,0.04); border-radius: 4px; overflow: hidden; }
.funnel-bar { height: 100%; background: var(--brand-primary); border-radius: 4px; transition: width 0.4s ease; min-width: 2px; }
.funnel-count { font-size: 13px; font-weight: 600; color: var(--text-primary); text-align: right; }
.funnel-pct { font-size: 11px; color: var(--text-muted); text-align: right; }

/* KPIs */
.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.kpi { display: flex; flex-direction: column; gap: 4px; }
.kpi-value { font-size: 20px; font-weight: 700; color: var(--text-primary); }
.kpi-label { font-size: 11px; color: var(--text-muted); }

/* Win experience */
.winexp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.winexp-cell { display: flex; flex-direction: column; gap: 4px; padding: 10px 0; }
.winexp-num { font-size: 24px; font-weight: 700; color: #34d399; }
.winexp-num--bad { color: #f87171; }
.winexp-label { font-size: 12px; color: var(--text-muted); }

/* Charts */
.chart-box { height: 260px; position: relative; }

/* Retention */
.retention-scroll { overflow-x: auto; }
.retention-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.retention-table th {
  text-align: left; padding: 6px 8px; font-size: 10px; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-muted); border-bottom: 1px solid var(--surface-border);
}
.retention-table td { padding: 6px 8px; }
.retention-week { color: var(--text-secondary); white-space: nowrap; }
.retention-size { color: var(--text-muted); }
.retention-cell { text-align: center; border-radius: 3px; color: var(--text-primary); min-width: 48px; }
</style>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @world-bingo/admin typecheck`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add apps/admin/pages/analytics.vue
git commit -m "feat: admin analytics page (funnel, retention, game health, engagement)"
```

---

### Task 6: Navigation link

**Files:**
- Modify: `apps/admin/layouts/default.vue:11`

- [ ] **Step 1: Add nav item**

In `apps/admin/layouts/default.vue`, in the first nav group (the one containing the Dashboard item), add an Analytics entry after the Dashboard line:

```ts
  {
    label: null,
    adminOnly: true,
    items: [
      { label: 'Dashboard', icon: 'i-heroicons:squares-2x2', to: '/' },
      { label: 'Analytics', icon: 'i-heroicons:chart-bar', to: '/analytics' },
    ],
  },
```

- [ ] **Step 2: Commit**

```bash
git add apps/admin/layouts/default.vue
git commit -m "feat: analytics nav link in admin sidebar"
```

---

### Task 7: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the stack**

```bash
pnpm infra:up
pnpm --filter @world-bingo/api dev &
pnpm --filter @world-bingo/admin dev &
```

- [ ] **Step 2: Verify in browser**

Open http://localhost:3001/analytics, log in as admin. Confirm:
- Funnel bars render with counts and percentages
- KPI cards show numbers (zeros are fine on an empty dev DB — but no errors)
- Game supply chart and distribution chart render
- Retention table renders with W0..W7 columns
- Switching the range select (7/30/90 days) reloads data
- Log in as a CLERK → `/analytics` nav item is hidden and the API returns 403 for `/admin/analytics/*`

- [ ] **Step 3: Full quality gate**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass.

- [ ] **Step 4: Final commit if anything was fixed during verification**

```bash
git add -A && git commit -m "fix: analytics verification fixes"
```

---

## Explicitly out of scope (Layer 2)

- Behavioral events (lobby views, abandoned deposits, cartela selection drop-off) — requires event instrumentation (PostHog), not in DB today.
- `entry_failed: insufficient_balance` tracking — no such record exists in the schema; needs new event capture.
- Real-time analytics / caching — queries run on demand; if they get slow on production data volumes, add Redis caching with a 5-minute TTL as a follow-up.
