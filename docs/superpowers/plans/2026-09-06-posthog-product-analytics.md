# PostHog Product Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PostHog Cloud (EU) product analytics beside the existing custom pipeline: browser events plus session replay from `apps/web`, server-authoritative money and game events from `apps/api`, and a re-runnable backfill of existing Postgres history.

**Architecture:** `apps/web` gets an env-gated `posthog-js` plugin and the existing `useAnalytics().track()` becomes a dual-sink adapter (PostHog + the existing `/events` endpoint). `apps/api` gets `lib/posthog.ts` (env-gated `posthog-node` client, mirrors `lib/sentry.ts`) and `lib/posthog-events.ts` (typed emitters), called post-commit from the services that own money and game outcomes. A CLI script maps existing rows to historical events with deterministic UUIDs.

**Tech Stack:** Nuxt 3, Pinia, `posthog-js@^1.427`, Fastify v5, Prisma 5, `posthog-node@^5.51`, Vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-09-06-posthog-product-analytics-design.md`

## Global Constraints

- Every PostHog integration is **env-gated and a no-op when unset**: empty `NUXT_PUBLIC_POSTHOG_KEY` / `POSTHOG_KEY` means nothing initialises and every helper returns without doing anything.
- Server helpers **never throw** and are **never awaited on a request path**: call as `void captureEvent(...)`.
- Server events are emitted **post-commit**, after the Prisma `$transaction` resolves. Never inside a `$transaction` callback.
- `distinct_id` is the user UUID (`users.id`). **Forbidden as event or person properties:** phone, username, firstName, lastName, telegramUsername, passwordHash, senderName, senderAccount, accountNumber, receiptUrl, note text.
- Bots (`username` starts with `bot_t`, or `passwordHash = 'BOT_ACCOUNT'`) and staff (`role != 'PLAYER'`) are dropped at emit time and at the backfill source.
- Event names and property keys are `snake_case`. Money is a plain number in ETB.
- Formatting: Prettier `singleQuote`, no semicolons, `trailingComma: all`. Match each file's existing indentation (API services use 4 spaces; `apps/web/store/auth.ts` and `apps/web/plugins/*` use 2 spaces; `apps/web/composables/useAnalytics.ts` uses 4).
- Import style in `apps/api`: relative imports without a `.js` suffix (the majority form in the files this plan touches).
- Test commands: API `pnpm --filter @world-bingo/api exec vitest run src/test/<file>.test.ts` (needs the local Postgres on 5432 and `DATABASE_URL_TEST` in the root `.env`; both are present). Web `pnpm --filter @world-bingo/web exec vitest run <path>`.
- The API suite has known environmental failures in unrelated files. Judge a task by the files it names, not the suite's exit code.
- Commit after every task with a Conventional Commit subject, no attribution trailers.
- Work on branch `feat/posthog-analytics` (already created, spec committed).

---

## File map

| File | Action | Task |
|---|---|---|
| `apps/api/package.json` | modify: add `posthog-node`, `posthog:backfill` script | 1, 9 |
| `apps/api/src/lib/posthog.ts` | create: env-gated client, bot/staff cache, `captureEvent`, `shutdownPostHog` | 1 |
| `apps/api/src/test/posthog.test.ts` | create | 1 |
| `apps/api/src/index.ts` | modify: init after Sentry, shutdown after queues | 1 |
| `apps/api/.env.example` | modify: `POSTHOG_*` | 1 |
| `apps/api/src/lib/posthog-events.ts` | create: pure helpers + emitters | 2 |
| `apps/api/src/test/posthog-events.test.ts` | create | 2 |
| `apps/api/src/services/auth.service.ts` | modify: `user_registered`, `user_logged_in` | 3 |
| `apps/api/src/test/posthog-auth-hooks.test.ts` | create | 3 |
| `apps/api/src/services/wallet.service.ts` | modify: deposit + withdrawal + bonus events | 4 |
| `apps/api/src/services/zarecash-checkout.service.ts` | modify: `deposit_submitted` | 4 |
| `apps/api/src/services/admin.service.ts` | modify: `deposit_rejected`, `withdrawal_approved` | 4 |
| `apps/api/src/services/zarecash.service.ts` | modify: `withdrawal_approved` on settle | 4 |
| `apps/api/src/test/posthog-wallet-hooks.test.ts` | create | 4 |
| `apps/api/src/services/game.service.ts` | modify: join / leave / finished / refunded | 5 |
| `apps/api/src/lib/game-engine.ts` | modify: `game_finished` no-winner path | 5 |
| `apps/api/src/test/posthog-game-hooks.test.ts` | create | 5 |
| `apps/api/src/services/player-crm/campaign.service.ts` | modify: `bonus_granted` | 6 |
| `apps/api/src/services/cashback.service.ts` | modify: `bonus_granted` | 6 |
| `apps/api/src/routes/admin/index.ts` | modify: `bonus_granted` | 6 |
| `apps/api/src/services/account-status.service.ts` | modify: `account_status_changed` | 6 |
| `apps/api/src/routes/game-provider/index.ts` | modify: `provider_game_launched` | 6 |
| `apps/api/src/test/posthog-status-hook.test.ts` | create | 6 |
| `apps/web/package.json` | modify: add `posthog-js` | 7 |
| `apps/web/utils/posthog.ts` | create: pure helpers | 7 |
| `apps/web/utils/posthog.test.ts` | create | 7 |
| `apps/web/plugins/02.posthog.client.ts` | create | 7 |
| `apps/web/nuxt.config.ts` | modify: runtime config + `/ingest` proxy rules | 7 |
| `apps/web/Dockerfile` | modify: optional proxy build args | 7 |
| `apps/web/.env.example` | modify | 7 |
| `apps/web/composables/useAnalytics.ts` | modify: adapter, `identify(user)`, `reset()` | 8 |
| `apps/web/composables/useAnalytics.test.ts` | create | 8 |
| `apps/web/store/auth.ts` | modify: call `identify` / `reset` | 8 |
| `apps/web/pages/profile.vue` | modify: `data-ph-mask` | 8 |
| `apps/api/src/services/event.service.ts` | modify: `games_lobby_view` | 8 |
| `apps/api/src/lib/posthog-backfill.ts` | create: pure row → event mappers | 9 |
| `apps/api/src/test/posthog-backfill.test.ts` | create | 9 |
| `apps/api/scripts/posthog-backfill.ts` | create: CLI | 9 |
| `docker-compose.yml`, `docker-compose.prod.yml`, `docker-compose.aradabingo.yml`, `docker-compose.betbawa.yml`, `docker-compose.aradabingo.staging.yml`, `docker-compose.betbawa.staging.yml` | modify: env passthrough | 10 |
| `.env.example` (root) | modify | 10 |
| `docs/posthog.md` | create: runbook | 10 |
| `CLAUDE.md` | modify: one line | 10 |

---

### Task 1: API PostHog client (`lib/posthog.ts`)

**Files:**
- Modify: `apps/api/package.json` (dependencies)
- Create: `apps/api/src/lib/posthog.ts`
- Create: `apps/api/src/test/posthog.test.ts`
- Modify: `apps/api/src/index.ts:1-5` and the `shutdown` function at `apps/api/src/index.ts:375-388`
- Modify: `apps/api/.env.example` (after the `LOKI_LABEL_APP` line)

**Interfaces:**
- Produces:
  - `initPostHog(): void`
  - `captureEvent(userId: string, event: string, properties?: Record<string, unknown>, opts?: { set?: Record<string, unknown>; timestamp?: Date }): Promise<void>` — never rejects.
  - `isExcludedUser(row: { username: string | null; passwordHash: string | null; role: string } | null): boolean`
  - `isPostHogEnabled(): boolean`
  - `shutdownPostHog(): Promise<void>`
  - `_setClientForTests(fake: PostHogClientLike | null, brand?: string): void`
  - `interface PostHogClientLike { capture(msg): void; shutdown(): Promise<void> }`

- [ ] **Step 1: Install the dependency**

Run from the repo root:

```bash
pnpm --filter @world-bingo/api add posthog-node@^5.51.6
```

Expected: `apps/api/package.json` gains `"posthog-node": "^5.51.6"` under `dependencies`; lockfile updated. (Local Node is 25.9, which satisfies the package's `>=22.22.0` engine floor.)

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/test/posthog.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }))
vi.mock('../lib/prisma', () => ({ default: { user: { findUnique } } }))
vi.mock('../lib/logger', () => ({ rootLogger: { info: vi.fn(), warn: vi.fn() } }))

import {
    captureEvent,
    initPostHog,
    isExcludedUser,
    isPostHogEnabled,
    _setClientForTests,
} from '../lib/posthog'

const player = { username: 'alice', passwordHash: 'hashed', role: 'PLAYER' }

describe('isExcludedUser', () => {
    it('keeps a plain player', () => {
        expect(isExcludedUser(player)).toBe(false)
    })
    it('drops bot_t usernames', () => {
        expect(isExcludedUser({ ...player, username: 'bot_t1_3' })).toBe(true)
    })
    it('drops BOT_ACCOUNT password hashes', () => {
        expect(isExcludedUser({ ...player, passwordHash: 'BOT_ACCOUNT' })).toBe(true)
    })
    it('drops staff roles', () => {
        expect(isExcludedUser({ ...player, role: 'ADMIN' })).toBe(true)
    })
    it('drops a missing row', () => {
        expect(isExcludedUser(null)).toBe(true)
    })
})

describe('captureEvent', () => {
    const capture = vi.fn()
    const shutdown = vi.fn().mockResolvedValue(undefined)

    beforeEach(() => {
        vi.clearAllMocks()
        findUnique.mockResolvedValue(player)
    })

    it('is a no-op when no client is installed', async () => {
        _setClientForTests(null)
        await captureEvent('u1', 'game_joined', { game_id: 'g1' })
        expect(findUnique).not.toHaveBeenCalled()
        expect(capture).not.toHaveBeenCalled()
    })

    it('forwards to the client with brand and $set person props', async () => {
        _setClientForTests({ capture, shutdown }, 'arada')
        await captureEvent('u1', 'user_registered', { signup_method: 'phone' }, { set: { serial: 7 } })
        expect(capture).toHaveBeenCalledWith({
            distinctId: 'u1',
            event: 'user_registered',
            properties: {
                signup_method: 'phone',
                brand: 'arada',
                $set: { serial: 7, brand: 'arada' },
            },
        })
    })

    it('passes a historical timestamp through', async () => {
        _setClientForTests({ capture, shutdown }, 'arada')
        const ts = new Date('2026-03-01T00:00:00Z')
        await captureEvent('u1', 'game_joined', {}, { timestamp: ts })
        expect(capture.mock.calls[0][0].timestamp).toBe(ts)
    })

    it('drops bots and caches the lookup', async () => {
        _setClientForTests({ capture, shutdown })
        findUnique.mockResolvedValue({ ...player, username: 'bot_t2_1' })
        await captureEvent('bot1', 'game_joined')
        await captureEvent('bot1', 'game_joined')
        expect(capture).not.toHaveBeenCalled()
        expect(findUnique).toHaveBeenCalledTimes(1)
    })

    it('never rejects when the client throws', async () => {
        _setClientForTests({
            capture: () => {
                throw new Error('boom')
            },
            shutdown,
        })
        await expect(captureEvent('u1', 'game_joined')).resolves.toBeUndefined()
    })

    it('never rejects when the user lookup throws', async () => {
        _setClientForTests({ capture, shutdown })
        findUnique.mockRejectedValue(new Error('db down'))
        await expect(captureEvent('u1', 'game_joined')).resolves.toBeUndefined()
        expect(capture).not.toHaveBeenCalled()
    })
})

describe('initPostHog', () => {
    it('stays disabled without POSTHOG_KEY', () => {
        _setClientForTests(null)
        const saved = process.env.POSTHOG_KEY
        delete process.env.POSTHOG_KEY
        initPostHog()
        expect(isPostHogEnabled()).toBe(false)
        if (saved !== undefined) process.env.POSTHOG_KEY = saved
    })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/posthog.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/posthog"`.

- [ ] **Step 4: Write the client module**

Create `apps/api/src/lib/posthog.ts`:

```ts
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
    instance.on('error', (err: unknown) => {
        rootLogger.warn({ err }, '[posthog] client error')
    })
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/posthog.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Wire boot and shutdown**

In `apps/api/src/index.ts`, change the top of the file from:

```ts
import { initSentry, Sentry, reportError } from './lib/sentry.js'
```

to:

```ts
import { initSentry, Sentry, reportError } from './lib/sentry.js'
import { initPostHog, shutdownPostHog } from './lib/posthog'
```

and directly after the existing `initSentry()` call (line 5) add:

```ts
initPostHog()
```

In the `shutdown` function, change:

```ts
    await closeAllQueues().catch(() => { })
    await prisma.$disconnect().catch(() => { })
```

to:

```ts
    await closeAllQueues().catch(() => { })
    await shutdownPostHog()
    await prisma.$disconnect().catch(() => { })
```

- [ ] **Step 7: Document the env vars**

In `apps/api/.env.example`, after the line `LOKI_LABEL_APP=world-bingo-api` add:

```bash

# Product analytics (PostHog Cloud). Empty POSTHOG_KEY → every capture is a no-op.
# Server-side events only (money and game outcomes); the browser SDK lives in
# apps/web. See docs/posthog.md.
POSTHOG_KEY=
POSTHOG_HOST=https://eu.i.posthog.com
# Stamped on every event as `brand`. Falls back to DEPLOYMENT_CODE, then ''.
POSTHOG_BRAND=
```

- [ ] **Step 8: Typecheck the API**

Run: `pnpm --filter @world-bingo/api typecheck`
Expected: no errors mentioning `posthog.ts` or `index.ts`. (If `instance.on` is reported as missing on the `PostHog` type, replace that call with `;(instance as unknown as { on?: (e: string, cb: (err: unknown) => void) => void }).on?.('error', ...)` — the runtime method exists.)

- [ ] **Step 9: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/lib/posthog.ts apps/api/src/test/posthog.test.ts apps/api/src/index.ts apps/api/.env.example
git commit -m "feat(posthog): env-gated server client with bot and staff exclusion"
```

---

### Task 2: Typed emitters (`lib/posthog-events.ts`)

**Files:**
- Create: `apps/api/src/lib/posthog-events.ts`
- Create: `apps/api/src/test/posthog-events.test.ts`

**Interfaces:**
- Consumes: `captureEvent` from Task 1.
- Produces:
  - `hoursBetween(from: Date, to: Date): number` — 2 dp, never negative.
  - `withdrawalMethodFromNote(note: string | null | undefined): string | null` — parses the `"<method>: <account>"` note written by `requestWithdrawal`; never returns the account.
  - `personPropsFor(user: { serial: number; createdAt: Date; referredById: string | null }, signupMethod: 'phone' | 'telegram'): Record<string, unknown>`
  - `gameOutcomeEvents(input: GameOutcomeInput): Array<{ userId: string; properties: Record<string, unknown> }>` (pure fan-out)
  - `emitDepositApproved(transactionId: string, now?: Date): Promise<void>`
  - `emitGameFinished(gameId: string): Promise<void>`
  - `emitGameRefunded(gameId: string, templateId: string | null, refunds: Array<{ userId: string; amount: number; alreadyRefunded: boolean }>, reason: string): void`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/test/posthog-events.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
    transaction: { findUnique: vi.fn(), count: vi.fn() },
    game: { findUnique: vi.fn() },
    gameEntry: { groupBy: vi.fn() },
}))
vi.mock('../lib/prisma', () => ({ default: db }))
const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))
vi.mock('../lib/logger', () => ({ rootLogger: { info: vi.fn(), warn: vi.fn() } }))

import {
    hoursBetween,
    withdrawalMethodFromNote,
    personPropsFor,
    gameOutcomeEvents,
    emitDepositApproved,
    emitGameFinished,
    emitGameRefunded,
} from '../lib/posthog-events'

beforeEach(() => vi.clearAllMocks())

describe('hoursBetween', () => {
    it('rounds to two decimals', () => {
        const from = new Date('2026-09-01T00:00:00Z')
        const to = new Date('2026-09-01T02:20:00Z')
        expect(hoursBetween(from, to)).toBe(2.33)
    })
    it('never goes negative', () => {
        const from = new Date('2026-09-01T05:00:00Z')
        const to = new Date('2026-09-01T00:00:00Z')
        expect(hoursBetween(from, to)).toBe(0)
    })
})

describe('withdrawalMethodFromNote', () => {
    it('returns the method code and never the account', () => {
        expect(withdrawalMethodFromNote('telebirr: 0911223344')).toBe('telebirr')
    })
    it('lower-cases the code', () => {
        expect(withdrawalMethodFromNote('CBE: 1000123456')).toBe('cbe')
    })
    it('returns null for a reviewer note or empty input', () => {
        expect(withdrawalMethodFromNote('Wrong account number')).toBeNull()
        expect(withdrawalMethodFromNote(null)).toBeNull()
        expect(withdrawalMethodFromNote(undefined)).toBeNull()
    })
})

describe('personPropsFor', () => {
    it('emits only the allowed person properties', () => {
        const props = personPropsFor(
            { serial: 42, createdAt: new Date('2026-05-01T10:00:00Z'), referredById: 'ref-1' },
            'phone',
        )
        expect(props).toEqual({
            serial: 42,
            signup_method: 'phone',
            referred: true,
            created_at: '2026-05-01T10:00:00.000Z',
        })
    })
})

describe('gameOutcomeEvents', () => {
    const base = {
        gameId: 'g1',
        templateId: 't1',
        ticketPrice: 50,
        durationSecs: 120,
        entrants: [
            { userId: 'winner', cartelas: 2 },
            { userId: 'loser', cartelas: 1 },
        ],
    }

    it('fans out one event per entrant with won / lost outcomes', () => {
        const events = gameOutcomeEvents({ ...base, winnerId: 'winner', prize: 135 })
        expect(events).toHaveLength(2)
        expect(events[0]).toEqual({
            userId: 'winner',
            properties: {
                game_id: 'g1',
                template_id: 't1',
                ticket_price: 50,
                cartelas: 2,
                stake: 100,
                outcome: 'won',
                prize: 135,
                net: 35,
                duration_secs: 120,
            },
        })
        expect(events[1].properties).toMatchObject({ outcome: 'lost', stake: 50, prize: 0, net: -50 })
    })

    it('marks every entrant no_winner when there is no winner', () => {
        const events = gameOutcomeEvents({ ...base, winnerId: null, prize: 0 })
        expect(events.map((e) => e.properties.outcome)).toEqual(['no_winner', 'no_winner'])
        expect(events[0].properties.net).toBe(-100)
    })
})

describe('emitDepositApproved', () => {
    it('captures amount, method, gateway, hours and first-deposit flag', async () => {
        db.transaction.findUnique.mockResolvedValue({
            id: 'tx1',
            userId: 'u1',
            amount: '500.00',
            note: 'telebirr',
            gateway: null,
            createdAt: new Date('2026-09-01T00:00:00Z'),
        })
        db.transaction.count.mockResolvedValue(0)
        await emitDepositApproved('tx1', new Date('2026-09-01T01:30:00Z'))
        expect(captureEvent).toHaveBeenCalledWith('u1', 'deposit_approved', {
            amount: 500,
            method: 'telebirr',
            gateway: 'manual',
            hours_to_approve: 1.5,
            is_first_deposit: true,
            tx_id: 'tx1',
        })
    })

    it('reports zarecash as the gateway and false for a repeat depositor', async () => {
        db.transaction.findUnique.mockResolvedValue({
            id: 'tx2',
            userId: 'u1',
            amount: '200',
            note: 'cbe',
            gateway: 'zarecash',
            createdAt: new Date('2026-09-01T00:00:00Z'),
        })
        db.transaction.count.mockResolvedValue(3)
        await emitDepositApproved('tx2', new Date('2026-09-01T00:00:00Z'))
        expect(captureEvent.mock.calls[0][2]).toMatchObject({ gateway: 'zarecash', is_first_deposit: false })
    })

    it('is silent when the row is missing or the read throws', async () => {
        db.transaction.findUnique.mockResolvedValue(null)
        await emitDepositApproved('nope')
        db.transaction.findUnique.mockRejectedValue(new Error('db'))
        await expect(emitDepositApproved('boom')).resolves.toBeUndefined()
        expect(captureEvent).not.toHaveBeenCalled()
    })
})

describe('emitGameFinished', () => {
    it('reads the game and entries and emits game_finished per player', async () => {
        db.game.findUnique.mockResolvedValue({
            id: 'g1',
            templateId: 't1',
            ticketPrice: '50',
            houseEdgePct: '10',
            winnerId: 'w',
            startedAt: new Date('2026-09-01T00:00:00Z'),
            endedAt: new Date('2026-09-01T00:03:00Z'),
        })
        db.gameEntry.groupBy.mockResolvedValue([
            { userId: 'w', _count: { _all: 1 } },
            { userId: 'l', _count: { _all: 2 } },
        ])
        await emitGameFinished('g1')
        expect(captureEvent).toHaveBeenCalledTimes(2)
        // pot = 50 * 3 = 150, prize = 150 * 0.9 = 135
        expect(captureEvent).toHaveBeenCalledWith('w', 'game_finished', expect.objectContaining({
            outcome: 'won', prize: 135, net: 85, duration_secs: 180,
        }))
        expect(captureEvent).toHaveBeenCalledWith('l', 'game_finished', expect.objectContaining({
            outcome: 'lost', stake: 100, net: -100,
        }))
    })

    it('is silent when the game is missing', async () => {
        db.game.findUnique.mockResolvedValue(null)
        await emitGameFinished('missing')
        expect(captureEvent).not.toHaveBeenCalled()
    })
})

describe('emitGameRefunded', () => {
    it('emits only for players actually refunded now', () => {
        emitGameRefunded('g1', 't1', [
            { userId: 'a', amount: 50, alreadyRefunded: false },
            { userId: 'b', amount: 50, alreadyRefunded: true },
        ], 'under_filled')
        expect(captureEvent).toHaveBeenCalledTimes(1)
        expect(captureEvent).toHaveBeenCalledWith('a', 'game_refunded', {
            game_id: 'g1', template_id: 't1', reason: 'under_filled', refund: 50,
        })
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/posthog-events.test.ts`
Expected: FAIL — cannot resolve `../lib/posthog-events`.

- [ ] **Step 3: Write the emitters**

Create `apps/api/src/lib/posthog-events.ts`:

```ts
/**
 * Typed PostHog emitters for the events that need a read or a fan-out before
 * they can be captured. Services call these post-commit as `void emitX(...)`.
 * Everything here is fire-and-forget and never throws — see lib/posthog.ts.
 *
 * Pure helpers (hoursBetween, withdrawalMethodFromNote, personPropsFor,
 * gameOutcomeEvents) are exported for unit tests and for the backfill mappers.
 */
