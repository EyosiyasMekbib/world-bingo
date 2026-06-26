# Observability Phase 1 — Structured Logging + Correlation IDs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Palace provider callback and game launch traceable end-to-end by a single correlation ID, with structured, PII-redacted boundary logs — and remove the `RUN_SEED=true` production landmine.

**Architecture:** A request-scoped correlation ID (`x-request-id`, honored inbound or minted at the edge) rides on Fastify's `req.log`. An `AsyncLocalStorage` carries that request logger so module-level functions (`resolveUser`, the Palace gateway, the wallet dispatcher) log with the same `reqId` without threading a logger through every signature. The hub→spoke `fetch` forwards the header so both deployments share the ID. Accounts are masked and secrets redacted in all logs.

**Tech Stack:** Fastify v5, Pino 9, `node:async_hooks` (AsyncLocalStorage), Vitest, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-06-26-observability-and-devops-design.md` (Track A Phase 1 + Track B red #1).

**Scope note:** Track B red #2 (decoupling `prisma migrate deploy` from app replicas via a one-shot migrate service) is a deployment-topology change and gets its **own** small plan — it is intentionally NOT in this plan to keep this unit shippable and TDD-able. This plan delivers all of Phase 1 + the `RUN_SEED` fix.

---

## File Structure

| File | Responsibility | Create/Modify |
|------|----------------|---------------|
| `apps/api/src/lib/logger.ts` | Pure helpers: `maskAccount`, `genReqId`, `redactPaths`, `rootLogger` | Create |
| `apps/api/src/lib/log-context.ts` | AsyncLocalStorage carrying the request logger (`enterLogContext`, `runWithLogger`, `getLogger`) | Create |
| `apps/api/src/index.ts` | Wire redaction + `genReqId` into Fastify; `onRequest` hook enters log context | Modify |
| `apps/api/src/services/palace-wallet.service.ts` | `dispatch` emits a structured outcome line; `resolveUser` logs its resolution | Modify |
| `apps/api/src/gateways/game-provider/palace.gateway.ts` | `request()` logs path/palaceCode/latency | Modify |
| `apps/api/src/routes/palace/callback.ts` | Forward `x-request-id` on the spoke leg | Modify |
| `apps/api/src/routes/game-provider/index.ts` | Structured launch boundary log | Modify |
| `docker-compose.prod.yml` | `RUN_SEED` env-driven (no hardcoded `true`) | Modify |
| `apps/api/src/test/logger.test.ts` | Tests for `maskAccount` + `genReqId` | Create |
| `apps/api/src/test/log-context.test.ts` | Tests for the ALS context | Create |
| `apps/api/src/test/palace-wallet.test.ts` | +tests for dispatch structured logging | Modify |
| `apps/api/src/test/compose-guard.test.ts` | Asserts prod compose never hardcodes `RUN_SEED=true` | Create |

All commands run from `apps/api/` unless stated. Test runner: `pnpm test -- <pattern>` (vitest).

---

### Task 1: Logger primitives (`lib/logger.ts`)

**Files:**
- Create: `apps/api/src/lib/logger.ts`
- Test: `apps/api/src/test/logger.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/test/logger.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { maskAccount, genReqId } from '../lib/logger.js'

describe('maskAccount', () => {
  it('masks the middle of a long account, keeping a recognizable head + tail', () => {
    expect(maskAccount('h00a053c60814bd4f569313abf1c3fa3d63')).toBe('h00a05…3d63')
  })
  it('mostly hides a short account/username', () => {
    expect(maskAccount('kira')).toBe('ki***')
    expect(maskAccount('Manager1')).toBe('Ma***')
  })
  it('renders empty/nullish as a sentinel', () => {
    expect(maskAccount('')).toBe('∅')
    expect(maskAccount(undefined as any)).toBe('∅')
  })
})

