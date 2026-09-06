# Stop Forced Logouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the player app from logging people out during normal use, so a session ends only when a refresh token is genuinely invalid or expired.

**Architecture:** The server keeps rotated refresh tokens for a 60-second grace window and claims rotation atomically, so concurrent refreshes from one device all succeed instead of one winning and the rest 401ing or crashing. The web store funnels every refresh through one shared in-flight promise, clears the session only on a definitive server code, and refreshes proactively before the access token expires. Rate limits key on the token or the user instead of the IP.

**Tech Stack:** Fastify v5, Prisma 5, `@fastify/rate-limit`, prom-client, Nuxt 3 + Pinia, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-06-retention-program-design.md` (Project 1)

## Global Constraints

- Measured cause, from live metrics since the last API restart: 194 refresh attempts, 125 rotated, **64 → 401**, **4 → 500**. Every one of those 68 ended a player's session.
- A session may be cleared **only** on `refresh_token_invalid` or `refresh_token_expired` from the server. Network errors, timeouts, 429 and every 5xx leave the session intact and rethrow the original error.
- `AuthService.refreshToken` must never throw Prisma `P2025`. Rotation is claimed with a conditional `updateMany`, never a bare `delete`.
- The grace window is **60 seconds**, defined once as an exported constant, used by both the service and its tests.
- Analytics helpers stay fire-and-forget: `void captureEvent(...)`, never awaited, never on a path that can fail a request.
- No event or log line may carry a refresh token, an access token, a token hash, a phone number or a password.
- Formatting: Prettier singleQuote, no semicolons, trailingComma all. 4-space indent in `apps/api`, 2-space in `apps/web/store`, `apps/web/utils`, `apps/web/composables`.
- Import style in `apps/api`: relative imports without a `.js` suffix in new files; match the file when editing an existing one.
- Test commands: API `pnpm --filter @world-bingo/api exec vitest run src/test/<file>.test.ts` (needs local Postgres on 5432 and `DATABASE_URL_TEST` in the root `.env`; both present). Web `pnpm --filter @world-bingo/web exec vitest run <path>`.
- The API suite carries ~22 known environmental failures in 5 files (`game-state`, `integration`, `admin-featured-games`, `withdrawal.service`, `settings.service`). Judge a task by the files it names. To baseline: `git switch main`, run just those files, `git switch -`.
- Web unit tests touching `localStorage`/`sessionStorage` need the guarded Storage polyfill (Node 25 shadows jsdom's); copy the block at the top of `apps/web/composables/useAnalytics.test.ts`.
- Commit after every task, Conventional Commit subject, no attribution trailers.
- Work on branch `feat/retention-program` (already created; the spec is committed at `b2029a5`).

---

## File map

| File | Action | Task |
|---|---|---|
| `apps/api/prisma/schema.prisma` | modify: `RefreshToken.rotatedAt`, `.replacedByHash`, index | 1 |
| `apps/api/prisma/migrations/<ts>_refresh_token_grace/` | create: generated migration | 1 |
| `apps/api/src/lib/metrics.ts` | modify: `wbAuthRefreshTotal` | 1 |
| `apps/api/src/services/auth.service.ts` | modify: `refreshToken` rewrite, `REFRESH_GRACE_MS` | 2 |
| `apps/api/src/test/auth-refresh-grace.test.ts` | create | 2 |
| `apps/api/src/index.ts` | modify: error handler codes, global limiter key | 3 |
| `apps/api/src/routes/auth/index.ts` | modify: `/auth/refresh` limiter keyed by token | 3 |
| `apps/api/src/test/auth-refresh-limits.test.ts` | create | 3 |
| `apps/web/utils/token.ts` | create: `tokenExpiryMs`, `isExpiringWithin` | 4 |
| `apps/web/utils/token.test.ts` | create | 4 |
| `apps/web/store/auth.ts` | modify: single-flight refresh, definitive-code logout, proactive refresh | 5 |
| `apps/web/store/auth.test.ts` | create | 5 |
| `apps/web/composables/useSocket.ts` | modify: use the shared helper | 6 |
| `apps/api/src/services/event.service.ts` | modify: allowlist the two new names | 6 |
| `docs/posthog.md` | modify: document `session_expired`, `session_refresh_failed` | 6 |

---

### Task 1: Schema, migration and the refresh metric

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (`model RefreshToken`, around line 253)
- Create: `apps/api/prisma/migrations/<timestamp>_refresh_token_grace/migration.sql` (generated)
- Modify: `apps/api/src/lib/metrics.ts` (append near `wbWithdrawalsTotal`, around line 88)

**Interfaces:**
- Produces: `RefreshToken.rotatedAt: DateTime?`, `RefreshToken.replacedByHash: String?`; `wbAuthRefreshTotal` (Counter, label `outcome`).

- [ ] **Step 1: Extend the model**

In `apps/api/prisma/schema.prisma`, replace the `RefreshToken` model with:

```prisma
model RefreshToken {
  id        String   @id @default(uuid())
  userId    String
  tokenHash String   @unique
  expiresAt DateTime
  createdAt DateTime @default(now())
  /// Set when this token has been exchanged. The row is KEPT for a short grace
  /// window (REFRESH_GRACE_MS in auth.service.ts) rather than deleted, so a
  /// device that fires several refreshes at once — the lobby's parallel calls
  /// all 401ing together — gets a working session on every one of them instead
  /// of one winner and N logouts. Reuse after the window is a genuine replay
  /// and is rejected.
  rotatedAt DateTime?
  /// Hash of the token issued in exchange. Audit only; never returned to a client.
  replacedByHash String?
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([expiresAt])
  @@index([rotatedAt])
  @@map("refresh_tokens")
}
```

- [ ] **Step 2: Generate the migration**

Run from `apps/api/`:

```bash
pnpm exec prisma migrate dev --name refresh_token_grace --env-file ../../.env
```

Expected: a new folder under `prisma/migrations/` whose `migration.sql` contains `ADD COLUMN "rotatedAt"`, `ADD COLUMN "replacedByHash"` and a `CREATE INDEX` on `rotatedAt`. Both columns are nullable, so the migration is additive and safe on a live table.

- [ ] **Step 3: Add the metric**

In `apps/api/src/lib/metrics.ts`, directly after the `wbWithdrawalsTotal` block, add:

```ts
/**
 * Refresh-token outcomes. `grace` means a concurrent refresh from the same
 * device was served from the rotation grace window instead of being rejected —
 * before that window existed, every one of those was a forced logout.
 */