import prisma from './prisma'
import { captureEvent } from './posthog'
import { rootLogger } from './logger'

export function hoursBetween(from: Date, to: Date): number {
    const hours = (to.getTime() - from.getTime()) / 3_600_000
    return Math.max(0, Math.round(hours * 100) / 100)
}

/**
 * requestWithdrawal writes `"<method>: <account>"` into `note`. Return the
 * method only. A reviewer's rejection note replaces that text, so anything
 * that does not match the shape yields null rather than a guess.
 */
export function withdrawalMethodFromNote(note: string | null | undefined): string | null {
    if (!note) return null
    const match = /^([a-z0-9_-]+):\s*\S+/i.exec(note)
    return match ? match[1].toLowerCase() : null
}

export function personPropsFor(
    user: { serial: number; createdAt: Date; referredById: string | null },
    signupMethod: 'phone' | 'telegram',
): Record<string, unknown> {
    return {
        serial: user.serial,
        signup_method: signupMethod,
        referred: user.referredById !== null,
        created_at: user.createdAt.toISOString(),
    }
}

export interface GameOutcomeInput {
    gameId: string
    templateId: string | null
    ticketPrice: number
    winnerId: string | null
    prize: number
    durationSecs: number | null
    entrants: Array<{ userId: string; cartelas: number }>
}

/** One `game_finished` payload per distinct entrant. Pure. */
export function gameOutcomeEvents(
    input: GameOutcomeInput,
): Array<{ userId: string; properties: Record<string, unknown> }> {
    return input.entrants.map((entrant) => {
        const stake = round2(input.ticketPrice * entrant.cartelas)
        const won = input.winnerId !== null && entrant.userId === input.winnerId
        const outcome = input.winnerId === null ? 'no_winner' : won ? 'won' : 'lost'
        const prize = won ? round2(input.prize) : 0
        return {
            userId: entrant.userId,
            properties: {
                game_id: input.gameId,
                template_id: input.templateId,
                ticket_price: input.ticketPrice,
                cartelas: entrant.cartelas,
                stake,
                outcome,
                prize,
                net: round2(prize - stake),
                duration_secs: input.durationSecs,
            },
        }
    })
}

function round2(n: number): number {
    return Math.round(n * 100) / 100
}

/** Post-commit for WalletService.approveDeposit — covers manual review and the ZareCash webhook. */
export async function emitDepositApproved(transactionId: string, now: Date = new Date()): Promise<void> {
    try {
        const tx = await prisma.transaction.findUnique({
            where: { id: transactionId },
            select: { id: true, userId: true, amount: true, note: true, gateway: true, createdAt: true },
        })
        if (!tx) return
        const prior = await prisma.transaction.count({
            where: { userId: tx.userId, type: 'DEPOSIT', status: 'APPROVED', id: { not: tx.id } },
        })
        void captureEvent(tx.userId, 'deposit_approved', {
            amount: Number(tx.amount),
            method: tx.note ?? null,
            gateway: tx.gateway ?? 'manual',
            hours_to_approve: hoursBetween(tx.createdAt, now),
            is_first_deposit: prior === 0,
            tx_id: tx.id,
        })
    } catch (err) {
        rootLogger.warn({ err, transactionId }, '[posthog] emitDepositApproved failed')
    }
}

/**
 * Post-commit for both completion paths (claimBingo and endGameNoWinner).
 * Reads the committed game row so the two paths cannot disagree about the prize.
 */
export async function emitGameFinished(gameId: string): Promise<void> {
    try {
        const game = await prisma.game.findUnique({
            where: { id: gameId },
            select: {
                id: true,
                templateId: true,
                ticketPrice: true,
                houseEdgePct: true,
                winnerId: true,
                startedAt: true,
                endedAt: true,
            },
        })
        if (!game) return
        const grouped = await prisma.gameEntry.groupBy({
            by: ['userId'],
            where: { gameId },
            _count: { _all: true },
        })
        const entrants = grouped.map((g) => ({ userId: g.userId, cartelas: g._count._all }))
        const totalEntries = entrants.reduce((sum, e) => sum + e.cartelas, 0)
        const ticketPrice = Number(game.ticketPrice)
        const prize = game.winnerId
            ? ticketPrice * totalEntries * (1 - Number(game.houseEdgePct) / 100)
            : 0
        const durationSecs =
            game.startedAt && game.endedAt
                ? Math.max(0, Math.round((game.endedAt.getTime() - game.startedAt.getTime()) / 1000))
                : null
        for (const ev of gameOutcomeEvents({
            gameId,
            templateId: game.templateId,
            ticketPrice,
            winnerId: game.winnerId,
            prize,
            durationSecs,
            entrants,
        })) {
            void captureEvent(ev.userId, 'game_finished', ev.properties)
        }
    } catch (err) {
        rootLogger.warn({ err, gameId }, '[posthog] emitGameFinished failed')
    }
}

/** Post-commit for GameService.cancelGame, fed by RefundService.refundGame's result. */
export function emitGameRefunded(
    gameId: string,
    templateId: string | null,
    refunds: Array<{ userId: string; amount: number; alreadyRefunded: boolean }>,
    reason: string,
): void {
    for (const refund of refunds) {
        if (refund.alreadyRefunded) continue
        void captureEvent(refund.userId, 'game_refunded', {
            game_id: gameId,
            template_id: templateId,
            reason,
            refund: refund.amount,
        })
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/posthog-events.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/posthog-events.ts apps/api/src/test/posthog-events.test.ts
git commit -m "feat(posthog): typed emitters for deposit approval and game outcomes"
```

---

### Task 3: Auth hooks (`user_registered`, `user_logged_in`)

**Files:**
- Modify: `apps/api/src/services/auth.service.ts` (imports; `register` ~line 18-66; `login` ~68-108; `telegramAuth` ~177-240)
- Create: `apps/api/src/test/posthog-auth-hooks.test.ts`

**Interfaces:**
- Consumes: `captureEvent` (Task 1), `personPropsFor` (Task 2).

- [ ] **Step 1: Write the failing test (real test database, mocked PostHog)**

Create `apps/api/src/test/posthog-auth-hooks.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))

import { AuthService } from '../services/auth.service'
import type { TelegramAuthDto } from '@world-bingo/shared-types'

function makeTelegramPayload(overrides: Partial<Omit<TelegramAuthDto, 'hash'>> = {}): TelegramAuthDto {
    const base = {
        id: 8800001,
        first_name: 'Hook',
        auth_date: Math.floor(Date.now() / 1000),
        ...overrides,
    }
    const dataCheckString = Object.entries(base)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
    const secretKey = crypto.createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN ?? 'test_token').digest()
    const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
    return { ...base, hash }
}

beforeEach(() => vi.clearAllMocks())