describe('genReqId', () => {
  it('honors an inbound x-request-id header', () => {
    expect(genReqId({ headers: { 'x-request-id': 'abc-123' } } as any)).toBe('abc-123')
  })
  it('mints a uuid when no header is present', () => {
    const id = genReqId({ headers: {} } as any)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- logger.test`
Expected: FAIL — `Cannot find module '../lib/logger.js'` / `maskAccount is not a function`.

- [ ] **Step 3: Implement `lib/logger.ts`**

Create `apps/api/src/lib/logger.ts`:

```typescript
import pino from 'pino'
import { randomUUID } from 'node:crypto'

/**
 * Mask an account/username before it reaches a log line. Accounts are UUID-hex
 * (32), hub-namespaced (35), or plain usernames — all are PII or PII-adjacent.
 */
export function maskAccount(account: string | undefined | null): string {
  if (!account) return '∅'
  if (account.length <= 8) return account.slice(0, 2) + '***'
  return account.slice(0, 6) + '…' + account.slice(-4)
}

/** Honor an inbound correlation id, else mint one. Used as Fastify `genReqId`. */
export function genReqId(req: { headers: Record<string, unknown> }): string {
  const inbound = req.headers['x-request-id']
  return typeof inbound === 'string' && inbound.length > 0 ? inbound : randomUUID()
}

/** Pino redaction paths — secrets and PII that must never appear in logs. */
export const redactPaths = [
  'req.headers.authorization',
  'req.headers["callback-token"]',
  'req.headers["x-signature"]',
  'rawBody.data.account',
  'data.account',
  '*.password',
  '*.passwordHash',
]

/**
 * Process-level logger for code that runs OUTSIDE a request (workers, module
 * init). Request-scoped code should use getLogger() from log-context instead.
 */
export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: redactPaths, censor: '[redacted]' },
})
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- logger.test`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/logger.ts apps/api/src/test/logger.test.ts
git commit -m "feat(obs): logger primitives — maskAccount, genReqId, redaction"
```

---

### Task 2: Request-logger context (`lib/log-context.ts`)

**Files:**
- Create: `apps/api/src/lib/log-context.ts`
- Test: `apps/api/src/test/log-context.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/test/log-context.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { getLogger, runWithLogger } from '../lib/log-context.js'
import { rootLogger } from '../lib/logger.js'

describe('log-context', () => {
  it('returns rootLogger when no request context is active', () => {
    expect(getLogger()).toBe(rootLogger)
  })

  it('returns the bound logger inside runWithLogger, and restores after', () => {
    const fake = { info() {} } as any
    const inside = runWithLogger(fake, () => getLogger())
    expect(inside).toBe(fake)
    expect(getLogger()).toBe(rootLogger)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- log-context.test`
Expected: FAIL — `Cannot find module '../lib/log-context.js'`.

- [ ] **Step 3: Implement `lib/log-context.ts`**

Create `apps/api/src/lib/log-context.ts`:

```typescript
import { AsyncLocalStorage } from 'node:async_hooks'
import type { FastifyBaseLogger } from 'fastify'
import { rootLogger } from './logger.js'

const als = new AsyncLocalStorage<FastifyBaseLogger>()

/** Bind a logger for the remainder of the current async context (Fastify hook). */
export function enterLogContext(log: FastifyBaseLogger): void {
  als.enterWith(log)
}

/** Run `fn` with `log` bound — isolated; the previous context is restored after. */
export function runWithLogger<T>(log: FastifyBaseLogger, fn: () => T): T {
  return als.run(log, fn)
}

/** The current request logger, or the process root logger outside a request. */
export function getLogger(): FastifyBaseLogger {
  return als.getStore() ?? rootLogger
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- log-context.test`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/log-context.ts apps/api/src/test/log-context.test.ts
git commit -m "feat(obs): AsyncLocalStorage request-logger context"
```

---

### Task 3: Wire correlation id + redaction into Fastify (`index.ts`)

**Files:**
- Modify: `apps/api/src/index.ts:54-65` (Fastify constructor) and add an `onRequest` hook just after construction.

- [ ] **Step 1: Add imports**

At the top of `apps/api/src/index.ts`, after the existing `import { register as metricsRegistry, ... } from './lib/metrics'` line, add:

```typescript
import { genReqId, redactPaths } from './lib/logger.js'
import { enterLogContext } from './lib/log-context.js'
```

- [ ] **Step 2: Replace the Fastify constructor**

Replace the existing block at `apps/api/src/index.ts:54-65`:

```typescript
const server = Fastify({
    logger: isProd
        ? { redact: { paths: redactPaths, censor: '[redacted]' } }
        : {
            transport: { target: 'pino-pretty' },
            redact: { paths: redactPaths, censor: '[redacted]' },
        },
    // We honor x-request-id ourselves in genReqId, so disable Fastify's built-in
    // header lookup (default 'request-id') to keep one source of truth.
    requestIdHeader: false,
    genReqId,
    disableRequestLogging: false,
    trustProxy: true, // correct client IP behind Traefik/nginx for rate limiting
})

// Bind req.log (which carries reqId) for the whole request's async context, so
// module-level code (resolveUser, the Palace gateway, the wallet dispatcher)
// logs with the same correlation id without threading a logger everywhere.
server.addHook('onRequest', (req, _reply, done) => {
    enterLogContext(req.log)
    done()
})
```

- [ ] **Step 3: Verify it compiles and boots**

Run: `pnpm typecheck`
Expected: no errors.

Run (sanity, optional): `pnpm build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(obs): honor x-request-id, redact secrets, enter log context per request"
```

---

### Task 4: Structured boundary logs in the wallet dispatcher

**Files:**
- Modify: `apps/api/src/services/palace-wallet.service.ts` (`resolveUser`, `dispatch`)
- Test: `apps/api/src/test/palace-wallet.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/test/palace-wallet.test.ts`, before the final closing `})`:

```typescript
    it('dispatch emits a structured outcome line with masked account + result code', async () => {
        p.user.findUnique.mockResolvedValue(null) // unknown user → result 21
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const { runWithLogger } = await import('../lib/log-context.js')
        const spy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
        const res = await runWithLogger(spy as any, () =>
            PalaceWalletService.dispatch('balance', { account: 'h00a053c60814bd4f569313abf1c3fa3d63' }),
        )
        expect(res.result).toBe(21)
        expect(spy.info).toHaveBeenCalledWith(
            expect.objectContaining({
                component: 'palace-wallet',
                command: 'balance',
                account: 'h00a05…3d63',
                resultCode: 21,
            }),
            expect.any(String),
        )
    })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- palace-wallet`
Expected: FAIL — `spy.info` not called with a `component: 'palace-wallet'` object (dispatch does not log yet).

- [ ] **Step 3: Implement the logging**

In `apps/api/src/services/palace-wallet.service.ts`, add imports near the top (after the existing `import redis from '../lib/redis.js'`):

```typescript
import { getLogger } from '../lib/log-context.js'
import { maskAccount } from '../lib/logger.js'
```

In `resolveUser`, add a resolution log just before `return user` (i.e. after the `if (user) await redis.setex(...)` line):

```typescript
    getLogger().info(
        { component: 'resolve-user', account: maskAccount(account), matched: !!user },
        '[resolve-user] account resolution',
    )
    return user