export const wbAuthRefreshTotal = new Counter({
    name: 'wb_auth_refresh_total',
    help: 'Refresh token outcomes, by result',
    labelNames: ['outcome'] as const,
    registers: [register],
})
```

- [ ] **Step 4: Verify the client and metric compile**

Run from the repo root:

```bash
pnpm --filter @world-bingo/api exec prisma generate && pnpm --filter @world-bingo/api typecheck
```

Expected: generate succeeds; typecheck prints no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/src/lib/metrics.ts
git commit -m "feat(auth): keep rotated refresh tokens for a grace window"
```

---

### Task 2: Atomic rotation with a grace window

**Files:**
- Modify: `apps/api/src/services/auth.service.ts` (`refreshToken`, around line 124)
- Create: `apps/api/src/test/auth-refresh-grace.test.ts`

**Interfaces:**
- Consumes: `wbAuthRefreshTotal` (Task 1).
- Produces:
  - `export const REFRESH_GRACE_MS = 60_000`
  - `export class RefreshTokenError extends Error { code: 'refresh_token_invalid' | 'refresh_token_expired'; statusCode = 401 }`
  - `AuthService.refreshToken(token: string): Promise<{ user, refreshToken }>` — unchanged signature, new failure modes.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/auth-refresh-grace.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))

import { AuthService, REFRESH_GRACE_MS, RefreshTokenError } from '../services/auth.service'
import { prisma } from './setup'

let userId: string

beforeEach(async () => {
    vi.clearAllMocks()
    const { user } = await AuthService.register({
        username: 'refresh_user',
        phone: '+251977100001',
        password: 'password123',
    })
    userId = user.id
})

async function issueToken(): Promise<string> {
    const { refreshToken } = await AuthService.login({
        identifier: 'refresh_user',
        password: 'password123',
    })
    return refreshToken
}