describe('AuthService PostHog hooks', () => {
    it('register emits user_registered with person props and no PII', async () => {
        const { user } = await AuthService.register({
            username: 'ph_reg',
            phone: '+251977000001',
            password: 'password123',
        })
        expect(captureEvent).toHaveBeenCalledTimes(1)
        const [id, event, props, opts] = captureEvent.mock.calls[0]
        expect(id).toBe(user.id)
        expect(event).toBe('user_registered')
        expect(props).toEqual({ signup_method: 'phone', referred: false })
        expect(opts.set).toEqual({
            serial: user.serial,
            signup_method: 'phone',
            referred: false,
            created_at: new Date(user.createdAt).toISOString(),
        })
        expect(JSON.stringify(captureEvent.mock.calls[0])).not.toContain('+251977000001')
    })

    it('login emits user_logged_in', async () => {
        const { user } = await AuthService.register({
            username: 'ph_login',
            phone: '+251977000002',
            password: 'password123',
        })
        captureEvent.mockClear()
        await AuthService.login({ identifier: 'ph_login', password: 'password123' })
        expect(captureEvent).toHaveBeenCalledWith(user.id, 'user_logged_in', { signup_method: 'phone' })
    })

    it('first Telegram auth emits user_registered, the second user_logged_in', async () => {
        const { user } = await AuthService.telegramAuth(makeTelegramPayload())
        expect(captureEvent).toHaveBeenCalledWith(
            user.id,
            'user_registered',
            { signup_method: 'telegram', referred: false },
            expect.objectContaining({ set: expect.objectContaining({ signup_method: 'telegram' }) }),
        )
        captureEvent.mockClear()
        await AuthService.telegramAuth(makeTelegramPayload())
        expect(captureEvent).toHaveBeenCalledWith(user.id, 'user_logged_in', { signup_method: 'telegram' })
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/posthog-auth-hooks.test.ts`
Expected: FAIL — `expected "vi.fn()" to be called 1 times, but got 0 times`.

- [ ] **Step 3: Add the hooks**

In `apps/api/src/services/auth.service.ts`, add after the existing `import { ReferralService } from './referral.service'`:

```ts
import { captureEvent } from '../lib/posthog'
import { personPropsFor } from '../lib/posthog-events'
```

In `register`, immediately before the final `const { passwordHash: _, ...result } = user` add:

```ts
        void captureEvent(
            user.id,
            'user_registered',
            { signup_method: 'phone', referred: !!referredById },
            { set: personPropsFor(user, 'phone') },
        )
```

In `login`, immediately before its final `const { passwordHash: _, ...result } = user` add:

```ts
        void captureEvent(user.id, 'user_logged_in', {
            signup_method: user.telegramId ? 'telegram' : 'phone',
        })
```

In `telegramAuth`, change:

```ts
        // 3. Upsert user
        const telegramId = String(data.id)
```

to:

```ts
        // 3. Upsert user
        const telegramId = String(data.id)
        // Read before the upsert: it is the only way to tell a first login
        // (user_registered) from a returning one (user_logged_in).
        const existed = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } })
```

and immediately before its final `const { passwordHash: _, ...result } = user` add:

```ts
        if (existed) {
            void captureEvent(user.id, 'user_logged_in', { signup_method: 'telegram' })
        } else {
            void captureEvent(
                user.id,
                'user_registered',
                { signup_method: 'telegram', referred: false },
                { set: personPropsFor(user, 'telegram') },
            )
        }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/posthog-auth-hooks.test.ts src/test/auth.service.test.ts`
Expected: both files PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/auth.service.ts apps/api/src/test/posthog-auth-hooks.test.ts
git commit -m "feat(posthog): emit user_registered and user_logged_in"
```

---

### Task 4: Wallet, admin review and ZareCash hooks

**Files:**
- Modify: `apps/api/src/services/wallet.service.ts` (imports; `initiateDeposit` ~27-108; `approveDeposit` post-commit `.then` ~215-292; `requestWithdrawal` `.then` ~402-476; `rejectWithdrawal` ~479-547)
- Modify: `apps/api/src/services/zarecash-checkout.service.ts` (~line 213-231, where the `TransactionType.DEPOSIT` row is created)
- Modify: `apps/api/src/services/admin.service.ts` (`reviewTransaction` ~261-370)
- Modify: `apps/api/src/services/zarecash.service.ts` (`settleApprovedWithdrawal` ~699-760)
- Create: `apps/api/src/test/posthog-wallet-hooks.test.ts`

**Interfaces:**
- Consumes: `captureEvent`; `emitDepositApproved`, `hoursBetween`, `withdrawalMethodFromNote`.

- [ ] **Step 1: Write the failing test (real test database, mocked PostHog)**

Create `apps/api/src/test/posthog-wallet-hooks.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))
const { emitDepositApproved } = vi.hoisted(() => ({ emitDepositApproved: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog-events', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/posthog-events')>()
    return { ...actual, emitDepositApproved }
})

import { WalletService } from '../services/wallet.service'
import { AdminService } from '../services/admin.service'
import { prisma } from './setup'
import { PaymentStatus } from '@world-bingo/shared-types'

let userId: string

beforeEach(async () => {
    vi.clearAllMocks()
    const user = await prisma.user.create({
        data: {
            username: 'ph_wallet',
            phone: '+251977000010',
            passwordHash: 'hashed:pw',
            wallet: { create: { realBalance: 1000 } },
        },
    })
    userId = user.id
})

describe('deposit hooks', () => {
    it('initiateDeposit emits deposit_submitted for the manual gateway', async () => {
        const tx = await WalletService.initiateDeposit(userId, {
            amount: 300,
            transactionId: 'PH-DEP-1',
            methodCode: 'telebirr',
        } as any)
        expect(captureEvent).toHaveBeenCalledWith(userId, 'deposit_submitted', {
            amount: 300,
            method: 'telebirr',
            gateway: 'manual',
            tx_id: tx.id,
        })
    })

    it('approveDeposit hands the committed id to emitDepositApproved', async () => {
        const tx = await WalletService.initiateDeposit(userId, {
            amount: 300,
            transactionId: 'PH-DEP-2',
            methodCode: 'telebirr',
        } as any)
        await WalletService.approveDeposit(tx.id)
        expect(emitDepositApproved).toHaveBeenCalledWith(tx.id)
    })

    it('approveDeposit emits bonus_granted for a first-deposit bonus', async () => {
        await prisma.siteSetting.create({ data: { key: 'first_deposit_bonus_amount', value: '50' } })
        const tx = await WalletService.initiateDeposit(userId, {
            amount: 300,
            transactionId: 'PH-DEP-3',
            methodCode: 'telebirr',
        } as any)
        await WalletService.approveDeposit(tx.id)
        expect(captureEvent).toHaveBeenCalledWith(userId, 'bonus_granted', {
            amount: 50,
            source: 'FIRST_DEPOSIT',
            rule_id: null,
        })
    })

    it('reviewTransaction REJECTED emits deposit_rejected with the method, not the note', async () => {
        const tx = await WalletService.initiateDeposit(userId, {
            amount: 300,
            transactionId: 'PH-DEP-4',
            methodCode: 'cbe',
        } as any)
        captureEvent.mockClear()
        await AdminService.reviewTransaction(tx.id, PaymentStatus.REJECTED, 'blurry receipt')
        expect(captureEvent).toHaveBeenCalledWith(userId, 'deposit_rejected', {
            amount: 300,
            method: 'cbe',
            hours_to_decision: expect.any(Number),
            has_note: true,
            tx_id: tx.id,
        })
    })
})

describe('withdrawal hooks', () => {
    it('requestWithdrawal emits withdrawal_requested without the account number', async () => {
        const tx = await WalletService.requestWithdrawal(userId, {
            amount: 200,
            paymentMethod: 'telebirr',
            accountNumber: '0911000000',
        })
        expect(captureEvent).toHaveBeenCalledWith(userId, 'withdrawal_requested', {
            amount: 200,
            method: 'telebirr',
            gateway: 'manual',
            tx_id: tx.id,
        })
        expect(JSON.stringify(captureEvent.mock.calls)).not.toContain('0911000000')
    })

    it('rejectWithdrawal emits withdrawal_rejected', async () => {
        const tx = await WalletService.requestWithdrawal(userId, {
            amount: 200,
            paymentMethod: 'telebirr',
            accountNumber: '0911000000',
        })
        captureEvent.mockClear()
        await WalletService.rejectWithdrawal(tx.id, 'name mismatch')
        expect(captureEvent).toHaveBeenCalledWith(userId, 'withdrawal_rejected', {
            amount: 200,
            method: 'telebirr',
            hours_to_decision: expect.any(Number),
            tx_id: tx.id,
        })
    })

    it('reviewTransaction APPROVED emits withdrawal_approved', async () => {
        const tx = await WalletService.requestWithdrawal(userId, {
            amount: 200,
            paymentMethod: 'cbe',
            accountNumber: '1000123456',
        })
        captureEvent.mockClear()
        await AdminService.reviewTransaction(tx.id, PaymentStatus.APPROVED, 'paid')
        expect(captureEvent).toHaveBeenCalledWith(userId, 'withdrawal_approved', {
            amount: 200,
            method: 'cbe',
            gateway: 'manual',
            hours_to_decision: expect.any(Number),
            tx_id: tx.id,
        })
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/posthog-wallet-hooks.test.ts`
Expected: FAIL on every `toHaveBeenCalledWith`.

- [ ] **Step 3: Wallet service hooks**

In `apps/api/src/services/wallet.service.ts`, after `import { reportError } from '../lib/sentry'` add:

```ts
import { captureEvent } from '../lib/posthog'
import { emitDepositApproved, hoursBetween, withdrawalMethodFromNote } from '../lib/posthog-events'
```

In `initiateDeposit`, directly after the `const transaction = await prisma.transaction.create({ ... })` statement (before `if (routeToZareCash) {`) add:

```ts
        void captureEvent(userId, 'deposit_submitted', {
            amount: Number(data.amount),
            method: data.methodCode ?? null,
            gateway: routeToZareCash ? 'zarecash' : 'manual',
            tx_id: transaction.id,
        })
```

In `approveDeposit`, inside the post-commit `.then(async ({ transaction, realAfter, bonusAwarded, bonusBefore, creditAmount, isAdjusted, statedAmount, depositBonusResult }) => {` block, directly after the `NotificationService.pushWalletUpdate(...)` call add:

```ts
            // PostHog — post-commit only. The approval itself, then every bonus
            // this approval granted (first-deposit and rule-based).
            void emitDepositApproved(transaction.id)
            if (bonusAwarded > 0) {
                void captureEvent(transaction.userId, 'bonus_granted', {
                    amount: bonusAwarded,
                    source: 'FIRST_DEPOSIT',
                    rule_id: null,
                })
            }
            for (const grant of [...depositBonusResult.daily, ...depositBonusResult.weekly]) {
                void captureEvent(transaction.userId, 'bonus_granted', {
                    amount: Number(grant.amount),
                    source: 'DEPOSIT_RULE',
                    rule_id: grant.ruleId,
                })
            }
```

In `requestWithdrawal`, inside `.then(async ({ transaction, realAfter, bonusBefore }) => {`, directly after the `NotificationService.pushWalletUpdate(...)` call add:

```ts
            void captureEvent(userId, 'withdrawal_requested', {
                amount: data.amount,
                method: data.paymentMethod,
                gateway: routeToZareCash ? 'zarecash' : 'manual',
                tx_id: transaction.id,
            })
```

In `rejectWithdrawal`, directly before `wbWithdrawalsTotal.labels('rejected').inc()` add:

```ts
        void captureEvent(existing.userId, 'withdrawal_rejected', {
            amount: Number(existing.amount),
            method: withdrawalMethodFromNote(existing.note),
            hours_to_decision: hoursBetween(existing.createdAt, new Date()),
            tx_id: transactionId,
        })
```

- [ ] **Step 4: ZareCash hosted-checkout `deposit_submitted`**

In `apps/api/src/services/zarecash-checkout.service.ts`, add to the imports:

```ts
import { captureEvent } from '../lib/posthog'
```

and directly after the `const tx = await prisma.transaction.create({ ... })` that writes `type: TransactionType.DEPOSIT` (before the `zareCashCheckoutSession.update`) add:

```ts
            void captureEvent(session.userId, 'deposit_submitted', {
                amount: Number(tx.amount),
                method: session.methodCode ?? null,
                gateway: 'zarecash',
                tx_id: tx.id,
            })
```

- [ ] **Step 5: Admin review hooks**

In `apps/api/src/services/admin.service.ts`, add to the imports:

```ts
import { captureEvent } from '../lib/posthog'
import { hoursBetween, withdrawalMethodFromNote } from '../lib/posthog-events'
```

In `reviewTransaction`, APPROVED path, directly after `const updated = await prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } })` add:

```ts
            if (tx.type === TransactionType.WITHDRAWAL) {
                void captureEvent(updated.userId, 'withdrawal_approved', {
                    amount: Number(updated.amount),
                    method: withdrawalMethodFromNote(tx.note),
                    gateway: 'manual',
                    hours_to_decision: hoursBetween(tx.createdAt, new Date()),
                    tx_id: transactionId,
                })
            }
```

In the REJECTED path, directly after the `const transaction = await prisma.transaction.update({ ... REJECTED ... })` statement add:

```ts
        // `existing.note` is the method code initiateDeposit stored; the update
        // above just replaced it with the reviewer's note.
        void captureEvent(transaction.userId, 'deposit_rejected', {
            amount: Number(existing.amount),
            method: existing.note ?? null,
            hours_to_decision: hoursBetween(existing.createdAt, new Date()),
            has_note: !!note,
            tx_id: transactionId,
        })
```

- [ ] **Step 6: ZareCash settle hook**

In `apps/api/src/services/zarecash.service.ts`, add to the imports:

```ts
import { captureEvent } from '../lib/posthog'
import { hoursBetween, withdrawalMethodFromNote } from '../lib/posthog-events'
```

In `settleApprovedWithdrawal`, change the opening:

```ts
        const claim = await prisma.transaction.updateMany({
```

to:

```ts
        // The claim below overwrites `note` (which carries the method). Read it first.
        const before = await prisma.transaction.findUnique({
            where: { id: transactionId },
            select: { note: true, createdAt: true },
        })
        const claim = await prisma.transaction.updateMany({
```

and directly before `wbWithdrawalsTotal.labels('approved').inc()` at the end of that function add:

```ts
        void captureEvent(settled.userId, 'withdrawal_approved', {
            amount: Number(settled.amount),
            method: withdrawalMethodFromNote(before?.note),
            gateway: 'zarecash',
            hours_to_decision: hoursBetween(before?.createdAt ?? settled.createdAt, new Date()),
            tx_id: transactionId,
        })
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/posthog-wallet-hooks.test.ts src/test/wallet.service.test.ts src/test/withdrawal.service.test.ts src/test/admin.service.test.ts src/test/zarecash-withdrawal-events.test.ts src/test/zarecash-event-processing.test.ts`
Expected: `posthog-wallet-hooks.test.ts` PASS (7 tests). The other five must show the same pass/fail counts as on `main` — compare with `git stash && <same command> && git stash pop` if any of them fail.

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm --filter @world-bingo/api typecheck` — no errors in the four modified services.

```bash
git add apps/api/src/services/wallet.service.ts apps/api/src/services/zarecash-checkout.service.ts apps/api/src/services/admin.service.ts apps/api/src/services/zarecash.service.ts apps/api/src/test/posthog-wallet-hooks.test.ts
git commit -m "feat(posthog): emit deposit, withdrawal and deposit-side bonus events"
```

---

### Task 5: Game hooks

**Files:**
- Modify: `apps/api/src/services/game.service.ts` (imports; `joinGame` ~46-186; `leaveGame` ~188-297; `cancelGame` ~364-430; `claimBingo` post-commit `.then` ~586-640)
- Modify: `apps/api/src/lib/game-engine.ts` (imports; `endGameNoWinner` ~216-290)
- Create: `apps/api/src/test/posthog-game-hooks.test.ts`

**Interfaces:**
- Consumes: `captureEvent`; `emitGameFinished`, `emitGameRefunded`.

- [ ] **Step 1: Write the failing test (real test database, mocks copied from `game.service.test.ts`)**

Create `apps/api/src/test/posthog-game-hooks.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/room-timer.service', () => ({
    startRoomCountdown: vi.fn(),
    stopRoomCountdown: vi.fn(),
    isCountdownActive: vi.fn().mockReturnValue(false),
}))
vi.mock('../lib/redis', () => {
    const mockRedis = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK'),
        del: vi.fn().mockResolvedValue(1),
        sadd: vi.fn().mockResolvedValue(1),
        srem: vi.fn().mockResolvedValue(1),
        scard: vi.fn().mockResolvedValue(1),
        smembers: vi.fn().mockResolvedValue([]),
        incrby: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
    }
    return { default: mockRedis, redis: mockRedis, getRedis: () => mockRedis }
})
vi.mock('../lib/socket', () => ({ getIo: () => ({ to: () => ({ emit: vi.fn() }) }) }))
vi.mock('../lib/game-engine', () => ({
    startGameEngine: vi.fn().mockResolvedValue(undefined),
    stopGameEngine: vi.fn(),
    isEngineActive: vi.fn().mockReturnValue(false),
    stopAllEngines: vi.fn(),
}))
vi.mock('../lib/game-state', () => ({
    initGameState: vi.fn().mockResolvedValue(undefined),
    clearGameState: vi.fn().mockResolvedValue(undefined),
    addCalledBall: vi.fn().mockResolvedValue(undefined),
    getCalledBalls: vi.fn().mockResolvedValue([1, 16, 31, 46, 61]),
    getGameState: vi.fn().mockResolvedValue(null),
}))
vi.mock('../services/notification.service', () => ({
    NotificationService: {
        create: vi.fn().mockResolvedValue({ id: 'notif-1' }),
        pushWalletUpdate: vi.fn(),
    },
}))
const { refundGame } = vi.hoisted(() => ({ refundGame: vi.fn().mockResolvedValue([]) }))
vi.mock('../services/refund.service', () => ({ RefundService: { refundGame } }))
vi.mock('../lib/queue', () => ({
    getQueue: vi.fn(() => ({ add: vi.fn().mockResolvedValue({ id: 'job-1' }) })),
    QUEUE_NAMES: { REFUND: 'refund', NOTIFICATION: 'notification', WITHDRAWAL: 'withdrawal', GAME_ENGINE: 'game-engine' },
}))
vi.mock('../services/game-scheduler.service', () => ({
    GameSchedulerService: {
        checkAndStartCountdown: vi.fn().mockResolvedValue(undefined),
        onGameEnded: vi.fn().mockResolvedValue(undefined),
    },
}))

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))
const emitters = vi.hoisted(() => ({
    emitGameFinished: vi.fn().mockResolvedValue(undefined),
    emitGameRefunded: vi.fn(),
}))
vi.mock('../lib/posthog-events', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/posthog-events')>()
    return { ...actual, ...emitters }
})