```

Replace the body of `dispatch` so it wraps the existing switch and logs the outcome. Rename the current `switch (command) { ... }` body into a private `route` method and have `dispatch` call it:

```typescript
    /** Dispatch a provider callback command to the matching wallet handler. */
    static async dispatch(command: string | undefined, d: Record<string, any>): Promise<PalaceResponse> {
        const startedAt = Date.now()
        const res = await PalaceWalletService.route(command, d)
        getLogger().info(
            {
                component: 'palace-wallet',
                command,
                account: maskAccount(d?.account),
                resultCode: res.result,
                status: res.status,
                latencyMs: Date.now() - startedAt,
            },
            '[palace-wallet] command handled',
        )
        return res
    }

    private static async route(command: string | undefined, d: Record<string, any>): Promise<PalaceResponse> {
        switch (command) {
            case 'authenticate':
                return PalaceWalletService.authenticate(d.account)
            case 'balance':
                return PalaceWalletService.getBalance(d.account)
            case 'bet':
                return PalaceWalletService.processBet({
                    trans_guid: d.trans_guid,
                    account: d.account,
                    gplay_id: d.gplay_id,
                    round_id: d.round_id,
                    game_code: d.game_code,
                    amount: d.amount,
                })
            case 'win':
                return PalaceWalletService.processWin({
                    trans_guid: d.trans_guid,
                    account: d.account,
                    gplay_id: d.gplay_id,
                    round_id: d.round_id,
                    game_code: d.game_code,
                    amount: d.amount,
                    type: d.type ?? 2,
                })
            case 'cancel':
                return PalaceWalletService.processCancel({
                    trans_guid: d.trans_guid,
                    account: d.account,
                    gplay_id: d.gplay_id,
                    round_id: d.round_id,
                    game_code: d.game_code,
                    amount: d.amount ?? 0,
                    cancle_trans_guid: d.cancel_trans_guid ?? d.cancle_trans_guid,
                })
            case 'status':
                return PalaceWalletService.getStatus(d.account, d.trans_guid ?? d.trans_id ?? '')
            default:
                return { result: 1006, status: 'COMMAND_NOT_FOUND', data: null }
        }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- palace-wallet`
Expected: PASS (all prior tests + the new one — 12 total).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/palace-wallet.service.ts apps/api/src/test/palace-wallet.test.ts
git commit -m "feat(obs): structured boundary logs in wallet dispatch + resolveUser"
```

---

### Task 5: Palace gateway request/response logging

**Files:**
- Modify: `apps/api/src/gateways/game-provider/palace.gateway.ts` (`request()` helper, lines ~42-103)

- [ ] **Step 1: Add imports**

At the top of `apps/api/src/gateways/game-provider/palace.gateway.ts`, after `import { parseNamespacedAccount } from '../hub/namespace.js'`, add:

```typescript
import { getLogger } from '../../lib/log-context.js'
```

- [ ] **Step 2: Instrument the `request` helper**

In `request<T>(path, body)`, capture timing and log the upstream outcome. Add at the very start of the function body (before `let res: Response`):

```typescript
    const startedAt = Date.now()
```

Then, immediately before the final `return json.data as T`, add:

```typescript
    getLogger().info(
        { component: 'palace-gateway', path, palaceCode: json.code, latencyMs: Date.now() - startedAt },
        '[palace-gateway] upstream call ok',
    )
```

And in the `if (json.code !== 0)` block, immediately before the `throw new PalaceApiError({...})`, add:

```typescript
        getLogger().warn(
            { component: 'palace-gateway', path, palaceCode: json.code, latencyMs: Date.now() - startedAt },
            '[palace-gateway] upstream rejected request',
        )
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/gateways/game-provider/palace.gateway.ts
git commit -m "feat(obs): log Palace gateway upstream calls (path, palaceCode, latency)"
```

---

### Task 6: Propagate the correlation id across the hub→spoke leg

**Files:**
- Modify: `apps/api/src/routes/palace/callback.ts:76-85` (the spoke-forward `fetch` headers)

- [ ] **Step 1: Add the header**

In `apps/api/src/routes/palace/callback.ts`, the spoke-forward `fetch` sets headers at lines 78-82. Add `x-request-id` so the spoke's logs share this request's id. Change the `headers` object to:

```typescript
                  headers: {
                    'Content-Type': 'application/json',
                    'x-request-id': String(req.id),
                    [DEPLOYMENT_HEADER]: cfg.code,
                    [SIGNATURE_HEADER]: sig,
                  },
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Manual verification note**

The spoke sink (`routes/hub/spoke-callback.ts`) already receives this request through Fastify, whose `genReqId` (Task 3) now reads `x-request-id`. No spoke-side code change is required — a forwarded bet shows the **same** `reqId` on both the hub's `[Palace] spoke forward` logs and the spoke's `[palace-wallet] command handled` log.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/palace/callback.ts
git commit -m "feat(obs): forward x-request-id to the spoke so a bet shares one reqId"
```

---

### Task 7: Structured launch boundary log

**Files:**
- Modify: `apps/api/src/routes/game-provider/index.ts:207-215` (the post-launch URL-validity block)

- [ ] **Step 1: Replace the launch-result log block**

In `apps/api/src/routes/game-provider/index.ts`, replace the existing block at lines 207-215:

```typescript
            // Surface bad/empty/non-https URLs that pass as HTTP 200 but won't load client-side.
            const launchOk = !!gameUrl && /^https:\/\//i.test(gameUrl)
            if (!launchOk) {
                req.log.error(
                    { component: 'palace-launch', providerCode, gameCode, userId: user.id, gameUrl },
                    'provider returned an unusable game url',
                )
            } else {
                req.log.info(
                    { component: 'palace-launch', providerCode, gameCode, userId: user.id },
                    'provider launch ok',
                )
            }
```

(Note: the success log intentionally drops the raw `gameUrl` — it can contain a session token. The failure log keeps it because a bad URL is the thing being diagnosed.)

- [ ] **Step 2: Verify it compiles**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/game-provider/index.ts
git commit -m "feat(obs): structured launch boundary log with component tag"
```

---

### Task 8: DevOps red #1 — kill the `RUN_SEED=true` production landmine

**Files:**
- Modify: `docker-compose.prod.yml:23`
- Test: `apps/api/src/test/compose-guard.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/compose-guard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Repo root is three levels up from apps/api/src/test
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

const PROD_COMPOSE_FILES = [
  'docker-compose.prod.yml',
  'docker-compose.aradabingo.yml',
  'docker-compose.betbawa.yml',
]

describe('production compose seed safety', () => {
  for (const file of PROD_COMPOSE_FILES) {
    it(`${file} never hardcodes RUN_SEED to true`, () => {
      const content = readFileSync(path.join(repoRoot, file), 'utf8')
      // Allow env-driven default (RUN_SEED: ${RUN_SEED:-false}); forbid a literal true.
      const hardcodedTrue = /RUN_SEED:\s*["']?true["']?\s*$/m.test(content)
      expect(hardcodedTrue).toBe(false)
    })
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- compose-guard`
Expected: FAIL — `docker-compose.prod.yml` matches `RUN_SEED: "true"` (line 23).

- [ ] **Step 3: Fix the compose file**

In `docker-compose.prod.yml`, replace line 23:

```yaml
      RUN_SEED: "true"
```

with the env-driven, safe-by-default form (matching every other var in the file and `DEPLOYMENT.md`):

```yaml
      RUN_SEED: ${RUN_SEED:-false}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- compose-guard`
Expected: PASS (3 assertions — all prod compose files clean).

- [ ] **Step 5: Commit**

```bash
git add docker-compose.prod.yml apps/api/src/test/compose-guard.test.ts
git commit -m "fix(devops): make RUN_SEED env-driven (default false) + CI guard

docker-compose.prod.yml hardcoded RUN_SEED=true, which re-seeded the database
on every prod deploy — contradicting DEPLOYMENT.md. Make it env-driven and add
a test that fails if any prod compose file ever hardcodes it to true again."
```

---

## Final verification

- [ ] **Run the full API test suite**

Run (from `apps/api/`): `pnpm test`
Expected: the new tests pass; pre-existing unrelated failures (the 15 DB-dependent withdrawal tests) are unchanged — net new failures: 0.

- [ ] **Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Manual smoke (optional, if a dev stack is up):** trigger a Palace `balance` callback and confirm one log line `[palace-wallet] command handled` with `component`, `command`, masked `account`, `resultCode`, and a `reqId` field.

---

## Self-Review (completed by author)

**Spec coverage (spec §4 Phase 1):**
- Correlation id honored inbound + minted at edge → Task 1 (`genReqId`) + Task 3 (wiring).
- Propagation hub→spoke → Task 6 (`x-request-id` forward).
- Boundary logs: dispatch + resolveUser → Task 4; Palace gateway req/resp → Task 5; launch → Task 7. (`spoke-forward` and `callback received/handled` are already logged in `callback.ts`; Task 6 ties them to the shared `reqId`.)
- Standard schema (`component`, masked `account`, `resultCode`, `latencyMs`) → Tasks 4/5/7.
- PII redaction → Task 1 (`redactPaths`) + Task 3 (wired).
- **Deferred (documented):** detailed wallet-balance read logging is intentionally omitted — balance is sensitive and the `resultCode` already distinguishes resolution/funding outcomes. Track B red #2 (migrate decoupling) is a separate plan.

**Placeholder scan:** none — every code/command step contains literal content.

**Type consistency:** `getLogger`/`runWithLogger`/`enterLogContext` (log-context), `maskAccount`/`genReqId`/`redactPaths`/`rootLogger` (logger), and `PalaceWalletService.dispatch`/`route` names are used consistently across tasks and tests.