describe('AuthService.refreshToken', () => {
    it('rotates a valid token and returns a different one', async () => {
        const first = await issueToken()
        const { refreshToken: second } = await AuthService.refreshToken(first)
        expect(second).not.toBe(first)
        const rows = await prisma.refreshToken.findMany({ where: { userId } })
        // the rotated row is kept, not deleted
        expect(rows.filter((r) => r.rotatedAt !== null)).toHaveLength(1)
        expect(rows.filter((r) => r.rotatedAt === null)).toHaveLength(1)
    })

    it('serves concurrent refreshes of the same token — the whole point', async () => {
        const token = await issueToken()
        const results = await Promise.all([
            AuthService.refreshToken(token),
            AuthService.refreshToken(token),
            AuthService.refreshToken(token),
        ])
        const issued = results.map((r) => r.refreshToken)
        expect(new Set(issued).size).toBe(3)
        for (const r of results) expect(r.user.id).toBe(userId)
    })

    it('never throws P2025 when two refreshes race', async () => {
        const token = await issueToken()
        const settled = await Promise.allSettled([
            AuthService.refreshToken(token),
            AuthService.refreshToken(token),
        ])
        expect(settled.every((s) => s.status === 'fulfilled')).toBe(true)
    })

    it('rejects reuse once the grace window has passed', async () => {
        const token = await issueToken()
        await AuthService.refreshToken(token)
        const stale = new Date(Date.now() - REFRESH_GRACE_MS - 1000)
        await prisma.refreshToken.updateMany({ where: { rotatedAt: { not: null } }, data: { rotatedAt: stale } })
        await expect(AuthService.refreshToken(token)).rejects.toMatchObject({
            code: 'refresh_token_invalid',
            statusCode: 401,
        })
    })

    it('rejects an unknown token as invalid', async () => {
        await expect(AuthService.refreshToken('not-a-real-token')).rejects.toBeInstanceOf(RefreshTokenError)
        await expect(AuthService.refreshToken('not-a-real-token')).rejects.toMatchObject({
            code: 'refresh_token_invalid',
        })
    })

    it('rejects an expired token with its own code and removes the row', async () => {
        const token = await issueToken()
        await prisma.refreshToken.updateMany({
            where: { rotatedAt: null },
            data: { expiresAt: new Date(Date.now() - 1000) },
        })
        await expect(AuthService.refreshToken(token)).rejects.toMatchObject({
            code: 'refresh_token_expired',
        })
        expect(await prisma.refreshToken.count({ where: { userId, rotatedAt: null } })).toBe(0)
    })

    it('prunes rotated rows older than the grace window on the next refresh', async () => {
        const first = await issueToken()
        const { refreshToken: second } = await AuthService.refreshToken(first)
        await prisma.refreshToken.updateMany({
            where: { rotatedAt: { not: null } },
            data: { rotatedAt: new Date(Date.now() - 10 * 60_000) },
        })
        await AuthService.refreshToken(second)
        const stale = await prisma.refreshToken.count({
            where: { userId, rotatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
        })
        expect(stale).toBe(0)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/auth-refresh-grace.test.ts`
Expected: FAIL — `REFRESH_GRACE_MS` and `RefreshTokenError` are not exported; the concurrency test rejects.

- [ ] **Step 3: Rewrite `refreshToken`**

In `apps/api/src/services/auth.service.ts`, add to the imports:

```ts
import { captureEvent } from '../lib/posthog'
import { wbAuthRefreshTotal } from '../lib/metrics'
```

Directly under `const REFRESH_TOKEN_EXPIRY_DAYS = 30`, add:

```ts
/**
 * How long a rotated refresh token keeps working. The web app fires several
 * authenticated calls at once (the lobby loads bingo and provider games in
 * parallel); when the 15-minute access token expires they all 401 together and
 * each one refreshes with the same stored token. Without this window exactly
 * one of them won and every other caller was logged out — 64 of 194 refreshes
 * in one 4-hour production sample, plus 4 crashes from the delete/create race.
 *
 * A minute is long enough to cover that burst and a slow mobile round trip, and
 * short enough that a genuinely stolen token is useless.
 */
export const REFRESH_GRACE_MS = 60_000

/** Rotated rows are pruned once they are this old — long past any live burst. */
const REFRESH_PRUNE_MS = 5 * 60_000

/**
 * A refusal the client can act on. `code` is what the web store keys its
 * "really log out" decision on: anything else (network, 429, 5xx) must leave
 * the session alone.
 */
export class RefreshTokenError extends Error {
    readonly statusCode = 401
    constructor(readonly code: 'refresh_token_invalid' | 'refresh_token_expired', message: string) {
        super(message)
        this.name = 'RefreshTokenError'
    }
}
```

Replace the whole body of `static async refreshToken(token: string)` with:

```ts
    static async refreshToken(token: string) {
        const tokenHash = hashToken(token)

        const storedToken = await prisma.refreshToken.findUnique({
            where: { tokenHash },
            include: { user: true },
        })

        if (!storedToken) {
            wbAuthRefreshTotal.labels('invalid').inc()
            throw new RefreshTokenError('refresh_token_invalid', 'Invalid refresh token')
        }

        if (storedToken.expiresAt < new Date()) {
            await prisma.refreshToken.deleteMany({ where: { tokenHash } })
            wbAuthRefreshTotal.labels('expired').inc()
            throw new RefreshTokenError('refresh_token_expired', 'Refresh token expired')
        }

        const newRefreshToken = generateRefreshToken()
        const newTokenHash = hashToken(newRefreshToken)
        const newExpiresAt = new Date()
        newExpiresAt.setDate(newExpiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS)

        // Claim the rotation. `rotatedAt: null` in the WHERE makes this atomic:
        // concurrent callers serialize on the row and exactly one gets count 1.
        // The loser is NOT an error — see the grace branch below.
        const claim = await prisma.refreshToken.updateMany({
            where: { tokenHash, rotatedAt: null },
            data: { rotatedAt: new Date(), replacedByHash: newTokenHash },
        })

        if (claim.count === 0) {
            const rotatedAt = storedToken.rotatedAt ?? new Date(0)
            if (Date.now() - rotatedAt.getTime() > REFRESH_GRACE_MS) {
                wbAuthRefreshTotal.labels('invalid').inc()
                throw new RefreshTokenError('refresh_token_invalid', 'Invalid refresh token')
            }
            wbAuthRefreshTotal.labels('grace').inc()
        } else {
            wbAuthRefreshTotal.labels('rotated').inc()
        }

        await prisma.refreshToken.create({
            data: { userId: storedToken.userId, tokenHash: newTokenHash, expiresAt: newExpiresAt },
        })

        // Housekeeping, not correctness: keeps one live row per device plus at
        // most a few seconds of rotated ones. Never blocks the response.
        prisma.refreshToken
            .deleteMany({
                where: {
                    userId: storedToken.userId,
                    rotatedAt: { lt: new Date(Date.now() - REFRESH_PRUNE_MS) },
                },
            })
            .catch(() => {})

        const { passwordHash: _, ...user } = storedToken.user
        return { user, refreshToken: newRefreshToken }
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/auth-refresh-grace.test.ts src/test/auth.service.test.ts`
Expected: the new file PASSES (7 tests); `auth.service.test.ts` matches its count on `main`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/auth.service.ts apps/api/src/test/auth-refresh-grace.test.ts
git commit -m "fix(auth): serve concurrent refreshes instead of logging the device out"
```

---

### Task 3: Error codes on the wire and per-identity rate limits

**Files:**
- Modify: `apps/api/src/index.ts` (error handler, around line 189; global rate limit, around line 136)
- Modify: `apps/api/src/routes/auth/index.ts` (`/refresh`, around line 47)
- Create: `apps/api/src/test/auth-refresh-limits.test.ts`

**Interfaces:**
- Consumes: `RefreshTokenError` (Task 2).
- Produces: `POST /auth/refresh` responds `401 { statusCode, error, message, code }`; the global limiter keys on `user:<id>` when authenticated.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/auth-refresh-limits.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { rateLimitKey } from '../lib/rate-limit-key'

describe('rateLimitKey', () => {
    it('keys on the user id when a bearer token identifies one', () => {
        expect(rateLimitKey({ userId: 'u-1', forwardedFor: '10.0.0.1', ip: '10.0.0.1' })).toBe('user:u-1')
    })

    it('falls back to the first forwarded-for hop for anonymous traffic', () => {
        expect(rateLimitKey({ userId: null, forwardedFor: '196.188.1.1, 10.0.0.5', ip: '10.0.0.5' })).toBe('ip:196.188.1.1')
    })

    it('falls back to the socket ip when there is no forwarded-for header', () => {
        expect(rateLimitKey({ userId: null, forwardedFor: undefined, ip: '10.0.0.5' })).toBe('ip:10.0.0.5')
    })

    it('never returns a bare empty key', () => {
        expect(rateLimitKey({ userId: null, forwardedFor: '   ', ip: '' })).toBe('ip:unknown')
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/auth-refresh-limits.test.ts`
Expected: FAIL — cannot resolve `../lib/rate-limit-key`.

- [ ] **Step 3: Write the key helper**

Create `apps/api/src/lib/rate-limit-key.ts`:

```ts
/**
 * Rate-limit bucket for one request.
 *
 * Keyed by user id whenever the caller is authenticated, because Ethiopian
 * carriers put thousands of players behind a handful of NAT addresses — a
 * per-IP budget makes one busy player throttle a whole neighbourhood, and a
 * 429 on a refresh used to read as "logged out".
 *
 * Anonymous traffic still keys on the client IP, taking the first hop of
 * x-forwarded-for (the proxy appends, so the client is first).
 */
export function rateLimitKey(input: {
    userId: string | null | undefined
    forwardedFor: string | undefined
    ip: string | undefined
}): string {
    if (input.userId) return `user:${input.userId}`
    const hop = input.forwardedFor?.split(',')[0]?.trim()
    return `ip:${hop || input.ip?.trim() || 'unknown'}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/auth-refresh-limits.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Use the helper in the global limiter**

In `apps/api/src/index.ts`, add to the imports:

```ts
import { rateLimitKey } from './lib/rate-limit-key'
```

Replace the limiter's `keyGenerator`:

```ts
    keyGenerator: (req) => {
        return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip
    },
```

with:

```ts
    keyGenerator: (req) => {
        // `req.user` is set by the authenticate decorator; on routes that never
        // verify a JWT it is undefined and we fall back to the IP.
        const userId = (req as { user?: { id?: string } }).user?.id ?? null
        return rateLimitKey({
            userId,
            forwardedFor: req.headers['x-forwarded-for'] as string | undefined,
            ip: req.ip,
        })
    },
```

- [ ] **Step 6: Key the refresh limiter on the token, and surface the code**

In `apps/api/src/routes/auth/index.ts`, replace the `/refresh` registration with:

```ts
    fastify.post('/refresh', {
        config: {
            rateLimit: {
                max: 20,
                timeWindow: '1 minute',
                // Per device, not per IP: a shared carrier address must not put
                // every player on one 20/min budget, and a 429 here reads to the
                // client as a lost session.
                keyGenerator: (req: any) => {
                    const token = req.body?.refreshToken
                    return typeof token === 'string' && token.length > 0
                        ? `rt:${createHash('sha256').update(token).digest('hex')}`
                        : `ip:${(req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip}`
                },
            },
        },
        schema: {
            body: zodToJsonSchema(RefreshTokenSchema),
        },
        handler: AuthController.refresh,
    })
```

and add at the top of the file:

```ts
import { createHash } from 'crypto'
```

In `apps/api/src/index.ts`, in `setErrorHandler`, directly above the existing `error.message === 'Invalid credentials'` branch, add:

```ts
    // RefreshTokenError carries the only two codes that authorise the client to
    // clear a session. Everything else it sees must be treated as transient.
    const refreshCode = (error as { code?: string }).code
    if (refreshCode === 'refresh_token_invalid' || refreshCode === 'refresh_token_expired') {
        return reply.status(401).send({
            statusCode: 401,
            error: 'Unauthorized',
            message: error.message,
            code: refreshCode,
        })
    }
```

- [ ] **Step 7: Verify**

Run: `pnpm --filter @world-bingo/api typecheck`
Expected: no errors.

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/auth-refresh-limits.test.ts src/test/auth-refresh-grace.test.ts src/test/auth.service.test.ts src/test/hub-auth.test.ts src/test/bull-board-auth.test.ts`
Expected: the three auth files pass; the two others match `main`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/rate-limit-key.ts apps/api/src/test/auth-refresh-limits.test.ts apps/api/src/index.ts apps/api/src/routes/auth/index.ts
git commit -m "fix(auth): return a refusal code and key rate limits by identity"
```

---

### Task 4: Shared token-expiry helper

**Files:**
- Create: `apps/web/utils/token.ts`
- Create: `apps/web/utils/token.test.ts`

**Interfaces:**
- Produces:
  - `tokenExpiryMs(token: string | null | undefined): number | null`
  - `isExpiringWithin(token: string | null | undefined, marginMs: number): boolean`
  - `export const TOKEN_REFRESH_MARGIN_MS = 120_000`

- [ ] **Step 1: Write the failing test**

Create `apps/web/utils/token.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { tokenExpiryMs, isExpiringWithin, TOKEN_REFRESH_MARGIN_MS } from './token'

function makeToken(expSeconds: number): string {
  const payload = btoa(JSON.stringify({ exp: expSeconds })).replace(/\+/g, '-').replace(/\//g, '_')
  return `header.${payload}.signature`
}

describe('tokenExpiryMs', () => {
  it('reads exp as milliseconds', () => {
    const exp = Math.floor(Date.now() / 1000) + 600
    expect(tokenExpiryMs(makeToken(exp))).toBe(exp * 1000)
  })

  it('returns null for junk, empty and missing tokens', () => {
    expect(tokenExpiryMs(null)).toBeNull()
    expect(tokenExpiryMs(undefined)).toBeNull()
    expect(tokenExpiryMs('')).toBeNull()
    expect(tokenExpiryMs('not-a-jwt')).toBeNull()
    expect(tokenExpiryMs('a.!!!notbase64!!!.c')).toBeNull()
  })
})

describe('isExpiringWithin', () => {
  it('is true inside the margin', () => {
    expect(isExpiringWithin(makeToken(Math.floor(Date.now() / 1000) + 60), 120_000)).toBe(true)
  })

  it('is false well outside the margin', () => {
    expect(isExpiringWithin(makeToken(Math.floor(Date.now() / 1000) + 900), 120_000)).toBe(false)
  })

  it('treats an already-expired token as expiring', () => {
    expect(isExpiringWithin(makeToken(Math.floor(Date.now() / 1000) - 10), 120_000)).toBe(true)
  })

  it('treats an unreadable token as NOT expiring, so it is not refreshed blindly', () => {
    expect(isExpiringWithin('not-a-jwt', 120_000)).toBe(false)
    expect(isExpiringWithin(null, 120_000)).toBe(false)
  })
})

describe('TOKEN_REFRESH_MARGIN_MS', () => {
  it('is two minutes — comfortably inside the 15-minute access token', () => {
    expect(TOKEN_REFRESH_MARGIN_MS).toBe(120_000)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/web exec vitest run utils/token.test.ts`
Expected: FAIL — cannot resolve `./token`.

- [ ] **Step 3: Write the helper**

Create `apps/web/utils/token.ts`:

```ts
/**
 * Access-token expiry, read from the JWT payload without verifying it — the
 * client only needs to know *when* to ask for a new one; the server is the only
 * thing that decides whether a token is valid.
 *
 * Lifted out of composables/useSocket.ts so the socket and the auth store share
 * one definition. They used to disagree: the socket refreshed at 60s to expiry,
 * the store not at all, so a page load could fire a burst of requests with a
 * token that expired mid-flight.
 */

/**
 * Refresh this long before expiry. Two minutes on a 15-minute token: early
 * enough that a slow mobile round trip still lands before the old token dies,
 * late enough that a normal session refreshes about six times an hour.
 */
export const TOKEN_REFRESH_MARGIN_MS = 120_000

export function tokenExpiryMs(token: string | null | undefined): number | null {
  if (!token) return null
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return typeof json?.exp === 'number' ? json.exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * True when the token expires within `marginMs`. An unreadable token returns
 * FALSE on purpose: we cannot tell, and refreshing on every call would turn one
 * bad parse into a refresh storm. A real 401 still triggers the reactive path.
 */
export function isExpiringWithin(token: string | null | undefined, marginMs: number): boolean {
  const expiry = tokenExpiryMs(token)
  if (expiry === null) return false
  return expiry - Date.now() < marginMs
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/web exec vitest run utils/token.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/utils/token.ts apps/web/utils/token.test.ts
git commit -m "feat(web): share one access-token expiry helper"
```

---

### Task 5: Single-flight refresh in the auth store

**Files:**
- Modify: `apps/web/store/auth.ts` (`refresh`, around line 84; `apiFetch`, around line 137)
- Create: `apps/web/store/auth.test.ts`

**Interfaces:**
- Consumes: `tokenExpiryMs`, `isExpiringWithin`, `TOKEN_REFRESH_MARGIN_MS` (Task 4); `useAnalytics().track` (existing).
- Produces:
  - `refresh(): Promise<string | null>` — one shared in-flight promise; returns `null` **only** when the session was actually cleared.
  - `ensureFreshToken(): Promise<string | null>` — proactive refresh when inside the margin.
  - `SESSION_ENDING_CODES` exported for the test.

- [ ] **Step 1: Write the failing test**

Create `apps/web/store/auth.test.ts`:

```ts
// Node 25 exposes its own inert localStorage/sessionStorage globals that shadow
// jsdom's; without this the persisted store silently reads back nothing.
for (const name of ['localStorage', 'sessionStorage'] as const) {
  const existing = (globalThis as Record<string, any>)[name]
  if (!existing || typeof existing.clear !== 'function') {
    const store = new Map<string, string>()
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: unknown) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
          return store.size
        },
      },
    })
  }
}

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const track = vi.fn()
const reset = vi.fn()
vi.stubGlobal('useAnalytics', () => ({ track, reset, identify: vi.fn(), flush: vi.fn() }))
vi.stubGlobal('useRuntimeConfig', () => ({ public: { apiBase: '/api' } }))

const $fetch = vi.fn()
vi.stubGlobal('$fetch', $fetch)

import { useAuthStore } from './auth'
import { TOKEN_REFRESH_MARGIN_MS } from '~/utils/token'

function jwt(secondsFromNow: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  return `h.${payload}.s`
}

function httpError(status: number, code?: string) {
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    statusCode: status,
    data: code ? { code } : undefined,
    response: { status, _data: code ? { code } : undefined },
  })
}

let store: ReturnType<typeof useAuthStore>

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  store = useAuthStore()
  store.user = { id: 'u-1', serial: 1, createdAt: new Date().toISOString() } as any
  store.accessToken = jwt(600)
  store.refreshToken = 'rt-1'
})

describe('refresh — single flight', () => {
  it('issues ONE network call for five concurrent callers', async () => {
    $fetch.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ user: store.user, accessToken: jwt(900), refreshToken: 'rt-2' }), 10),
        ),
    )
    const results = await Promise.all([
      store.refresh(),
      store.refresh(),
      store.refresh(),
      store.refresh(),
      store.refresh(),
    ])
    expect($fetch).toHaveBeenCalledTimes(1)
    expect(new Set(results).size).toBe(1)
    expect(results[0]).toBeTruthy()
  })

  it('allows a fresh attempt after the previous one settles', async () => {
    $fetch.mockResolvedValue({ user: store.user, accessToken: jwt(900), refreshToken: 'rt-2' })
    await store.refresh()
    await store.refresh()
    expect($fetch).toHaveBeenCalledTimes(2)
  })
})

describe('refresh — what ends a session', () => {
  it('clears the session on refresh_token_invalid and reports the reason', async () => {
    $fetch.mockRejectedValue(httpError(401, 'refresh_token_invalid'))
    expect(await store.refresh()).toBeNull()
    expect(store.accessToken).toBeNull()
    expect(store.user).toBeNull()
    expect(track).toHaveBeenCalledWith('session_expired', { reason: 'refresh_token_invalid' })
  })

  it('clears the session on refresh_token_expired', async () => {
    $fetch.mockRejectedValue(httpError(401, 'refresh_token_expired'))
    expect(await store.refresh()).toBeNull()
    expect(store.user).toBeNull()
  })

  it('KEEPS the session on a network error', async () => {
    $fetch.mockRejectedValue(new Error('Failed to fetch'))
    await expect(store.refresh()).rejects.toThrow('Failed to fetch')
    expect(store.accessToken).not.toBeNull()
    expect(store.user).not.toBeNull()
    expect(track).toHaveBeenCalledWith('session_refresh_failed', { status: 0, transient: true })
  })

  it('KEEPS the session on 429', async () => {
    $fetch.mockRejectedValue(httpError(429))
    await expect(store.refresh()).rejects.toBeTruthy()
    expect(store.user).not.toBeNull()
  })

  it('KEEPS the session on 500 and on a 401 with no code', async () => {
    $fetch.mockRejectedValue(httpError(500))
    await expect(store.refresh()).rejects.toBeTruthy()
    expect(store.user).not.toBeNull()

    $fetch.mockRejectedValue(httpError(401))
    await expect(store.refresh()).rejects.toBeTruthy()
    expect(store.user).not.toBeNull()
  })
})

describe('ensureFreshToken', () => {
  it('refreshes when inside the margin', async () => {
    store.accessToken = jwt(Math.floor(TOKEN_REFRESH_MARGIN_MS / 1000) - 30)
    $fetch.mockResolvedValue({ user: store.user, accessToken: jwt(900), refreshToken: 'rt-2' })
    await store.ensureFreshToken()
    expect($fetch).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the token has plenty of life', async () => {
    store.accessToken = jwt(900)
    await store.ensureFreshToken()
    expect($fetch).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @world-bingo/web exec vitest run store/auth.test.ts`
Expected: FAIL — five network calls instead of one; `ensureFreshToken` is not a function.

- [ ] **Step 3: Rewrite the refresh path**

In `apps/web/store/auth.ts`, add below the existing imports:

```ts
import { isExpiringWithin, TOKEN_REFRESH_MARGIN_MS } from '~/utils/token'

/**
 * The only two answers that mean "this session is over". Anything else — a
 * dropped mobile connection, a 429 behind carrier NAT, a 502 during a deploy —
 * is transient, and treating it as fatal is what put players back on the login
 * screen mid-game.
 */
const SESSION_ENDING_CODES = new Set(['refresh_token_invalid', 'refresh_token_expired'])

/**
 * Module-level, not per-store-instance: every caller in the app must await the
 * same request. The lobby alone fires several authenticated calls in parallel,
 * and before this each one refreshed separately — one won, the others got a
 * retired token back and logged the player out.
 */
let refreshPromise: Promise<string | null> | null = null

function errorStatus(error: any): number {
  return error?.status ?? error?.statusCode ?? error?.response?.status ?? 0
}

function errorCode(error: any): string | null {
  return error?.data?.code ?? error?.response?._data?.code ?? error?.response?.data?.code ?? null
}

export { SESSION_ENDING_CODES }
```

Replace the whole `refresh` action with:

```ts
    async refresh(): Promise<string | null> {
      if (!this.refreshToken) return null
      if (refreshPromise) return refreshPromise

      const config = useRuntimeConfig()
      const token = this.refreshToken

      refreshPromise = (async () => {
        try {
          const { user, accessToken, refreshToken } = await $fetch<{
            user: User
            accessToken: string
            refreshToken: string
          }>(`${config.public.apiBase}/auth/refresh`, {
            method: 'POST',
            body: { refreshToken: token },
          })
          this.user = user
          this.accessToken = accessToken
          this.refreshToken = refreshToken
          return accessToken
        } catch (error: any) {
          const status = errorStatus(error)
          const code = errorCode(error)

          if (code && SESSION_ENDING_CODES.has(code)) {
            this.accessToken = null
            this.refreshToken = null
            this.user = null
            this.wallet = null
            useAnalytics().track('session_expired', { reason: code })
            useAnalytics().reset()
            return null
          }

          // Survivable. Keep the session and let the caller decide — a retry, a
          // spinner, or its own error state.
          useAnalytics().track('session_refresh_failed', { status, transient: true })
          throw error
        } finally {
          refreshPromise = null
        }
      })()

      return refreshPromise
    },

    /**
     * Refresh BEFORE the access token dies, so the parallel-request burst that
     * used to arrive with an expired token never happens. Cheap: a no-op until
     * the token is inside the margin.
     */
    async ensureFreshToken(): Promise<string | null> {
      if (!this.refreshToken) return this.accessToken
      if (!isExpiringWithin(this.accessToken, TOKEN_REFRESH_MARGIN_MS)) return this.accessToken
      try {
        return await this.refresh()
      } catch {
        // Transient: keep the current token and let the request try it.
        return this.accessToken
      }
    },
```

Replace `apiFetch`'s body with:

```ts
    async apiFetch<T = unknown>(url: string, options: any = {}): Promise<T> {
      const config = useRuntimeConfig()

      const doFetch = (token: string) =>
        $fetch<T>(`${config.public.apiBase}${url}`, {
          ...options,
          headers: {
            ...options.headers,
            Authorization: `Bearer ${token}`,
          },
        })

      // Proactive: refresh while the old token is still valid, so a burst of
      // parallel calls never races on an expired one.
      const token = (await this.ensureFreshToken()) ?? this.accessToken
      if (!token) {
        const refreshed = await this.refresh()
        if (!refreshed) throw new Error('Not authenticated')
        return doFetch(refreshed)
      }

      try {
        return await doFetch(token)
      } catch (error: any) {
        const status = error?.status ?? error?.statusCode ?? error?.response?.status
        if (status !== 401) throw error

        // Reactive fallback: the server rejected a token we thought was fine.
        // A failed refresh throws for transient causes and returns null only
        // when the session is genuinely over.
        const newToken = await this.refresh()
        if (!newToken) throw new Error('Session expired')
        return doFetch(newToken)
      }
    },
```

Note: `logout()` and `clearStoredUser()` are unchanged — an explicit sign-out still clears everything.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @world-bingo/web exec vitest run store/auth.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the whole web suite**

Run: `pnpm --filter @world-bingo/web exec vitest run`
Expected: all files green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/store/auth.ts apps/web/store/auth.test.ts
git commit -m "fix(web): one shared refresh, and log out only when the server says so"
```

---

### Task 6: Socket alignment, allowlist and runbook

**Files:**
- Modify: `apps/web/composables/useSocket.ts` (imports and the `auth` callback, around lines 7-115)
- Modify: `apps/api/src/services/event.service.ts` (`ALLOWED_EVENTS`)
- Modify: `apps/web/composables/useAnalytics.ts` (`ALLOWED`)
- Modify: `docs/posthog.md` (browser event list, section 3)

**Interfaces:**
- Consumes: `ensureFreshToken` (Task 5), `tokenExpiryMs` (Task 4).

- [ ] **Step 1: Point the socket at the shared helpers**

In `apps/web/composables/useSocket.ts`, delete the local `TOKEN_REFRESH_MARGIN_MS` constant and the local `tokenExpiryMs` function, and import instead:

```ts
import { tokenExpiryMs } from '~/utils/token'
```

Keep `export { tokenExpiryMs }` if other modules import it from here; otherwise update those importers. Replace the body of the `auth` callback with:

```ts
            auth: async (cb: (data: { token: string | null | undefined }) => void) => {
                if (auth.isAuthenticated) {
                    try {
                        // Shares the store's single-flight refresh, so a reconnect
                        // during a page load no longer races the page's own calls.
                        await auth.ensureFreshToken()
                        signedOut.value = !auth.token
                    } catch {
                        // Transient — the socket still connects with the token we
                        // have; the server decides whether it is good enough.
                        signedOut.value = false
                    }
                }
                cb({ token: auth.token })
            },
```

- [ ] **Step 2: Allowlist the two new event names**

In `apps/api/src/services/event.service.ts`, add to `ALLOWED_EVENTS` after `'identify'`:

```ts
    'session_expired',
    'session_refresh_failed',
```

In `apps/web/composables/useAnalytics.ts`, add the same two names to `ALLOWED` in the same position.

- [ ] **Step 3: Document the events**

In `docs/posthog.md`, in the browser-events paragraph of section 3, add after `lobby_predictions_click`:

```markdown
`session_expired` (`reason`: `refresh_token_invalid` | `refresh_token_expired`) fires only when
the client actually clears a session; `session_refresh_failed` (`status`, `transient`) fires when
a refresh failed but the session survived. Watch the first: after the grace-window fix it should
be a small fraction of `user_logged_in`, and a rise means sessions are being lost again.
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @world-bingo/web exec vitest run`
Expected: all green.

Run: `pnpm --filter @world-bingo/web exec nuxt typecheck 2>&1 | grep -E 'useSocket|store/auth|utils/token' || echo "no auth typecheck errors"`
Expected: `no auth typecheck errors`.

Run: `pnpm --filter @world-bingo/api exec vitest run src/test/event.service.test.ts src/test/auth-refresh-grace.test.ts`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/composables/useSocket.ts apps/api/src/services/event.service.ts apps/web/composables/useAnalytics.ts docs/posthog.md
git commit -m "fix(web): socket reuses the shared refresh; track session-loss events"
```

---

## Verification after the branch is complete

```bash
pnpm --filter @world-bingo/api exec vitest run src/test/auth-refresh-grace.test.ts src/test/auth-refresh-limits.test.ts src/test/auth.service.test.ts src/test/event.service.test.ts
pnpm --filter @world-bingo/web exec vitest run
pnpm --filter @world-bingo/api typecheck
```

After deploy, the fix is confirmed by three numbers, not by inspection:

| Metric | Before | Target |
|---|---|---|
| `wb_auth_refresh_total{outcome="invalid"}` share of all refreshes | 33% (64 of 194) | under 2% |
| `wb_auth_refresh_total{outcome="error"}` | 4 per 4.7 h | 0 |
| `session_expired` per `user_logged_in` in PostHog | ~0.8 implied | under 0.05 |

`outcome="grace"` is expected to be non-zero and healthy: each one is a request that used to be a logout.

## Plan self-review

**Spec coverage.** Grace window, atomic claim, `rotatedAt`/`replacedByHash`, pruning → Task 1-2. Machine-readable codes → Task 2-3. Refresh limited per token, global limiter per user → Task 3. Single-flight, definitive-code logout, proactive refresh, retry once → Task 4-5. Socket sharing the helper → Task 6. `session_expired` / `session_refresh_failed` → Task 5-6. Metric → Task 1-2.

**Type consistency.** `RefreshTokenError.code` values match `SESSION_ENDING_CODES` and the error-handler branch. `tokenExpiryMs` / `isExpiringWithin` / `TOKEN_REFRESH_MARGIN_MS` are defined in Task 4 and used under those names in Tasks 5-6. `ensureFreshToken` is defined in Task 5 and called in Task 6.

**Placeholders.** None: every code step carries its code, every run step its command and expected result.