import { GameService } from '../services/game.service'
import { prisma } from './setup'
import { GameStatus, PatternType } from '@world-bingo/shared-types'

async function createUserWithWallet(username: string, phone: string) {
    return prisma.user.create({
        data: { username, phone, passwordHash: 'hashed:pass', wallet: { create: { realBalance: 500 } } },
    })
}

async function createGame(status: GameStatus = GameStatus.WAITING) {
    return prisma.game.create({
        data: {
            title: 'PH Game',
            status,
            ticketPrice: 50,
            maxPlayers: 10,
            minPlayers: 2,
            houseEdgePct: 10,
            pattern: PatternType.ANY_LINE,
            calledBalls: [],
        },
    })
}

async function createCartela(serial: string) {
    return prisma.cartela.create({
        data: {
            serial,
            grid: [
                [1, 16, 31, 46, 61],
                [2, 17, 32, 47, 62],
                [3, 18, 0, 48, 63],
                [4, 19, 34, 49, 64],
                [5, 20, 35, 50, 65],
            ],
        },
    })
}

let userId: string
let gameId: string

beforeEach(async () => {
    vi.clearAllMocks()
    userId = (await createUserWithWallet('ph_game', '+251977000020')).id
    gameId = (await createGame()).id
})

describe('GameService PostHog hooks', () => {
    it('joinGame emits game_joined with stake and cartela count', async () => {
        await createCartela('PH-C1')
        await createCartela('PH-C2')
        await GameService.joinGame(userId, gameId, ['PH-C1', 'PH-C2'])
        expect(captureEvent).toHaveBeenCalledWith(userId, 'game_joined', {
            game_id: gameId,
            template_id: null,
            ticket_price: 50,
            cartelas: 2,
            stake: 100,
            spend_account: 'REAL',
        })
    })

    it('leaveGame emits game_left with the refund', async () => {
        await createCartela('PH-C3')
        await GameService.joinGame(userId, gameId, ['PH-C3'])
        captureEvent.mockClear()
        await GameService.leaveGame(userId, gameId)
        expect(captureEvent).toHaveBeenCalledWith(userId, 'game_left', {
            game_id: gameId,
            template_id: null,
            refund: 50,
        })
    })

    it('cancelGame hands the refund list to emitGameRefunded', async () => {
        await createCartela('PH-C4')
        await GameService.joinGame(userId, gameId, ['PH-C4'])
        refundGame.mockResolvedValue([{ userId, amount: 50, alreadyRefunded: false }])
        await GameService.cancelGame(gameId, 'under_filled')
        expect(emitters.emitGameRefunded).toHaveBeenCalledWith(
            gameId,
            null,
            [{ userId, amount: 50, alreadyRefunded: false }],
            'under_filled',
        )
    })

    it('claimBingo emits game_finished once the payout commits', async () => {
        await createCartela('PH-C5')
        await GameService.joinGame(userId, gameId, ['PH-C5'])
        await prisma.game.update({ where: { id: gameId }, data: { status: GameStatus.IN_PROGRESS, startedAt: new Date() } })
        const cartela = await prisma.cartela.findUniqueOrThrow({ where: { serial: 'PH-C5' } })
        await GameService.claimBingo(userId, gameId, cartela.id)
        expect(emitters.emitGameFinished).toHaveBeenCalledWith(gameId)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/posthog-game-hooks.test.ts`
Expected: FAIL on every assertion.

- [ ] **Step 3: Game service hooks**

In `apps/api/src/services/game.service.ts`, after `import { HouseWalletService } from './house-wallet.service'` add:

```ts
import { captureEvent } from '../lib/posthog'
import { emitGameFinished, emitGameRefunded } from '../lib/posthog-events'
```

In `joinGame`, change the transaction's return:

```ts
            return { entries, game, totalCost, realAfter, bonusAfter }
```

to:

```ts
            return { entries, game, totalCost, realAfter, bonusAfter, spendAccount: wallet.spendAccount }
```

and the destructure that follows:

```ts
        const { game, totalCost, entries: joinedEntries, realAfter, bonusAfter } = txResult as {
            game: any
            totalCost: Decimal
            entries: any[]
            realAfter: Decimal
            bonusAfter: Decimal
        }
```

to:

```ts
        const { game, totalCost, entries: joinedEntries, realAfter, bonusAfter, spendAccount } = txResult as {
            game: any
            totalCost: Decimal
            entries: any[]
            realAfter: Decimal
            bonusAfter: Decimal
            spendAccount: string
        }
```

Then directly before `wbGameEntriesTotal.inc(joinedEntries.length)` add:

```ts
        void captureEvent(userId, 'game_joined', {
            game_id: gameId,
            template_id: game.templateId ?? null,
            ticket_price: Number(game.ticketPrice),
            cartelas: joinedEntries.length,
            stake: Number(totalCost),
            spend_account: spendAccount,
        })
```

In `leaveGame`, directly before `return { refundAmount, playerCount }` add:

```ts
        void captureEvent(userId, 'game_left', {
            game_id: gameId,
            template_id: game.templateId ?? null,
            refund: Number(refundAmount),
        })
```

In `cancelGame`, directly after `const refunds = await RefundService.refundGame(gameId)` add:

```ts
        emitGameRefunded(gameId, game.templateId ?? null, refunds, reason)
```

In `claimBingo`, inside the post-commit `.then(async ({ endedGame, balanceAfter, bonusBalAfter, isBot, prize }: any) => {` block, directly after `wbGamesCompletedTotal.labels('winner').inc()` add:

```ts
            void emitGameFinished(gameId)
```

- [ ] **Step 4: Game engine no-winner hook**

In `apps/api/src/lib/game-engine.ts`, after `import { wbGamesCompletedTotal, wbGameDurationSeconds } from './metrics'` add:

```ts
import { emitGameFinished } from './posthog-events'
```

In `endGameNoWinner`, directly after `wbGamesCompletedTotal.labels('no_winner').inc()` add:

```ts
    void emitGameFinished(gameId)
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/posthog-game-hooks.test.ts src/test/game.service.test.ts src/test/game.service.extended.test.ts`
Expected: `posthog-game-hooks.test.ts` PASS (4 tests); the other two unchanged from `main`.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @world-bingo/api typecheck` — no errors in `game.service.ts` or `game-engine.ts`.

```bash
git add apps/api/src/services/game.service.ts apps/api/src/lib/game-engine.ts apps/api/src/test/posthog-game-hooks.test.ts
git commit -m "feat(posthog): emit game_joined, game_left, game_finished and game_refunded"
```

---

### Task 6: Bonus, account-status and provider-launch hooks

**Files:**
- Modify: `apps/api/src/services/player-crm/campaign.service.ts` (the delivery method around lines 440-560)
- Modify: `apps/api/src/services/cashback.service.ts` (~245-265)
- Modify: `apps/api/src/routes/admin/index.ts` (`/players/:id/adjust-balance` ~215-265)
- Modify: `apps/api/src/services/account-status.service.ts` (`transition` ~190-262)
- Modify: `apps/api/src/routes/game-provider/index.ts` (~228-240)
- Create: `apps/api/src/test/posthog-status-hook.test.ts`

**Interfaces:**
- Consumes: `captureEvent`.

- [ ] **Step 1: Write the failing test (mocked Prisma, copied from `account-status.test.ts`)**

Create `apps/api/src/test/posthog-status-hook.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const tx = vi.hoisted(() => ({
    user: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    accountStatusChange: { create: vi.fn(), findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
}))
vi.mock('../lib/prisma', () => ({
    default: {
        $transaction: vi.fn(async (fn: any) => fn(tx)),
        user: { findUnique: vi.fn() },
        accountStatusChange: { findMany: vi.fn().mockResolvedValue([]) },
    },
}))
const redisMock = vi.hoisted(() => ({
    get: vi.fn(),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
}))
vi.mock('../lib/redis', () => ({ default: redisMock }))
vi.mock('../services/notification.service', () => ({
    NotificationService: { create: vi.fn().mockResolvedValue({}) },
}))
vi.mock('../services/zarecash.service', () => ({
    ZareCashService: { syncPlayerFreeze: vi.fn().mockResolvedValue({ ok: true, skipped: false }) },
}))
const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))

import { AccountStatusService } from '../services/account-status.service'

beforeEach(() => {
    vi.clearAllMocks()
    tx.user.findUnique.mockResolvedValue({ accountStatus: 'ACTIVE', username: 'abebe' })
    tx.accountStatusChange.create.mockImplementation(async ({ data }: any) => ({ id: 'chg1', ...data }))
    tx.accountStatusChange.findFirst.mockResolvedValue({ id: 'existing' })
    redisMock.get.mockResolvedValue(null)
})

describe('AccountStatusService PostHog hook', () => {
    it('emits account_status_changed on a real transition', async () => {
        await AccountStatusService.restrict('user-1', {
            reason: 'duplicate receipts',
            category: 'RECEIPT_FRAUD',
            actorId: 'clerk-1',
            expiresAt: new Date('2026-10-01T00:00:00Z'),
        })
        expect(captureEvent).toHaveBeenCalledWith('user-1', 'account_status_changed', {
            from: 'ACTIVE',
            to: 'RESTRICTED',
            category: 'RECEIPT_FRAUD',
            has_expiry: true,
        })
    })

    it('stays silent when the status is unchanged', async () => {
        tx.user.findUnique.mockResolvedValue({ accountStatus: 'RESTRICTED', username: 'abebe' })
        await AccountStatusService.restrict('user-1', { reason: 'again', actorId: 'clerk-1' })
        expect(captureEvent).not.toHaveBeenCalled()
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/posthog-status-hook.test.ts`
Expected: FAIL — `captureEvent` not called. (If `AccountStatusService.restrict` does not exist under that name, open `account-status.service.ts` lines 65-185 and use the public method that transitions to `RESTRICTED`; the existing `account-status.test.ts` calls it.)

- [ ] **Step 3: Account-status hook**

In `apps/api/src/services/account-status.service.ts`, after `import { ZareCashService } from './zarecash.service.js'` add:

```ts
import { captureEvent } from '../lib/posthog'
```

In `transition`, change:

```ts
        if (result.changed) {
            await AccountStatusService.announce(userId, to, reason)
        }
```

to:

```ts
        if (result.changed) {
            await AccountStatusService.announce(userId, to, reason)
            void captureEvent(userId, 'account_status_changed', {
                from: result.from,
                to,
                category: input.category ?? null,
                has_expiry: !!input.expiresAt,
            })
        }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/posthog-status-hook.test.ts src/test/account-status.test.ts`
Expected: both PASS.

- [ ] **Step 5: Campaign bonus hook**

In `apps/api/src/services/player-crm/campaign.service.ts`, add to the imports:

```ts
import { captureEvent } from '../../lib/posthog'
```

In the delivery method, find the `await prisma.$transaction(async (tx) => { ... })` whose body assigns `bonusAmount = amount`. Directly after that `$transaction(...)` call completes (before the `// Socket push is best-effort` comment) add:

```ts
            if (bonusAmount > 0) {
                void captureEvent(userId, 'bonus_granted', {
                    amount: Number(bonusAmount),
                    source: 'CAMPAIGN',
                    rule_id: campaignId,
                })
            }
```

(`bonusAmount`, `userId` and `campaignId` are already in scope in that method; `bonusAmount` is the `let` declared above the transaction. If it is typed as `Decimal | number`, `Number(...)` handles both.)

- [ ] **Step 6: Cashback bonus hook**

In `apps/api/src/services/cashback.service.ts`, add to the imports:

```ts
import { captureEvent } from '../lib/posthog'
```

In the disbursement loop, change:

```ts
            if (result === 'skipped') {
                skipped++
            } else {
                disbursed++
                total = total.plus(result as Decimal)
```

to:

```ts
            if (result === 'skipped') {
                skipped++
            } else {
                disbursed++
                total = total.plus(result as Decimal)
                void captureEvent(entry.userId, 'bonus_granted', {
                    amount: Number(result as Decimal),
                    source: 'CASHBACK',
                    rule_id: promotionId,
                })
```

- [ ] **Step 7: Admin adjust-balance hook**

In `apps/api/src/routes/admin/index.ts`, add to the imports:

```ts
import { captureEvent } from '../../lib/posthog'
```

In the `/players/:id/adjust-balance` handler, change:

```ts
            NotificationService.pushWalletUpdate(userId, result.realBalance, result.bonusBalance)
            return result
```

to:

```ts
            NotificationService.pushWalletUpdate(userId, result.realBalance, result.bonusBalance)
            if (type === 'bonus' && Number(amount) > 0) {
                void captureEvent(userId, 'bonus_granted', {
                    amount: Number(amount),
                    source: 'ADMIN',
                    rule_id: null,
                })
            }
            return result
```

(`type`, `amount`, `userId` come from `parsed.data` and `req.params.id` a few lines above. Check the literal the schema uses for the bonus branch — the existing code compares `type === 'real'` for the real branch, so the other value is what to compare against; read `adjustBalanceSchema` and use its exact literal.)

- [ ] **Step 8: Provider launch hook**

In `apps/api/src/routes/game-provider/index.ts`, add to the imports:

```ts
import { captureEvent } from '../../lib/posthog'
```

Directly before the `// Fire analytics event non-blocking — never fail the launch` comment add:

```ts
            void captureEvent(user.id, 'provider_game_launched', {
                provider_code: providerCode,
                game_code: gameCode,
            })
```

- [ ] **Step 9: Typecheck, run neighbouring suites, commit**

Run: `pnpm --filter @world-bingo/api typecheck` — no errors in the five modified files.

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/campaign.service.test.ts src/test/cashback.service.test.ts src/test/admin-adjust-balance.test.ts`
Expected: unchanged from `main`.

```bash
git add apps/api/src/services/player-crm/campaign.service.ts apps/api/src/services/cashback.service.ts apps/api/src/routes/admin/index.ts apps/api/src/services/account-status.service.ts apps/api/src/routes/game-provider/index.ts apps/api/src/test/posthog-status-hook.test.ts
git commit -m "feat(posthog): emit bonus_granted, account_status_changed and provider_game_launched"
```

---

### Task 7: Web plugin, pure helpers, proxy and config

**Files:**
- Modify: `apps/web/package.json` (dependencies)
- Create: `apps/web/utils/posthog.ts`
- Create: `apps/web/utils/posthog.test.ts`
- Create: `apps/web/plugins/02.posthog.client.ts`
- Modify: `apps/web/nuxt.config.ts:1-9` (proxy constants) and `:78-102` (runtimeConfig) and `:104-121` (routeRules)
- Modify: `apps/web/Dockerfile` (build args, after `ENV NUXT_API_PROXY_TARGET=...`)
- Modify: `apps/web/.env.example`

**Interfaces:**
- Produces:
  - `buildPersonProps(user: { serial: number; telegramId?: string | null; createdAt: Date | string }, brand: string): { serial; brand; signup_method; created_at }`
  - `buildSuperProps(input: { brand: string; locale: string; standalone: boolean }): { brand; locale; is_pwa }`
  - `resolveReplayEnabled(raw: unknown): boolean`
  - `isStandaloneDisplay(win: { matchMedia?: (q: string) => { matches: boolean }; navigator?: { standalone?: boolean } }): boolean`
  - `brandSlug(input: { brand?: string | null; shortName: string }): string`
  - Nuxt-provided `useNuxtApp().$posthog: PostHog | null`
  - `runtimeConfig.public.posthog: { key, host, uiHost, replay, brand }`

- [ ] **Step 1: Install the dependency**

Run from the repo root:

```bash
pnpm --filter @world-bingo/web add posthog-js@^1.427.2
```

- [ ] **Step 2: Write the failing tests**

Create `apps/web/utils/posthog.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  buildPersonProps,
  buildSuperProps,
  resolveReplayEnabled,
  isStandaloneDisplay,
  brandSlug,
} from './posthog'

describe('buildPersonProps', () => {
  it('maps a phone user and never leaks phone or name', () => {
    const props = buildPersonProps(
      { serial: 12, telegramId: undefined, createdAt: '2026-05-01T10:00:00.000Z' } as any,
      'arada',
    )
    expect(props).toEqual({
      serial: 12,
      brand: 'arada',
      signup_method: 'phone',
      created_at: '2026-05-01T10:00:00.000Z',
    })
    expect(Object.keys(props)).not.toContain('phone')
  })

  it('marks Telegram users', () => {
    const props = buildPersonProps({ serial: 1, telegramId: '55', createdAt: new Date(0) }, 'betbawa')
    expect(props.signup_method).toBe('telegram')
    expect(props.created_at).toBe('1970-01-01T00:00:00.000Z')
  })
})

describe('buildSuperProps', () => {
  it('returns brand, locale and is_pwa', () => {
    expect(buildSuperProps({ brand: 'arada', locale: 'am', standalone: true })).toEqual({
      brand: 'arada',
      locale: 'am',
      is_pwa: true,
    })
  })
})

describe('resolveReplayEnabled', () => {
  it('defaults on', () => {
    expect(resolveReplayEnabled(undefined)).toBe(true)
    expect(resolveReplayEnabled('')).toBe(true)
    expect(resolveReplayEnabled('true')).toBe(true)
  })
  it('turns off for false-ish strings and booleans', () => {
    for (const raw of ['false', 'FALSE', '0', 'off', 'no', false]) {
      expect(resolveReplayEnabled(raw)).toBe(false)
    }
  })
})

describe('isStandaloneDisplay', () => {
  it('reads display-mode standalone', () => {
    expect(isStandaloneDisplay({ matchMedia: () => ({ matches: true }) })).toBe(true)
  })
  it('falls back to navigator.standalone', () => {
    expect(isStandaloneDisplay({ matchMedia: () => ({ matches: false }), navigator: { standalone: true } })).toBe(true)
  })
  it('is false in a plain tab', () => {
    expect(isStandaloneDisplay({ matchMedia: () => ({ matches: false }), navigator: {} })).toBe(false)
  })
  it('survives a matchMedia that throws', () => {
    expect(
      isStandaloneDisplay({
        matchMedia: () => {
          throw new Error('jsdom')
        },
      }),
    ).toBe(false)
  })
})

describe('brandSlug', () => {
  it('prefers the configured brand', () => {
    expect(brandSlug({ brand: 'arada', shortName: 'Whatever' })).toBe('arada')
  })
  it('falls back to the slugged short name', () => {
    expect(brandSlug({ brand: '', shortName: 'Bet Bawa' })).toBe('bet-bawa')
    expect(brandSlug({ brand: null, shortName: 'Arada' })).toBe('arada')
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @world-bingo/web exec vitest run utils/posthog.test.ts`
Expected: FAIL — cannot resolve `./posthog`.

- [ ] **Step 4: Write the pure helpers**

Create `apps/web/utils/posthog.ts`:

```ts
/**
 * Pure helpers behind plugins/02.posthog.client.ts and useAnalytics().
 * No Nuxt runtime here so they stay unit-testable.
 *
 * Person properties are deliberately narrow: serial, brand, signup method and
 * signup date. Phone, names and Telegram handles never leave the app.
 */

export interface PersonProps {
  serial: number
  brand: string
  signup_method: 'phone' | 'telegram'
  created_at: string
}

export function buildPersonProps(
  user: { serial: number; telegramId?: string | null; createdAt: Date | string },
  brand: string,
): PersonProps {
  return {
    serial: user.serial,
    brand,
    signup_method: user.telegramId ? 'telegram' : 'phone',
    created_at: new Date(user.createdAt).toISOString(),
  }
}

export function buildSuperProps(input: { brand: string; locale: string; standalone: boolean }) {
  return { brand: input.brand, locale: input.locale, is_pwa: input.standalone }
}

/** NUXT_PUBLIC_POSTHOG_REPLAY: anything but an explicit off value keeps replay on. */
export function resolveReplayEnabled(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === '') return true
  if (raw === false) return false
  const s = String(raw).trim().toLowerCase()
  return !(s === 'false' || s === '0' || s === 'off' || s === 'no')
}

export function isStandaloneDisplay(win: {
  matchMedia?: (query: string) => { matches: boolean }
  navigator?: { standalone?: boolean }
}): boolean {
  try {
    if (win.matchMedia?.('(display-mode: standalone)').matches) return true
  } catch {
    // jsdom and old WebViews throw on matchMedia
  }
  return win.navigator?.standalone === true
}

/** The `brand` super property: env override first, else the brand's short name slugged. */
export function brandSlug(input: { brand?: string | null; shortName: string }): string {
  const configured = input.brand?.trim()
  if (configured) return configured
  return input.shortName.trim().toLowerCase().replace(/\s+/g, '-')
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @world-bingo/web exec vitest run utils/posthog.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Runtime config and proxy rules**

In `apps/web/nuxt.config.ts`, after the `const API_PROXY_TARGET = ...` line add:

```ts
// PostHog ingest is proxied through this origin so ad blockers never see it.
// EU Cloud by default; a US project passes both build args (see Dockerfile).
const POSTHOG_PROXY_TARGET = process.env.NUXT_POSTHOG_PROXY_TARGET || 'https://eu.i.posthog.com'
const POSTHOG_ASSETS_PROXY_TARGET =
    process.env.NUXT_POSTHOG_ASSETS_PROXY_TARGET || 'https://eu-assets.i.posthog.com'
```

In `runtimeConfig.public`, after the `sentry: { dsn: '', environment: '' },` block add:

```ts
            // PostHog product analytics. Auto-mapped from NUXT_PUBLIC_POSTHOG_KEY,
            // NUXT_PUBLIC_POSTHOG_HOST, NUXT_PUBLIC_POSTHOG_UI_HOST,
            // NUXT_PUBLIC_POSTHOG_REPLAY, NUXT_PUBLIC_POSTHOG_BRAND.
            // Empty key = fully inert (see plugins/02.posthog.client.ts).
            posthog: {
                key: '',
                host: '/ingest',
                uiHost: 'https://eu.posthog.com',
                replay: 'true',
                brand: '',
            },
```

In `routeRules`, directly before the `'/api/**': { proxy: ... }` line add:

```ts
        // PostHog reverse proxy. The static rule must stay above the catch-all.
        '/ingest/static/**': { proxy: `${POSTHOG_ASSETS_PROXY_TARGET}/static/**` },
        '/ingest/**': { proxy: `${POSTHOG_PROXY_TARGET}/**` },
```

- [ ] **Step 7: The plugin**

Create `apps/web/plugins/02.posthog.client.ts`:

```ts
/**
 * PostHog browser SDK. Client-only; fully env-gated.
 *
 * Empty NUXT_PUBLIC_POSTHOG_KEY → this plugin provides `$posthog = null` and
 * nothing else runs. useAnalytics() and store/auth.ts check for null.
 *
 * Runs after 00.brand.ts (brand is loaded) and after the Pinia module plugin
 * (the persisted auth store is hydrated), so a returning player is identified
 * on the very first page load, not only after the next login.
 *
 * autocapture is OFF on purpose: a game screen redraws every few seconds and
 * click-everything would bury the named events. Session replay masks every
 * input and anything marked data-ph-mask, and blocks uploaded receipt images.
 */
import posthog, { type PostHog } from 'posthog-js'
import {
  brandSlug,
  buildPersonProps,
  buildSuperProps,
  isStandaloneDisplay,
  resolveReplayEnabled,
} from '~/utils/posthog'

export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig()
  const ph = config.public.posthog
  const key = ph?.key || ''

  if (!key) {
    return { provide: { posthog: null as PostHog | null } }
  }

  const brand = brandSlug({ brand: ph.brand, shortName: useBrand().value.shortName })

  posthog.init(key, {
    api_host: ph.host || '/ingest',
    ui_host: ph.uiHost || 'https://eu.posthog.com',
    person_profiles: 'identified_only',
    capture_pageview: 'history_change',
    capture_pageleave: true,
    autocapture: false,
    disable_session_recording: !resolveReplayEnabled(ph.replay),
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '[data-ph-mask]',
      blockSelector: 'img[src*="/uploads/"], [data-ph-block]',
    },
  })

  const i18n = nuxtApp.$i18n as { locale?: { value?: string } } | undefined
  const locale = i18n?.locale?.value || 'en'
  posthog.register(buildSuperProps({ brand, locale, standalone: isStandaloneDisplay(window) }))

  const auth = useAuth()
  if (auth.user) {
    posthog.identify(auth.user.id, buildPersonProps(auth.user, brand))
  }

  return { provide: { posthog: posthog as PostHog | null } }
})
```

- [ ] **Step 8: Dockerfile and env example**

In `apps/web/Dockerfile`, directly after `ENV NUXT_API_PROXY_TARGET=$NUXT_API_PROXY_TARGET` add:

```dockerfile
# PostHog ingest proxy targets are baked into routeRules too. EU Cloud defaults;
# override both only for a US-region project.
ARG NUXT_POSTHOG_PROXY_TARGET=https://eu.i.posthog.com
ENV NUXT_POSTHOG_PROXY_TARGET=$NUXT_POSTHOG_PROXY_TARGET
ARG NUXT_POSTHOG_ASSETS_PROXY_TARGET=https://eu-assets.i.posthog.com
ENV NUXT_POSTHOG_ASSETS_PROXY_TARGET=$NUXT_POSTHOG_ASSETS_PROXY_TARGET
```

Append to `apps/web/.env.example`:

```bash

# --- Product analytics (PostHog Cloud) ---
# Leave NUXT_PUBLIC_POSTHOG_KEY empty to keep PostHog fully inert (no script, no events).
NUXT_PUBLIC_POSTHOG_KEY=
# Ingest goes through this app's own origin (/ingest → PostHog) so ad blockers do not see it.
NUXT_PUBLIC_POSTHOG_HOST=/ingest
NUXT_PUBLIC_POSTHOG_UI_HOST=https://eu.posthog.com
# Session replay (inputs masked). Set to false to turn replay off without a rebuild.
NUXT_PUBLIC_POSTHOG_REPLAY=true
# `brand` super property on every event. Empty = slug of the brand's short name.
NUXT_PUBLIC_POSTHOG_BRAND=
```

- [ ] **Step 9: Typecheck the web app**

Run: `pnpm --filter @world-bingo/web exec nuxt typecheck 2>&1 | grep -E 'posthog|nuxt.config' || echo "no posthog errors"`
Expected: `no posthog errors`. (The full typecheck may report pre-existing errors elsewhere; only lines naming `posthog` or `nuxt.config.ts` matter here.)

- [ ] **Step 10: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/utils/posthog.ts apps/web/utils/posthog.test.ts apps/web/plugins/02.posthog.client.ts apps/web/nuxt.config.ts apps/web/Dockerfile apps/web/.env.example
git commit -m "feat(web): env-gated PostHog plugin with proxied ingest and masked replay"
```

---

### Task 8: `useAnalytics` adapter, auth store wiring, allowlist fixes

**Files:**
- Modify: `apps/web/composables/useAnalytics.ts` (whole file)
- Create: `apps/web/composables/useAnalytics.test.ts`
- Modify: `apps/web/store/auth.ts` (remove `sendIdentify`; wire `identify` / `reset`)
- Modify: `apps/web/pages/profile.vue:14`
- Modify: `apps/api/src/services/event.service.ts` (`ALLOWED_EVENTS`)

**Interfaces:**
- Consumes: `useNuxtApp().$posthog` (Task 7), `buildPersonProps`, `brandSlug`.
- Produces: `useAnalytics(): { track(name, props?), identify(user?), reset(), flush() }` where `identify` takes `{ id: string; serial: number; telegramId?: string | null; createdAt: Date | string } | null | undefined`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/composables/useAnalytics.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const ph = { capture: vi.fn(), identify: vi.fn(), reset: vi.fn() }
let installed: typeof ph | null = ph
vi.stubGlobal('useNuxtApp', () => ({ $posthog: installed }))
vi.stubGlobal('useRuntimeConfig', () => ({
  public: { apiBase: '/api', posthog: { brand: 'arada' } },
}))
vi.stubGlobal('useBrand', () => ({ value: { shortName: 'Arada' } }))
const fetchMock = vi.fn().mockResolvedValue({ ok: true })
vi.stubGlobal('fetch', fetchMock)

import { useAnalytics } from './useAnalytics'

const user = { id: 'u-1', serial: 9, telegramId: null, createdAt: '2026-05-01T00:00:00.000Z' }

beforeEach(() => {
  vi.clearAllMocks()
  installed = ph
  localStorage.clear()
  sessionStorage.clear()
})

describe('track', () => {
  it('forwards any event name to PostHog', () => {
    useAnalytics().track('brand_new_event', { a: 1 })
    expect(ph.capture).toHaveBeenCalledWith('brand_new_event', { a: 1 })
  })

  it('still only queues allowlisted names for the /events sink', async () => {
    const { track, flush } = useAnalytics()
    track('brand_new_event')
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    track('lobby_view')
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.events).toEqual([{ name: 'lobby_view', props: null }])
  })

  it('accepts games_lobby_view for the /events sink', async () => {
    const { track, flush } = useAnalytics()
    track('games_lobby_view')
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not throw when PostHog is not installed', () => {
    installed = null
    expect(() => useAnalytics().track('lobby_view')).not.toThrow()
  })
})

describe('identify', () => {
  it('identifies in PostHog with person props and posts the anon link', () => {
    localStorage.setItem('wb_anon_id', 'anon-1')
    useAnalytics().identify(user)
    expect(ph.identify).toHaveBeenCalledWith('u-1', {
      serial: 9,
      brand: 'arada',
      signup_method: 'phone',
      created_at: '2026-05-01T00:00:00.000Z',
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/events/identify', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).anonId).toBe('anon-1')
  })

  it('skips PostHog when no user is given but still links the anon id', () => {
    localStorage.setItem('wb_anon_id', 'anon-2')
    useAnalytics().identify(null)
    expect(ph.identify).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('reset', () => {
  it('resets PostHog and rotates the anonymous id', () => {
    localStorage.setItem('wb_anon_id', 'anon-old')
    sessionStorage.setItem('wb_session_id', 'sess-old')
    useAnalytics().reset()
    expect(ph.reset).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('wb_anon_id')).toBeNull()
    expect(sessionStorage.getItem('wb_session_id')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @world-bingo/web exec vitest run composables/useAnalytics.test.ts`
Expected: FAIL — `ph.capture` not called; `identify`/`reset` shape mismatches.

- [ ] **Step 3: Rewrite the composable**

Replace the whole of `apps/web/composables/useAnalytics.ts` with:

```ts
import { v4 as uuidv4 } from 'uuid'
import type { PostHog } from 'posthog-js'
import { brandSlug, buildPersonProps } from '~/utils/posthog'

/**
 * Two sinks, one call.
 *
 * `track()` sends every event to PostHog (any name) AND, for names on the
 * allowlist below, to the custom `/events` endpoint that feeds the admin
 * analytics page. The allowlist only gates the second sink: a name missing
 * here still reaches PostHog, so a new event is never silently lost.
 */
const ALLOWED = new Set([
    'lobby_view',
    'games_lobby_view',
    'game_view',
    'join_click',
    'deposit_modal_opened',
    'deposit_method_selected',
    'deposit_amount_entered',
    'identify',
    'provider_game_view',
    'provider_session_ended',
    // Kept in step with ALLOWED_EVENTS in apps/api/src/services/event.service.ts.
    // A name missing from either list is dropped by the /events sink (PostHog
    // still gets it).
    'hero_predictions_click',
    'lobby_predictions_click',
])

interface RawEvent {
    name: string
    props?: Record<string, unknown> | null
}

interface QueuedEvent extends RawEvent {
    ts: number
}

export interface IdentifiableUser {
    id: string
    serial: number
    telegramId?: string | null
    createdAt: Date | string
}

const queue: QueuedEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let visibilityBound = false

function getPosthog(): PostHog | null {
    try {
        return (useNuxtApp().$posthog as PostHog | null | undefined) ?? null
    } catch {
        return null
    }
}

function currentBrand(): string {
    try {
        const config = useRuntimeConfig()
        return brandSlug({
            brand: (config.public.posthog as { brand?: string } | undefined)?.brand,
            shortName: useBrand().value.shortName,
        })
    } catch {
        return ''
    }
}

function getAnonId(): string {
    if (import.meta.server) return ''
    let id = localStorage.getItem('wb_anon_id')
    if (!id) {
        id = uuidv4()
        localStorage.setItem('wb_anon_id', id)
    }
    return id
}

function getSessionId(): string {
    if (import.meta.server) return ''
    let id = sessionStorage.getItem('wb_session_id')
    if (!id) {
        id = uuidv4()
        sessionStorage.setItem('wb_session_id', id)
    }
    return id
}

async function flush() {
    if (!queue.length) return
    const batch = queue.splice(0)
    const config = useRuntimeConfig()
    const anonId = getAnonId()
    const sessionId = getSessionId()
    const payload = JSON.stringify({
        events: batch.map(e => ({ name: e.name, props: e.props ?? null })),
        anonId,
        sessionId,
    })
    const url = `${config.public.apiBase}/events`

    try {
        if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
            const sent = navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }))
            if (!sent) throw new Error('sendBeacon failed')
        } else {
            await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: payload,
                keepalive: true,
            })
        }
    } catch {
        // swallow — telemetry must never break the app
    }
}

function scheduleFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
        flushTimer = null
        flush()
    }, 5000)
}

export const useAnalytics = () => {
    const track = (name: string, props?: Record<string, unknown> | null) => {
        if (import.meta.server) return
        const ph = getPosthog()
        if (ph) {
            try {
                ph.capture(name, props ?? undefined)
            } catch {
                // never let analytics throw into the UI
            }
        }
        if (!ALLOWED.has(name)) return
        queue.push({ name, props: props ?? null, ts: Date.now() })
        scheduleFlush()
    }

    /**
     * Call after login / register / Telegram login. Links the anonymous trail
     * to the player in both sinks. Safe to call with no user: the /events link
     * still goes out, PostHog is skipped.
     */
    const identify = (user?: IdentifiableUser | null) => {
        if (import.meta.server) return
        const ph = getPosthog()
        if (ph && user) {
            try {
                ph.identify(user.id, buildPersonProps(user, currentBrand()))
            } catch {
                // ignore
            }
        }
        const config = useRuntimeConfig()
        const anonId = getAnonId()
        const sessionId = getSessionId()
        const url = `${config.public.apiBase}/events/identify`
        fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ anonId, sessionId }),
        }).catch(() => {})
    }

    /**
     * Call on logout. Forgets the PostHog person AND rotates the anonymous id,
     * so the next account on a shared phone does not inherit this trail.
     */
    const reset = () => {
        if (import.meta.server) return
        const ph = getPosthog()
        if (ph) {
            try {
                ph.reset()
            } catch {
                // ignore
            }
        }
        try {
            localStorage.removeItem('wb_anon_id')
            sessionStorage.removeItem('wb_session_id')
        } catch {
            // storage may be unavailable
        }
    }

    if (import.meta.client && !visibilityBound) {
        visibilityBound = true
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flush()
        })
    }

    return { track, identify, reset, flush }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @world-bingo/web exec vitest run composables/useAnalytics.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Wire the auth store**

In `apps/web/store/auth.ts`, delete the whole `function sendIdentify(apiBase: string) { ... }` block (lines 4-14).

In `login`, replace `sendIdentify(config.public.apiBase as string)` with:

```ts
      useAnalytics().identify(user)
```

In `telegramLogin`, directly after `this.refreshToken = refreshToken` add:

```ts
      useAnalytics().identify(user)
```

In `register`, replace `sendIdentify(config.public.apiBase as string)` with:

```ts
      useAnalytics().identify(user)
```

In `clearStoredUser`, change:

```ts
    clearStoredUser() {
      this.user = null
```

to:

```ts
    clearStoredUser() {
      useAnalytics().reset()
      this.user = null
```

In `logout`, change the tail:

```ts
      this.user = null
      this.accessToken = null
      this.refreshToken = null
      this.wallet = null
    },
```

to:

```ts
      useAnalytics().reset()
      this.user = null
      this.accessToken = null
      this.refreshToken = null
      this.wallet = null
    },
```

(Only the `logout` action's tail — `clearStoredUser` was handled above. Both call `reset()` once.)

- [ ] **Step 6: Mask the one PII text node and fix the API allowlist**

In `apps/web/pages/profile.vue`, change line 14:

```html
          <p class="phone">{{ auth.user?.telegramUsername ? `@${auth.user.telegramUsername}` : auth.user?.phone }}</p>
```

to:

```html
          <p class="phone" data-ph-mask>{{ auth.user?.telegramUsername ? `@${auth.user.telegramUsername}` : auth.user?.phone }}</p>
```

In `apps/api/src/services/event.service.ts`, change:

```ts
export const ALLOWED_EVENTS = [
    'lobby_view',
    'game_view',
```

to:

```ts
export const ALLOWED_EVENTS = [
    'lobby_view',
    'games_lobby_view',
    'game_view',
```

- [ ] **Step 7: Run the web suite and typecheck**

Run: `pnpm --filter @world-bingo/web test`
Expected: all green (the web unit suite is trustworthy).

Run: `pnpm --filter @world-bingo/web exec nuxt typecheck 2>&1 | grep -E 'useAnalytics|store/auth|posthog' || echo "no analytics errors"`
Expected: `no analytics errors`.

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/event.service.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/composables/useAnalytics.ts apps/web/composables/useAnalytics.test.ts apps/web/store/auth.ts apps/web/pages/profile.vue apps/api/src/services/event.service.ts
git commit -m "feat(web): dual-sink analytics adapter, identify on every login path, reset on logout"
```

---

### Task 9: Backfill mappers and CLI

**Files:**
- Create: `apps/api/src/lib/posthog-backfill.ts`
- Create: `apps/api/src/test/posthog-backfill.test.ts`
- Create: `apps/api/scripts/posthog-backfill.ts`
- Modify: `apps/api/package.json` (scripts)

**Interfaces:**
- Consumes: `gameOutcomeEvents`, `withdrawalMethodFromNote`, `personPropsFor` (Task 2).
- Produces (all pure):
  - `deterministicUuid(name: string): string` — RFC 4122 v5 under a fixed namespace.
  - `interface BackfillEvent { distinctId: string; event: string; properties: Record<string, unknown>; timestamp: Date; uuid: string }`
  - `interface BackfillAlias { distinctId: string; alias: string }`
  - `userEvents(u: UserRow): BackfillEvent[]`
  - `depositEvents(t: TxRow, knownMethods: Set<string>): BackfillEvent[]`
  - `withdrawalEvents(t: TxRow): BackfillEvent[]`
  - `bonusEvent(t: TxRow): BackfillEvent | null`
  - `gameJoinedEvents(game: GameRow, entrants: Entrant[]): BackfillEvent[]`
  - `gameFinishedEvents(game: GameRow, entrants: Entrant[]): BackfillEvent[]`
  - `gameRefundedEvents(game: GameRow, refunds: Array<{ userId: string; amount: number }>): BackfillEvent[]`
  - `analyticsEventRow(e: AnalyticsRow): BackfillEvent | BackfillAlias | null`
  - `BONUS_SOURCE_BY_TYPE: Record<string, string>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/test/posthog-backfill.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
    deterministicUuid,
    userEvents,
    depositEvents,
    withdrawalEvents,
    bonusEvent,
    gameJoinedEvents,
    gameFinishedEvents,
    gameRefundedEvents,
    analyticsEventRow,
} from '../lib/posthog-backfill'

const T0 = new Date('2026-04-01T10:00:00Z')

describe('deterministicUuid', () => {
    it('is stable for the same name and a valid v5 uuid', () => {
        const a = deterministicUuid('tx:1:deposit_submitted')
        expect(a).toBe(deterministicUuid('tx:1:deposit_submitted'))
        expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    })
    it('differs per event name', () => {
        expect(deterministicUuid('tx:1:deposit_submitted')).not.toBe(deterministicUuid('tx:1:deposit_approved'))
    })
})

describe('userEvents', () => {
    it('emits user_registered with person props', () => {
        const [ev] = userEvents({ id: 'u1', serial: 5, telegramId: null, referredById: 'r', createdAt: T0 })
        expect(ev.event).toBe('user_registered')
        expect(ev.distinctId).toBe('u1')
        expect(ev.timestamp).toBe(T0)
        expect(ev.properties).toEqual({
            signup_method: 'phone',
            referred: true,
            backfilled: true,
            $set: { serial: 5, signup_method: 'phone', referred: true, created_at: T0.toISOString() },
        })
        expect(ev.uuid).toBe(deterministicUuid('user:u1:user_registered'))
    })
    it('marks telegram users', () => {
        const [ev] = userEvents({ id: 'u2', serial: 6, telegramId: '77', referredById: null, createdAt: T0 })
        expect(ev.properties.signup_method).toBe('telegram')
    })
})

describe('depositEvents', () => {
    const known = new Set(['telebirr', 'cbe'])
    const row = { id: 't1', userId: 'u1', type: 'DEPOSIT', amount: '500.00', status: 'APPROVED', note: 'telebirr', gateway: null, referenceId: null, createdAt: T0 }

    it('emits submitted then approved one second later with null timing', () => {
        const evs = depositEvents(row, known)
        expect(evs.map((e) => e.event)).toEqual(['deposit_submitted', 'deposit_approved'])
        expect(evs[0].properties).toEqual({ amount: 500, method: 'telebirr', gateway: 'manual', tx_id: 't1', backfilled: true })
        expect(evs[1].timestamp.getTime()).toBe(T0.getTime() + 1000)
        expect(evs[1].properties).toMatchObject({ hours_to_approve: null, is_first_deposit: null, backfilled: true })
    })
    it('emits rejected for REJECTED rows and drops an unknown note as the method', () => {
        const evs = depositEvents({ ...row, status: 'REJECTED', note: 'blurry receipt' }, known)
        expect(evs.map((e) => e.event)).toEqual(['deposit_submitted', 'deposit_rejected'])
        expect(evs[0].properties.method).toBeNull()
    })
    it('emits only submitted for a pending row', () => {
        expect(depositEvents({ ...row, status: 'PENDING_REVIEW' }, known).map((e) => e.event)).toEqual(['deposit_submitted'])
    })
    it('reports zarecash gateway', () => {
        expect(depositEvents({ ...row, gateway: 'zarecash' }, known)[0].properties.gateway).toBe('zarecash')
    })
})

describe('withdrawalEvents', () => {
    const row = { id: 'w1', userId: 'u1', type: 'WITHDRAWAL', amount: '200', status: 'APPROVED', note: 'cbe: 1000123456', gateway: null, referenceId: null, createdAt: T0 }
    it('emits requested then approved, method only', () => {
        const evs = withdrawalEvents(row)
        expect(evs.map((e) => e.event)).toEqual(['withdrawal_requested', 'withdrawal_approved'])
        expect(evs[0].properties).toEqual({ amount: 200, method: 'cbe', gateway: 'manual', tx_id: 'w1', backfilled: true })
        expect(JSON.stringify(evs)).not.toContain('1000123456')
    })
    it('emits rejected for REJECTED rows', () => {
        expect(withdrawalEvents({ ...row, status: 'REJECTED' }).map((e) => e.event)).toEqual(['withdrawal_requested', 'withdrawal_rejected'])
    })
})

describe('bonusEvent', () => {
    it('maps bonus transaction types to sources', () => {
        const ev = bonusEvent({ id: 'b1', userId: 'u1', type: 'CASHBACK_BONUS', amount: '25', status: 'APPROVED', note: null, gateway: null, referenceId: 'promo-1', createdAt: T0 })
        expect(ev?.event).toBe('bonus_granted')
        expect(ev?.properties).toEqual({ amount: 25, source: 'CASHBACK', rule_id: 'promo-1', backfilled: true })
    })
    it('ignores non-bonus and non-positive rows', () => {
        expect(bonusEvent({ id: 'x', userId: 'u1', type: 'DEPOSIT', amount: '5', status: 'APPROVED', note: null, gateway: null, referenceId: null, createdAt: T0 })).toBeNull()
        expect(bonusEvent({ id: 'y', userId: 'u1', type: 'ADMIN_BONUS_ADJUSTMENT', amount: '-5', status: 'APPROVED', note: null, gateway: null, referenceId: null, createdAt: T0 })).toBeNull()
    })
})

const game = { id: 'g1', templateId: 't1', ticketPrice: '50', houseEdgePct: '10', status: 'COMPLETED', winnerId: 'w', createdAt: T0, startedAt: T0, endedAt: new Date(T0.getTime() + 90_000) }
const entrants = [
    { userId: 'w', cartelas: 1, firstJoinedAt: T0 },
    { userId: 'l', cartelas: 2, firstJoinedAt: new Date(T0.getTime() + 5000) },
]

describe('gameJoinedEvents', () => {
    it('emits one game_joined per player at their first join', () => {
        const evs = gameJoinedEvents(game, entrants)
        expect(evs).toHaveLength(2)
        expect(evs[1]).toMatchObject({
            distinctId: 'l',
            event: 'game_joined',
            timestamp: entrants[1].firstJoinedAt,
            properties: { game_id: 'g1', template_id: 't1', ticket_price: 50, cartelas: 2, stake: 100, spend_account: null, backfilled: true },
        })
        expect(evs[1].uuid).toBe(deterministicUuid('game:g1:l:game_joined'))
    })
})

describe('gameFinishedEvents', () => {
    it('uses the pot formula and endedAt', () => {
        const evs = gameFinishedEvents(game, entrants)
        expect(evs[0].properties).toMatchObject({ outcome: 'won', prize: 135, net: 85, duration_secs: 90 })
        expect(evs[0].timestamp).toBe(game.endedAt)
    })
    it('returns nothing when endedAt is missing', () => {
        expect(gameFinishedEvents({ ...game, endedAt: null }, entrants)).toEqual([])
    })
})

describe('gameRefundedEvents', () => {
    it('emits per refunded player', () => {
        const evs = gameRefundedEvents({ ...game, status: 'CANCELLED', winnerId: null }, [{ userId: 'w', amount: 50 }])
        expect(evs[0]).toMatchObject({ event: 'game_refunded', properties: { game_id: 'g1', template_id: 't1', reason: 'backfill', refund: 50, backfilled: true } })
    })
})

describe('analyticsEventRow', () => {
    it('maps a frontend event with userId as the distinct id', () => {
        const ev = analyticsEventRow({ id: 'e1', name: 'join_click', userId: 'u1', anonId: 'a1', createdAt: T0, props: { gameId: 'g1' } })
        expect(ev).toMatchObject({ distinctId: 'u1', event: 'join_click', properties: { gameId: 'g1', backfilled: true } })
    })
    it('uses anonId when there is no user', () => {
        expect(analyticsEventRow({ id: 'e2', name: 'lobby_view', userId: null, anonId: 'a1', createdAt: T0, props: null })).toMatchObject({ distinctId: 'a1' })
    })
    it('turns identify rows into aliases and drops unusable rows', () => {
        expect(analyticsEventRow({ id: 'e3', name: 'identify', userId: 'u1', anonId: 'a1', createdAt: T0, props: null })).toEqual({ distinctId: 'u1', alias: 'a1' })
        expect(analyticsEventRow({ id: 'e4', name: 'identify', userId: null, anonId: 'a1', createdAt: T0, props: null })).toBeNull()
        expect(analyticsEventRow({ id: 'e5', name: 'lobby_view', userId: null, anonId: null, createdAt: T0, props: null })).toBeNull()
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/posthog-backfill.test.ts`
Expected: FAIL — cannot resolve `../lib/posthog-backfill`.

- [ ] **Step 3: Write the mappers**

Create `apps/api/src/lib/posthog-backfill.ts`:

```ts
/**
 * Pure row → PostHog event mappers for scripts/posthog-backfill.ts.
 *
 * Every event carries a DETERMINISTIC uuid (v5 over "source:id:event"), so
 * re-running the script after a partial failure adds nothing twice: PostHog
 * de-duplicates on uuid. Every event also carries `backfilled: true`.
 *
 * `transactions` has no decision timestamp, only createdAt. Backfilled
 * approved/rejected events are therefore stamped createdAt + 1 s (so they sort
 * after the submit) and carry `hours_to_*: null`. Decision timing is a
 * live-only metric.
 */
import { createHash } from 'crypto'
import { gameOutcomeEvents, personPropsFor, withdrawalMethodFromNote } from './posthog-events'

/** Fixed namespace so uuids are stable across machines and runs. */
export const BACKFILL_NAMESPACE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

export function deterministicUuid(name: string, namespace: string = BACKFILL_NAMESPACE): string {
    const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
    const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest()
    hash[6] = (hash[6] & 0x0f) | 0x50 // version 5
    hash[8] = (hash[8] & 0x3f) | 0x80 // RFC 4122 variant
    const hex = hash.subarray(0, 16).toString('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export interface BackfillEvent {
    distinctId: string
    event: string
    properties: Record<string, unknown>
    timestamp: Date
    uuid: string
}

export interface BackfillAlias {
    distinctId: string
    alias: string
}

export interface UserRow {
    id: string
    serial: number
    telegramId: string | null
    referredById: string | null
    createdAt: Date
}

export interface TxRow {
    id: string
    userId: string
    type: string
    amount: unknown
    status: string
    note: string | null
    gateway: string | null
    referenceId: string | null
    createdAt: Date
}

export interface GameRow {
    id: string
    templateId: string | null
    ticketPrice: unknown
    houseEdgePct: unknown
    status: string
    winnerId: string | null
    createdAt: Date
    startedAt: Date | null
    endedAt: Date | null
}

export interface Entrant {
    userId: string
    cartelas: number
    firstJoinedAt: Date
}

export interface AnalyticsRow {
    id: string
    name: string
    userId: string | null
    anonId: string | null
    createdAt: Date
    props: unknown
}

export const BONUS_SOURCE_BY_TYPE: Record<string, string> = {
    FIRST_DEPOSIT_BONUS: 'FIRST_DEPOSIT',
    CASHBACK_BONUS: 'CASHBACK',
    CAMPAIGN_BONUS: 'CAMPAIGN',
    ADMIN_BONUS_ADJUSTMENT: 'ADMIN',
}

function make(source: string, id: string, event: string, distinctId: string, timestamp: Date, properties: Record<string, unknown>): BackfillEvent {
    return {
        distinctId,
        event,
        properties: { ...properties, backfilled: true },
        timestamp,
        uuid: deterministicUuid(`${source}:${id}:${event}`),
    }
}

function plusOneSecond(d: Date): Date {
    return new Date(d.getTime() + 1000)
}

export function userEvents(u: UserRow): BackfillEvent[] {
    const signupMethod = u.telegramId ? 'telegram' : 'phone'
    return [
        make('user', u.id, 'user_registered', u.id, u.createdAt, {
            signup_method: signupMethod,
            referred: u.referredById !== null,
            $set: personPropsFor(u, signupMethod),
        }),
    ]
}

export function depositEvents(t: TxRow, knownMethods: Set<string>): BackfillEvent[] {
    const method = t.note && knownMethods.has(t.note) ? t.note : null
    const gateway = t.gateway ?? 'manual'
    const amount = Number(t.amount)
    const events = [
        make('tx', t.id, 'deposit_submitted', t.userId, t.createdAt, { amount, method, gateway, tx_id: t.id }),
    ]
    if (t.status === 'APPROVED') {
        events.push(
            make('tx', t.id, 'deposit_approved', t.userId, plusOneSecond(t.createdAt), {
                amount,
                method,
                gateway,
                hours_to_approve: null,
                is_first_deposit: null,
                tx_id: t.id,
            }),
        )
    } else if (t.status === 'REJECTED') {
        events.push(
            make('tx', t.id, 'deposit_rejected', t.userId, plusOneSecond(t.createdAt), {
                amount,
                method,
                hours_to_decision: null,
                has_note: null,
                tx_id: t.id,
            }),
        )
    }
    return events
}

export function withdrawalEvents(t: TxRow): BackfillEvent[] {
    const method = withdrawalMethodFromNote(t.note)
    const gateway = t.gateway ?? 'manual'
    const amount = Number(t.amount)
    const events = [
        make('tx', t.id, 'withdrawal_requested', t.userId, t.createdAt, { amount, method, gateway, tx_id: t.id }),
    ]
    if (t.status === 'APPROVED') {
        events.push(
            make('tx', t.id, 'withdrawal_approved', t.userId, plusOneSecond(t.createdAt), {
                amount,
                method,
                gateway,
                hours_to_decision: null,
                tx_id: t.id,
            }),
        )
    } else if (t.status === 'REJECTED') {
        events.push(
            make('tx', t.id, 'withdrawal_rejected', t.userId, plusOneSecond(t.createdAt), {
                amount,
                method,
                hours_to_decision: null,
                tx_id: t.id,
            }),
        )
    }
    return events
}

export function bonusEvent(t: TxRow): BackfillEvent | null {
    const source = BONUS_SOURCE_BY_TYPE[t.type]
    if (!source) return null
    const amount = Number(t.amount)
    if (!(amount > 0)) return null
    return make('tx', t.id, 'bonus_granted', t.userId, t.createdAt, {
        amount,
        source,
        rule_id: t.referenceId ?? null,
    })
}

export function gameJoinedEvents(game: GameRow, entrants: Entrant[]): BackfillEvent[] {
    const ticketPrice = Number(game.ticketPrice)
    return entrants.map((e) =>
        make('game', `${game.id}:${e.userId}`, 'game_joined', e.userId, e.firstJoinedAt, {
            game_id: game.id,
            template_id: game.templateId,
            ticket_price: ticketPrice,
            cartelas: e.cartelas,
            stake: Math.round(ticketPrice * e.cartelas * 100) / 100,
            spend_account: null,
        }),
    )
}

export function gameFinishedEvents(game: GameRow, entrants: Entrant[]): BackfillEvent[] {
    if (!game.endedAt) return []
    const endedAt = game.endedAt
    const ticketPrice = Number(game.ticketPrice)
    const totalEntries = entrants.reduce((s, e) => s + e.cartelas, 0)
    const prize = game.winnerId ? ticketPrice * totalEntries * (1 - Number(game.houseEdgePct) / 100) : 0
    const durationSecs = game.startedAt
        ? Math.max(0, Math.round((endedAt.getTime() - game.startedAt.getTime()) / 1000))
        : null
    return gameOutcomeEvents({
        gameId: game.id,
        templateId: game.templateId,
        ticketPrice,
        winnerId: game.winnerId,
        prize,
        durationSecs,
        entrants: entrants.map((e) => ({ userId: e.userId, cartelas: e.cartelas })),
    }).map((ev) => make('game', `${game.id}:${ev.userId}`, 'game_finished', ev.userId, endedAt, ev.properties))
}

export function gameRefundedEvents(game: GameRow, refunds: Array<{ userId: string; amount: number }>): BackfillEvent[] {
    const at = game.endedAt ?? game.createdAt
    return refunds.map((r) =>
        make('game', `${game.id}:${r.userId}`, 'game_refunded', r.userId, at, {
            game_id: game.id,
            template_id: game.templateId,
            reason: 'backfill',
            refund: r.amount,
        }),
    )
}

export function analyticsEventRow(e: AnalyticsRow): BackfillEvent | BackfillAlias | null {
    if (e.name === 'identify') {
        if (!e.userId || !e.anonId) return null
        return { distinctId: e.userId, alias: e.anonId }
    }
    const distinctId = e.userId ?? e.anonId
    if (!distinctId) return null
    const props = e.props && typeof e.props === 'object' ? (e.props as Record<string, unknown>) : {}
    return make('ae', e.id, e.name, distinctId, e.createdAt, props)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/posthog-backfill.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Write the CLI**

Create `apps/api/scripts/posthog-backfill.ts`:

```ts
/**
 * Backfill PostHog with the history already in Postgres.
 *
 * USAGE (run from apps/api/)
 *   pnpm posthog:backfill -- --since 2026-02-20 [--until 2026-09-06] [--dry-run]
 *
 * Reads POSTHOG_KEY / POSTHOG_HOST / POSTHOG_BRAND (falls back to
 * DEPLOYMENT_CODE) from the root .env. Refuses to run without a key unless
 * --dry-run is given.
 *
 * Safe to re-run: every event has a deterministic uuid and PostHog
 * de-duplicates on it. The client is created with historicalMigration so the
 * import does not count against real-time ingestion limits.
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

const client = key
    ? new PostHog(key, {
          host: process.env.POSTHOG_HOST || 'https://eu.i.posthog.com',
          historicalMigration: true,
          flushAt: 100,
          flushInterval: 1000,
      })
    : null

const counts: Record<string, number> = {}
let failed = false
if (client) {
    client.on('error', (err: unknown) => {
        failed = true
        console.error('[posthog] batch error:', err)
    })
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
    if (client) await client.shutdown()
    await prisma.$disconnect()
    console.table(counts)
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
```

- [ ] **Step 6: Add the package script and dry-run it**

In `apps/api/package.json`, add to `scripts` after `"db:studio": ...`:

```json
        "posthog:backfill": "tsx --env-file ../../.env scripts/posthog-backfill.ts",
```

(mind the trailing comma on the previous line.)

Run from `apps/api/`:

```bash
pnpm posthog:backfill -- --since 2026-01-01 --dry-run
```

Expected: a table of event counts against the local dev database and exit code 0. If the local `DATABASE_URL` is empty of data the table is empty; that is still a pass. If `client.alias` or `historicalMigration` is rejected by the type checker, check the installed `posthog-node` version's `PostHogOptions` and `alias` signature with `grep -n "historicalMigration\|alias(" node_modules/posthog-node/dist/*.d.ts` and adjust the option name — the runtime feature exists in 5.x.

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm --filter @world-bingo/api typecheck` (the `scripts/` directory is outside `src`; also run `pnpm --filter @world-bingo/api exec tsc --noEmit --skipLibCheck scripts/posthog-backfill.ts --module esnext --moduleResolution bundler --target es2022` and expect no output).

```bash
git add apps/api/src/lib/posthog-backfill.ts apps/api/src/test/posthog-backfill.test.ts apps/api/scripts/posthog-backfill.ts apps/api/package.json
git commit -m "feat(posthog): idempotent historical backfill from Postgres"
```

---

### Task 10: Deployment wiring, runbook, project notes

**Files:**
- Modify: `docker-compose.yml` (`api` env after `LOKI_LABEL_APP`; `web` env after `NUXT_PUBLIC_SENTRY_ENVIRONMENT`)
- Modify: `docker-compose.prod.yml` (same two places)
- Modify: `docker-compose.aradabingo.yml` (`api-arada`, `web-arada`)
- Modify: `docker-compose.betbawa.yml` (`api-betbawa`, `web-betbawa`)
- Modify: `docker-compose.aradabingo.staging.yml` (`api-arada-stg` env block; `web-arada-stg` after `NUXT_PUBLIC_API_BASE`)
- Modify: `docker-compose.betbawa.staging.yml` (`api-betbawa-stg`; `web-betbawa-stg`)
- Modify: `.env.example` (root, after `LOKI_LABEL_APP`)
- Create: `docs/posthog.md`
- Modify: `CLAUDE.md:111-118`

- [ ] **Step 1: Compose env passthrough**

In each of the six compose files, add to the **api** service's `environment:` block (directly after its `LOKI_LABEL_APP` line, or after `DEPLOYMENT_CODE` in the staging files which have no Loki line):

```yaml
      POSTHOG_KEY: ${POSTHOG_KEY:-}
      POSTHOG_HOST: ${POSTHOG_HOST:-https://eu.i.posthog.com}
      POSTHOG_BRAND: ${POSTHOG_BRAND:-}
```

and to the **web** service's `environment:` block (directly after its `NUXT_PUBLIC_SENTRY_ENVIRONMENT` line, or after `NUXT_PUBLIC_API_BASE` in the staging files). **Not** the admin service:

```yaml
      NUXT_PUBLIC_POSTHOG_KEY: ${NUXT_PUBLIC_POSTHOG_KEY:-}
      NUXT_PUBLIC_POSTHOG_HOST: ${NUXT_PUBLIC_POSTHOG_HOST:-/ingest}
      NUXT_PUBLIC_POSTHOG_UI_HOST: ${NUXT_PUBLIC_POSTHOG_UI_HOST:-https://eu.posthog.com}
      NUXT_PUBLIC_POSTHOG_REPLAY: ${NUXT_PUBLIC_POSTHOG_REPLAY:-true}
      NUXT_PUBLIC_POSTHOG_BRAND: ${NUXT_PUBLIC_POSTHOG_BRAND:-}
```

For the brand files set the brand default inline instead of empty: `POSTHOG_BRAND: ${POSTHOG_BRAND:-arada}` / `NUXT_PUBLIC_POSTHOG_BRAND: ${NUXT_PUBLIC_POSTHOG_BRAND:-arada}` in the two `aradabingo` files and `betbawa` in the two `betbawa` files.

Verify every file still parses:

```bash
for f in docker-compose.yml docker-compose.prod.yml docker-compose.aradabingo.yml docker-compose.betbawa.yml docker-compose.aradabingo.staging.yml docker-compose.betbawa.staging.yml; do docker compose -f "$f" config -q && echo "ok $f"; done
```

Expected: six `ok` lines. (`docker compose config` needs the env vars the file references; if it complains about a missing required variable unrelated to PostHog, run it with `--env-file .env.example`.)

- [ ] **Step 2: Root env example**

In the root `.env.example`, after `LOKI_LABEL_APP=world-bingo-api` add:

```bash

# --- Product analytics (PostHog Cloud EU) ---
# Empty keys → PostHog is completely inert in both the API and the web app.
# One project per environment; brands are split by the `brand` property.
# API (server-side money and game events):
POSTHOG_KEY=
POSTHOG_HOST=https://eu.i.posthog.com
POSTHOG_BRAND=                        # arada | betbawa — falls back to DEPLOYMENT_CODE
# Web (browser events + session replay, proxied through /ingest):
NUXT_PUBLIC_POSTHOG_KEY=
NUXT_PUBLIC_POSTHOG_HOST=/ingest
NUXT_PUBLIC_POSTHOG_UI_HOST=https://eu.posthog.com
NUXT_PUBLIC_POSTHOG_REPLAY=true
NUXT_PUBLIC_POSTHOG_BRAND=
# See docs/posthog.md for setup, the backfill, and the churn dashboard.
```

- [ ] **Step 3: The runbook**

Create `docs/posthog.md`:

````markdown
# World Bingo — PostHog Product Analytics Runbook

> **Scope:** browser events, session replay, server-side money and game events, and the
> historical backfill. **Golden rule:** every integration is **env-gated and a no-op when
> unset** — an empty key means no script, no events, no cost.
>
> Design: `docs/superpowers/specs/2026-09-06-posthog-product-analytics-design.md`.
> The June analytics pipeline (`analytics_events`, admin `/analytics`) is unchanged and still
> fed; PostHog sits beside it.

## 1. Create the project

1. Sign up at https://eu.posthog.com (EU Cloud; the free tier covers 1M events and 5k
   replays a month). One project per environment (`production`, `staging`). Both brands share
   a project and are split by the `brand` property.
2. Project → Settings → copy the **Project API key** (`phc_…`). It is safe to expose to the
   browser; it can only write events.
3. Fill the env vars in Dokploy (or `.env`) for **both** the api and web services:

   | var | where | value |
   |---|---|---|
   | `POSTHOG_KEY` | api | `phc_…` |
   | `POSTHOG_BRAND` | api | `arada` or `betbawa` |
   | `NUXT_PUBLIC_POSTHOG_KEY` | web | the same `phc_…` |
   | `NUXT_PUBLIC_POSTHOG_BRAND` | web | `arada` or `betbawa` |

   Everything else has a working default (`/ingest` proxy, EU hosts, replay on).
4. Redeploy api and web. The api logs `[posthog] product analytics enabled` at boot.

## 2. Verify

- Open the player app, browse the lobby, log in. In PostHog → **Activity** you should see
  `$pageview`, `lobby_view`, `user_logged_in` for a person whose distinct id is a UUID with
  `serial`, `brand`, `signup_method` set — and **no** phone number anywhere.
- Network tab: events go to `https://<your-domain>/ingest/…`, never to `posthog.com`
  directly. If they do not, the Nuxt image was built without the default proxy targets.
- **Session replay** → a recording appears within a minute. Every input is masked; the
  profile page's phone line is masked (`data-ph-mask`); uploaded receipts are black boxes.
- Turn replay off without a rebuild: `NUXT_PUBLIC_POSTHOG_REPLAY=false`, redeploy web.

## 3. Event catalog

**Server (authoritative, `apps/api`)** — every one carries `brand`; bots and staff are
dropped before send.

| event | when | key properties |
|---|---|---|
| `user_registered` | phone register, first Telegram auth | `signup_method`, `referred`; sets person `serial`, `created_at` |
| `user_logged_in` | login, returning Telegram auth | `signup_method` |
| `deposit_submitted` | manual receipt or ZareCash checkout row created | `amount`, `method`, `gateway`, `tx_id` |
| `deposit_approved` | credited (manual review or webhook) | `amount`, `method`, `gateway`, `hours_to_approve`, `is_first_deposit` |
| `deposit_rejected` | admin rejected | `amount`, `method`, `hours_to_decision`, `has_note` |
| `withdrawal_requested` / `withdrawal_approved` / `withdrawal_rejected` | payout lifecycle | `amount`, `method`, `gateway`, `hours_to_decision` |
| `game_joined` / `game_left` | cartelas bought / refunded before start | `game_id`, `template_id`, `ticket_price`, `cartelas`, `stake`, `spend_account` |
| `game_finished` | one per player when a game ends | `outcome` (`won`/`lost`/`no_winner`), `stake`, `prize`, `net`, `duration_secs` |
| `game_refunded` | game cancelled | `reason`, `refund` |
| `bonus_granted` | any bonus credit | `amount`, `source` (`FIRST_DEPOSIT`/`DEPOSIT_RULE`/`CAMPAIGN`/`CASHBACK`/`ADMIN`), `rule_id` |
| `account_status_changed` | restrict / suspend / reinstate | `from`, `to`, `category`, `has_expiry` |
| `provider_game_launched` | third-party game opened | `provider_code`, `game_code` |

**Browser (`apps/web`)** — `$pageview`, `$pageleave`, plus everything `useAnalytics().track()`
already sent: `lobby_view`, `games_lobby_view`, `game_view`, `join_click`,
`deposit_modal_opened`, `deposit_method_selected`, `deposit_amount_entered`,
`provider_game_view`, `provider_session_ended`, `hero_predictions_click`,
`lobby_predictions_click`. Super properties on all of them: `brand`, `locale`, `is_pwa`.

`track()` sends **any** name to PostHog; only the allowlisted names above also reach the
custom `/events` endpoint. Add a new browser event by calling `track('new_name', {...})` —
no list to update unless the admin page needs it too.

## 4. Backfill history (once per environment)

Turns existing rows into historical events so retention and lifecycle charts have months of
data on day one. Re-runnable: every event has a deterministic uuid and PostHog de-duplicates.

```bash
cd apps/api
pnpm posthog:backfill -- --since 2026-02-20 --dry-run      # counts only, no network
pnpm posthog:backfill -- --since 2026-02-20                # sends, using POSTHOG_KEY from the root .env
```

Run it **from a machine that can reach the production database** with that environment's
`DATABASE_URL`, `POSTHOG_KEY` and `POSTHOG_BRAND` in the root `.env`. Takes minutes, not hours,
at current volume. Run once per brand (each brand has its own database).

What it sends: `user_registered`, deposit/withdrawal lifecycles, `bonus_granted`,
`game_joined` / `game_finished` / `game_refunded`, every row of `analytics_events`, and an
alias linking each anonymous id to the user that later identified. Every backfilled event has
`backfilled: true`. **Decision timing (`hours_to_*`) is null on backfilled events** — the
transactions table records when a row was created, not when it was decided. Those charts start
from the deploy date.

Historical imports show up in PostHog with a delay (minutes to an hour) and are billed as an
import, not as live events.

## 5. The churn dashboard — six insights to build

Create a dashboard "Why are players declining" with these, in this order. Filter every one
by `brand` when comparing brands. Exclude `backfilled = true` from the timing charts (4).

1. **Lifecycle** — Insight type *Lifecycle*, event `game_joined`, weekly. New vs returning vs
   resurrecting vs dormant. Read this first: it says whether the decline is fewer new players
   (acquisition) or more dormant ones (retention).
2. **Retention** — Insight type *Retention*, cohortizing on `user_registered`, returning on
   `game_joined`, weekly, 8 periods. Cross-check against the admin page's cohort matrix.
3. **Acquisition funnel** — *Funnel*: `$pageview` → `user_registered` → `deposit_approved` →
   `game_joined` → `game_joined` (second time), 7-day conversion window, breakdown by
   `signup_method`. The biggest drop is the biggest problem.
4. **Money friction** — two *Trends*: (a) `deposit_rejected` ÷ `deposit_submitted` as a
   formula, breakdown by `method`; (b) median `hours_to_approve` on `deposit_approved` and
   median `hours_to_decision` on `withdrawal_approved`. Slow or failed money is the usual
   first suspect.
5. **"Lost and left" cohort** — *Cohort*: performed `game_finished` where `outcome = lost`
   ≥ 3 times in the last 7 days **and** did not perform `game_joined` in the last 7 days.
   Chart its size weekly. Then open **Session replay**, filter by this cohort, watch ten.
6. **Deposited, never played** — *Session replay* filter: persons who performed
   `deposit_approved` in the last 7 days and did not perform `game_joined` within 24 h.
   Watch ten. This is the fastest way to find a broken screen.

Supporting cuts worth a saved insight each: `game_finished` breakdown by `template_id`
(which games lose players), `account_status_changed` trend (are suspensions rising),
`is_pwa` breakdown on retention (does the installed app retain better).

## 6. Privacy and cost guardrails

- Distinct id is the user UUID. Phone, names, Telegram handles, account numbers, receipt URLs
  and reviewer notes are never sent — by construction in `lib/posthog-events.ts` and
  `utils/posthog.ts`. Keep it that way when adding events.
- Replay masks all inputs (`maskAllInputs`), anything with `data-ph-mask`, and blocks
  `/uploads/` images. Add `data-ph-mask` to any new element that renders a phone or account
  number as text.
- `autocapture` is off. Volume is the named events only; a busy month is well under the
  free tier. Check Settings → Billing monthly.
- To stop everything: clear the two keys and redeploy. Nothing else needs to change.

## 7. Where the code lives

| file | role |
|---|---|
| `apps/web/plugins/02.posthog.client.ts` | SDK init, super props, identify on hydrate |
| `apps/web/composables/useAnalytics.ts` | `track` / `identify` / `reset` dual-sink adapter |
| `apps/web/utils/posthog.ts` | pure helpers (person props, replay flag, brand slug) |
| `apps/web/nuxt.config.ts` | `runtimeConfig.public.posthog`, `/ingest/**` proxy rules |
| `apps/api/src/lib/posthog.ts` | env-gated client, bot/staff exclusion, `captureEvent` |
| `apps/api/src/lib/posthog-events.ts` | `emitDepositApproved`, `emitGameFinished`, `emitGameRefunded` |
| `apps/api/src/lib/posthog-backfill.ts` + `scripts/posthog-backfill.ts` | historical import |
````

- [ ] **Step 4: CLAUDE.md pointer**

In `CLAUDE.md`, after the line `- **Uptime Kuma** — external uptime checks.` add:

```markdown
- **PostHog** — product analytics (browser events, session replay, server-side money/game events). Env-gated by `POSTHOG_KEY` / `NUXT_PUBLIC_POSTHOG_KEY`; see `docs/posthog.md`.
```

- [ ] **Step 5: Full verification pass**

Run, and record the results in the commit message body if anything is red for a pre-existing reason:

```bash
pnpm --filter @world-bingo/api exec vitest run src/test/posthog.test.ts src/test/posthog-events.test.ts src/test/posthog-auth-hooks.test.ts src/test/posthog-wallet-hooks.test.ts src/test/posthog-game-hooks.test.ts src/test/posthog-status-hook.test.ts src/test/posthog-backfill.test.ts
pnpm --filter @world-bingo/web test
pnpm --filter @world-bingo/api typecheck
pnpm --filter @world-bingo/api lint
pnpm --filter @world-bingo/web lint
```

Expected: the seven API PostHog files PASS; the web suite is green; typecheck clean; lint reports nothing in files this branch touched.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml docker-compose.prod.yml docker-compose.aradabingo.yml docker-compose.betbawa.yml docker-compose.aradabingo.staging.yml docker-compose.betbawa.staging.yml .env.example docs/posthog.md CLAUDE.md
git commit -m "docs(posthog): runbook, churn dashboard recipe, and deploy env wiring"
```

---

## Plan self-review

**Spec coverage.** Client SDK + proxy + replay + super props + identify/reset → Tasks 7-8. Adapter and the three defects (`games_lobby_view`, Telegram identify, anon rotation) → Task 8. Server client, bot/staff exclusion, shutdown → Task 1. Every row of the server event catalog → Tasks 2-6 (`user_*` 3; deposits/withdrawals/deposit-side bonuses 4; games 5; campaign/cashback/admin bonuses, account status, provider launch 6). Backfill with deterministic uuids and `historicalMigration` → Task 9. Env vars, compose files, Dockerfile args, runbook with six insights, CLAUDE.md → Tasks 1, 7, 10. Privacy: person props helpers never take phone/name; `data-ph-mask` → Tasks 7-8. Testing section → every task has tests except the four one-line bonus/provider hooks in Task 6, which are typecheck-verified and share the `captureEvent` contract tested in Task 1.

**Type consistency.** `captureEvent(userId, event, props?, { set?, timestamp? })` used identically in Tasks 3-6 and 9. `emitDepositApproved(txId)`, `emitGameFinished(gameId)`, `emitGameRefunded(gameId, templateId, refunds, reason)` match between Task 2 and their call sites in 4-5. `useAnalytics().identify(user)` takes `{ id, serial, telegramId?, createdAt }`, which the `User` type in `store/auth.ts` satisfies. `runtimeConfig.public.posthog.{key,host,uiHost,replay,brand}` is read with those names in both the plugin and the composable.

**Placeholders.** None: every code step carries the code; every run step carries the command and the expected outcome.
