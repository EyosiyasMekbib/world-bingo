# ZareCash Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route opted-in payment methods' deposits and withdrawals through ZareCash — reporting payments, requesting payouts, and reacting to signed webhooks — while the manual clerk flow stays untouched for every method that has not opted in.

**Architecture:** A thin `ZareCashClient` owns HTTP and knows only the contract. `ZareCashService` is the single place that knows about both `Transaction` rows and ZareCash payloads. A public webhook route verifies an HMAC over the raw body, dedupes on the event id, returns 200 immediately, and hands processing to a BullMQ worker. Deposit approvals are funnelled into the *existing* `WalletService.approveDeposit` rather than a new credit path.

**Tech Stack:** Fastify v5, Prisma 5 + PostgreSQL, BullMQ + Redis, Vitest, TypeScript ESM.

**Spec:** `docs/superpowers/specs/2026-08-26-zarecash-integration-design.md`

## Global Constraints

- **All work is in `apps/api`.** No changes to `apps/web`, `apps/admin`, or `packages/*` in this plan.
- **`WalletService.approveDeposit` is the only path that credits a deposit.** It also grants the first-deposit bonus, evaluates daily/weekly deposit-bonus rules, pushes the balance over the socket, increments `wbDepositsTotal`, notifies, and fires `ReferralService.processFirstDepositBonus`. Never write a second credit path.
- **Webhook handlers dispatch on the envelope `type`, never on `data.status`.** The withdrawal payload carries no `status` field.
- **Trust `approvedAmount`, never the amount we submitted.** A ZareCash reviewer may correct it.
- **Idempotency keys are derived, not generated:** `dep_<transaction.id>` and `wd_<transaction.id>`.
- **Money is `Decimal`,** never JS `number`, in anything that touches a wallet or a transaction row. Convert at the HTTP boundary only.
- **Test phase only.** `ZARECASH_MODE=test`. Nothing in this plan assumes a live key.
- **Never refund on `409 withdrawal_pending`** — a payout may genuinely be in flight.
- Run tests with `pnpm --filter @world-bingo/api test`. Do not infer anything from other packages' gates.
- **The suite is not green, and will not be.** Verified baseline at commit `7d4008e`: **27 failing tests across 6 files** (`admin-featured-games`, `auth.service`, `game-state`, `integration`, `settings.service`, `withdrawal.service`), 944 passing. Causes are environmental (no Redis/Docker in this sandbox) and pre-existing (missing Fastify decorators, stale tests). The full list is in `.superpowers/sdd/2026-08-26-zarecash-integration/baseline-failures.txt`.
  **Every "run the full suite" gate in this plan means: the failure set is unchanged from that baseline — same files, same test names, same count.** A new failure, or an old one disappearing, is the signal. An all-green run is not achievable and must not be waited for.
- Note for Tasks 5 and 9: `withdrawal.service.test.ts` already contributes 5 of those failures, two of them inside `requestWithdrawal — complete flow` (stale tests that predate the one-pending-withdrawal rule). It is still a usable gate — but the bar is "these same 5, no more", not zero.
- Tests live in `apps/api/src/test/*.test.ts`. Real-DB suites rely on `cleanDb()` in `src/test/setup.ts`.

---

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `src/gateways/payment/zarecash/config.ts` | Read and validate env into a typed config |
| `src/gateways/payment/zarecash/types.ts` | Contract shapes + `ZareCashError` |
| `src/gateways/payment/zarecash/signature.ts` | `pmv2-signature` parse + verify (pure) |
| `src/gateways/payment/zarecash/client.ts` | HTTP: auth, idempotency, timeout, error mapping |
| `src/gateways/payment/zarecash/method-config.ts` | `MethodConfigSource` + mirrored implementation |
| `src/services/zarecash.service.ts` | Domain mapping, both directions |
| `src/routes/zarecash/webhook.ts` | `POST /v1/zarecash/webhook` |
| `src/workers/zarecash-deposit.worker.ts` | Submits deposits, with retries |
| `src/workers/zarecash-event.worker.ts` | Processes received webhook events |
| `src/workers/zarecash-withdrawal.worker.ts` | Submits payouts, refunds on permanent failure |
| `src/workers/zarecash-sweep.worker.ts` | Nightly `GET /v1/events` backfill |

**Modified**

| Path | Change |
|---|---|
| `prisma/schema.prisma` | `PaymentMethod.gateway` + `.gatewayMethodCode`, `Transaction.gatewayRef`, `ZareCashEvent` model |
| `src/test/setup.ts` | `cleanDb()` deletes `zareCashEvent` |
| `src/lib/queue.ts` | Three new `QUEUE_NAMES` entries |
| `src/services/wallet.service.ts` | Deposit routing branch; extract `rejectWithdrawal`; enqueue payout submit |
| `src/services/admin.service.ts` | Delegate withdrawal rejection to `WalletService.rejectWithdrawal` |
| `src/index.ts` | Register webhook route, import three workers, boot assertion |
| `.env.example` (root) and `apps/api/.env.example` | `ZARECASH_*` block |

---

### Task 1: Schema, config, and queue names

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/test/setup.ts`
- Modify: `apps/api/src/lib/queue.ts`
- Modify: `apps/api/.env.example`
- Create: `apps/api/src/gateways/payment/zarecash/config.ts`
- Test: `apps/api/src/test/zarecash-config.test.ts`

**Interfaces:**
- Produces: `zarecashConfig(): ZareCashConfig`, `isZareCashEnabled(): boolean`, and the `ZareCashConfig` interface. Every later task reads config through `zarecashConfig()`, never `process.env` directly.
- Produces: `QUEUE_NAMES.ZARECASH_DEPOSIT`, `.ZARECASH_EVENT`, `.ZARECASH_WITHDRAWAL`, `.ZARECASH_SWEEP`.

- [ ] **Step 1: Add the schema changes**

In `apps/api/prisma/schema.prisma`, add two fields to `model PaymentMethod` (after `autoVerify`):

```prisma
  gateway           String            @default("manual") // "manual" | "zarecash"
  gatewayMethodCode String? // ZareCash methodCode when gateway = "zarecash"
```

Add one field to `model Transaction` (after `paymentTransactionId`):

```prisma
  gatewayRef           String?              @unique
```

Append a new model next to `DepositVerification`:

```prisma
/// One row per received ZareCash webhook delivery. Delivery is at-least-once,
/// so this table is both the dedupe key and the audit trail.
model ZareCashEvent {
  id          String    @id // evt_… assigned by ZareCash
  type        String
  payload     Json
  receivedAt  DateTime  @default(now())
  processedAt DateTime?
  error       String?

  @@index([type])
  @@index([processedAt])
  @@map("zarecash_events")
}
```

- [ ] **Step 2: Run the migration**

```bash
cd apps/api && pnpm db:migrate --name zarecash_integration
```

Expected: a new folder under `apps/api/prisma/migrations/` and `✔ Generated Prisma Client`.

- [ ] **Step 3: Add the table to test cleanup**

In `apps/api/src/test/setup.ts`, inside `cleanDb()`, add this line immediately **before** `await prisma.transaction.deleteMany()` (the event row has no FK, but keeping it with the transaction group keeps the ordering readable):

```ts
    await prisma.zareCashEvent.deleteMany()
```

- [ ] **Step 4: Add queue names**

In `apps/api/src/lib/queue.ts`, add three entries to `QUEUE_NAMES` before the closing `} as const`:

```ts
    ZARECASH_DEPOSIT: 'zarecash-deposit',
    ZARECASH_EVENT: 'zarecash-event',
    ZARECASH_WITHDRAWAL: 'zarecash-withdrawal',
    ZARECASH_SWEEP: 'zarecash-sweep',
```

- [ ] **Step 5: Write the failing config test**

Create `apps/api/src/test/zarecash-config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { zarecashConfig, isZareCashEnabled } from '../gateways/payment/zarecash/config'

const ORIGINAL = { ...process.env }

describe('zarecashConfig', () => {
  beforeEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith('ZARECASH_')) delete process.env[k]
  })
  afterEach(() => {
    process.env = { ...ORIGINAL }
  })

  it('is disabled by default', () => {
    expect(isZareCashEnabled()).toBe(false)
  })

  it('reads a full configuration', () => {
    process.env.ZARECASH_ENABLED = 'true'
    process.env.ZARECASH_BASE_URL = 'https://api.zarecash.com/'
    process.env.ZARECASH_API_KEY = 'pk_test_ABC'
    process.env.ZARECASH_WEBHOOK_SECRET = 'whsec'
    process.env.ZARECASH_MODE = 'test'
    const cfg = zarecashConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.baseUrl).toBe('https://api.zarecash.com') // trailing slash stripped
    expect(cfg.apiKey).toBe('pk_test_ABC')
    expect(cfg.mode).toBe('test')
    expect(cfg.timeoutMs).toBe(10000)
  })

  it('throws when enabled without an api key', () => {
    process.env.ZARECASH_ENABLED = 'true'
    process.env.ZARECASH_WEBHOOK_SECRET = 'whsec'
    expect(() => zarecashConfig()).toThrow(/ZARECASH_API_KEY/)
  })

  it('throws when enabled without a webhook secret', () => {
    process.env.ZARECASH_ENABLED = 'true'
    process.env.ZARECASH_API_KEY = 'pk_test_ABC'
    expect(() => zarecashConfig()).toThrow(/ZARECASH_WEBHOOK_SECRET/)
  })

  it('rejects an unknown mode', () => {
    process.env.ZARECASH_ENABLED = 'true'
    process.env.ZARECASH_API_KEY = 'pk_test_ABC'
    process.env.ZARECASH_WEBHOOK_SECRET = 'whsec'
    process.env.ZARECASH_MODE = 'staging'
    expect(() => zarecashConfig()).toThrow(/ZARECASH_MODE/)
  })
})
```

- [ ] **Step 6: Run it and watch it fail**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-config.test.ts
```

Expected: FAIL — cannot resolve `../gateways/payment/zarecash/config`.

- [ ] **Step 7: Implement the config module**

Create `apps/api/src/gateways/payment/zarecash/config.ts`:

```ts
/**
 * ZareCash configuration.
 *
 * Read lazily (not at module load) so dotenv has run first, matching the
 * pattern in gateways/game-provider/signature.middleware.ts.
 */

export interface ZareCashConfig {
    enabled: boolean
    baseUrl: string
    apiKey: string
    webhookSecret: string
    mode: 'test' | 'live'
    timeoutMs: number
}

export function isZareCashEnabled(): boolean {
    return (process.env.ZARECASH_ENABLED ?? '').trim().toLowerCase() === 'true'
}

export function zarecashConfig(): ZareCashConfig {
    const enabled = isZareCashEnabled()
    const baseUrl = (process.env.ZARECASH_BASE_URL ?? 'https://api.zarecash.com').trim().replace(/\/+$/, '')
    const apiKey = (process.env.ZARECASH_API_KEY ?? '').trim()
    const webhookSecret = (process.env.ZARECASH_WEBHOOK_SECRET ?? '').trim()
    const mode = (process.env.ZARECASH_MODE ?? 'test').trim()
    const timeoutMs = Number(process.env.ZARECASH_TIMEOUT_MS ?? '10000')

    if (enabled) {
        if (!apiKey) throw new Error('ZARECASH_API_KEY is required when ZARECASH_ENABLED=true')
        if (!webhookSecret) throw new Error('ZARECASH_WEBHOOK_SECRET is required when ZARECASH_ENABLED=true')
        if (mode !== 'test' && mode !== 'live') {
            throw new Error(`ZARECASH_MODE must be "test" or "live", got "${mode}"`)
        }
    }

    return { enabled, baseUrl, apiKey, webhookSecret, mode: mode as 'test' | 'live', timeoutMs }
}
```

- [ ] **Step 8: Run the test to verify it passes**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-config.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 9: Document the env block**

Append to `apps/api/.env.example` and to the root `.env.example`:

```
# ─── ZareCash (deposits & withdrawals as a service) ──────────────────────────
# No-op when ZARECASH_ENABLED=false. Methods opt in individually via
# PaymentMethod.gateway = 'zarecash'.
ZARECASH_ENABLED=false
ZARECASH_BASE_URL=https://api.zarecash.com
ZARECASH_API_KEY=
ZARECASH_WEBHOOK_SECRET=
ZARECASH_MODE=test
ZARECASH_TIMEOUT_MS=10000
```

- [ ] **Step 10: Commit**

```bash
git add apps/api/prisma apps/api/src/lib/queue.ts apps/api/src/test/setup.ts \
        apps/api/src/gateways/payment/zarecash/config.ts \
        apps/api/src/test/zarecash-config.test.ts apps/api/.env.example .env.example
git commit -m "feat(zarecash): add schema, queue names, and config module"
```

---

### Task 2: Webhook signature verification

**Files:**
- Create: `apps/api/src/gateways/payment/zarecash/signature.ts`
- Test: `apps/api/src/test/zarecash-signature.test.ts`

**Interfaces:**
- Produces: `verifyWebhookSignature({ secret, rawBody, header, toleranceSeconds?, nowMs? }): boolean`. Task 7 calls it. `nowMs` is injectable purely so tests need no fake timers.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/zarecash-signature.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { verifyWebhookSignature } from '../gateways/payment/zarecash/signature'

const SECRET = 'whsec_test'
const BODY = '{"id":"evt_1","type":"deposit.approved","created":1785840764,"data":{"id":"dp_1"}}'

function sign(t: number, body = BODY, secret = SECRET): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${v1}`
}

describe('verifyWebhookSignature', () => {
  const now = 1785840764_000

  it('accepts a correctly signed body', () => {
    const header = sign(1785840764)
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header, nowMs: now })).toBe(true)
  })

  it('rejects a body that was altered after signing', () => {
    const header = sign(1785840764)
    const tampered = BODY.replace('dp_1', 'dp_2')
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: tampered, header, nowMs: now })).toBe(false)
  })

  it('rejects the wrong secret', () => {
    const header = sign(1785840764, BODY, 'whsec_other')
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header, nowMs: now })).toBe(false)
  })

  it('rejects a timestamp older than the tolerance', () => {
    const stale = 1785840764 - 301
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header: sign(stale), nowMs: now })).toBe(false)
  })

  it('rejects a timestamp too far in the future', () => {
    const ahead = 1785840764 + 301
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header: sign(ahead), nowMs: now })).toBe(false)
  })

  it('accepts a timestamp inside the tolerance', () => {
    const recent = 1785840764 - 299
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header: sign(recent), nowMs: now })).toBe(true)
  })

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['missing v1', 't=1785840764'],
    ['missing t', 'v1=abc'],
    ['non-numeric t', 't=abc,v1=deadbeef'],
    ['v1 not hex', 't=1785840764,v1=zzzz'],
  ])('rejects a malformed header (%s)', (_label, header) => {
    expect(verifyWebhookSignature({ secret: SECRET, rawBody: BODY, header: header as any, nowMs: now })).toBe(false)
  })

  it('rejects when no secret is configured', () => {
    expect(verifyWebhookSignature({ secret: '', rawBody: BODY, header: sign(1785840764), nowMs: now })).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-signature.test.ts
```

Expected: FAIL — cannot resolve `../gateways/payment/zarecash/signature`.

- [ ] **Step 3: Implement**

Create `apps/api/src/gateways/payment/zarecash/signature.ts`:

```ts
/**
 * ZareCash webhook signature.
 *
 * Header: pmv2-signature: t=<unix>,v1=<hex hmac-sha256("<t>.<raw body>")>
 *
 * The HMAC MUST be computed over the raw request bytes. A re-serialised object
 * will not match — key order and number formatting both differ.
 */

import crypto from 'node:crypto'

export const SIGNATURE_HEADER = 'pmv2-signature'
export const EVENT_TYPE_HEADER = 'pmv2-event-type'
const DEFAULT_TOLERANCE_SECONDS = 300

function timingSafeHexEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

export function verifyWebhookSignature(opts: {
    secret: string
    rawBody: string
    header: string | undefined
    toleranceSeconds?: number
    nowMs?: number
}): boolean {
    const { secret, rawBody, header } = opts
    if (!secret || !header) return false

    const parts = new Map<string, string>()
    for (const segment of header.split(',')) {
        const idx = segment.indexOf('=')
        if (idx === -1) continue
        parts.set(segment.slice(0, idx).trim(), segment.slice(idx + 1).trim())
    }

    const rawT = parts.get('t')
    const received = parts.get('v1')
    if (!rawT || !received) return false

    const t = Number.parseInt(rawT, 10)
    if (!Number.isFinite(t)) return false

    const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
    const nowSeconds = (opts.nowMs ?? Date.now()) / 1000
    if (Math.abs(nowSeconds - t) > tolerance) return false

    const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
    return timingSafeHexEqual(expected, received)
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-signature.test.ts
```

Expected: PASS, 14 tests (the `it.each` block contributes 6).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/gateways/payment/zarecash/signature.ts apps/api/src/test/zarecash-signature.test.ts
git commit -m "feat(zarecash): verify pmv2-signature over raw webhook bodies"
```

---

### Task 3: HTTP client and contract types

**Files:**
- Create: `apps/api/src/gateways/payment/zarecash/types.ts`
- Create: `apps/api/src/gateways/payment/zarecash/client.ts`
- Test: `apps/api/src/test/zarecash-client.test.ts`

**Interfaces:**
- Produces: `ZareCashClient` with `createDeposit`, `createWithdrawal`, `getFloat`, `listEvents`, `freezePlayer`, `unfreezePlayer`.
- Produces: `ZareCashError` carrying `code`, `status`, `permanent`, `retryAfterSeconds`. Workers branch on `.permanent` to decide retry-vs-refund.

- [ ] **Step 1: Write the contract types**

Create `apps/api/src/gateways/payment/zarecash/types.ts`:

```ts
/** Shapes from the ZareCash integration contract (/llms.txt + /v1/openapi.json). */

export type ZareCashMode = 'test' | 'live'
export type ZareCashDepositStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED'
export type ZareCashWithdrawalState =
    | 'pending'
    | 'queued_float'
    | 'risk_hold'
    | 'rejected'
    | 'approved'
    | 'cancelled'

export interface CreateDepositInput {
    playerRef: string
    amount: number
    methodCode: string
    receiptRef: string
    payerName?: string
    payerAccount?: string
}

export interface CreateWithdrawalInput {
    playerRef: string
    amount: number
    methodCode: string
    destinationAccount: string
    destinationName?: string
}

export interface ZareCashDeposit {
    id: string
    status: ZareCashDepositStatus
    playerRef: string
    mode: ZareCashMode
    statedAmount: number
    /** Null until a reviewer sets it. Always prefer this over the amount we sent. */
    approvedAmount: number | null
    amount: number
    receiptRef: string
    verdict: string
}

export interface ZareCashWithdrawal {
    id: string
    state: ZareCashWithdrawalState
    playerRef: string
    amount: number
    destinationAccount: string
    destinationName: string | null
    settlementRef: string | null
}

export interface ZareCashFloat {
    mode: ZareCashMode
    balance: number
    reserved: number
    available: number
    lowFloatThreshold: number
    queuedWithdrawals: number
}

export interface ZareCashEventEnvelope {
    id: string
    type: string
    created: number
    data: Record<string, unknown>
}

/**
 * `permanent` means retrying is pointless — the request will never succeed as
 * written. Workers refund a debited player on a permanent withdrawal failure and
 * retry on everything else.
 */
export class ZareCashError extends Error {
    readonly code: string
    readonly status: number
    readonly permanent: boolean
    readonly retryAfterSeconds?: number

    constructor(opts: {
        code: string
        message: string
        status: number
        permanent: boolean
        retryAfterSeconds?: number
    }) {
        super(opts.message)
        this.name = 'ZareCashError'
        this.code = opts.code
        this.status = opts.status
        this.permanent = opts.permanent
        this.retryAfterSeconds = opts.retryAfterSeconds
    }
}

/**
 * Errors that will never succeed on retry. `withdrawal_pending` is deliberately
 * absent: it means our state and ZareCash's disagree, which the sweep resolves —
 * refunding on it could double-pay a payout that is genuinely in flight.
 */
export const PERMANENT_ERROR_CODES = new Set([
    'invalid_request',
    'invalid_amount',
    'idempotency_key_required',
    'method_unavailable',
    'amount_out_of_range',
    'player_frozen',
    'duplicate_receipt',
    'not_live',
])
```

- [ ] **Step 2: Write the failing client test**

Create `apps/api/src/test/zarecash-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ZareCashClient } from '../gateways/payment/zarecash/client'
import { ZareCashError } from '../gateways/payment/zarecash/types'

const CFG = {
  enabled: true,
  baseUrl: 'https://zc.test',
  apiKey: 'pk_test_ABC',
  webhookSecret: 'whsec',
  mode: 'test' as const,
  timeoutMs: 5000,
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('ZareCashClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends the api key and idempotency key on a deposit', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { id: 'dp_1', status: 'APPROVED', playerRef: 'u1', mode: 'test', statedAmount: 500, approvedAmount: 500, amount: 500, receiptRef: 'ABC', verdict: 'CLEAN_MATCH' }),
    )
    const client = new ZareCashClient(CFG)
    const res = await client.createDeposit(
      { playerRef: 'u1', amount: 500, methodCode: 'telebirr', receiptRef: 'ABC' },
      'dep_tx1',
    )

    expect(res.id).toBe('dp_1')
    expect(res.approvedAmount).toBe(500)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://zc.test/v1/deposits')
    expect(init.method).toBe('POST')
    expect(init.headers['x-api-key']).toBe('pk_test_ABC')
    expect(init.headers['Idempotency-Key']).toBe('dep_tx1')
    expect(JSON.parse(init.body)).toEqual({ playerRef: 'u1', amount: 500, methodCode: 'telebirr', receiptRef: 'ABC' })
  })

  it('maps duplicate_receipt to a permanent ZareCashError', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'duplicate_receipt', message: 'Transaction ID already used' }))
    const client = new ZareCashClient(CFG)
    await expect(
      client.createDeposit({ playerRef: 'u1', amount: 500, methodCode: 'telebirr', receiptRef: 'ABC' }, 'dep_tx1'),
    ).rejects.toMatchObject({ code: 'duplicate_receipt', status: 409, permanent: true })
  })

  it('treats withdrawal_pending as NOT permanent', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'withdrawal_pending', message: 'open payout' }))
    const client = new ZareCashClient(CFG)
    await expect(
      client.createWithdrawal({ playerRef: 'u1', amount: 500, methodCode: 'telebirr', destinationAccount: '0911' }, 'wd_tx1'),
    ).rejects.toMatchObject({ code: 'withdrawal_pending', permanent: false })
  })

  it('surfaces retryAfterSeconds on 429', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { error: 'rate_limited', message: 'slow down', retryAfterSeconds: 42 }, { 'retry-after': '42' }),
    )
    const client = new ZareCashClient(CFG)
    await expect(client.getFloat()).rejects.toMatchObject({ code: 'rate_limited', permanent: false, retryAfterSeconds: 42 })
  })

  it('treats a 500 as retryable', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'server_error', message: 'boom' }))
    const client = new ZareCashClient(CFG)
    await expect(client.getFloat()).rejects.toMatchObject({ permanent: false, status: 500 })
  })

  it('wraps a network failure as a retryable error', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new ZareCashClient(CFG)
    await expect(client.getFloat()).rejects.toMatchObject({ code: 'network_error', permanent: false })
  })

  it('omits undefined optional fields from the withdrawal body', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { id: 'wd_1', state: 'pending', playerRef: 'u1', amount: 500, destinationAccount: '0911', destinationName: null, settlementRef: null }),
    )
    const client = new ZareCashClient(CFG)
    await client.createWithdrawal({ playerRef: 'u1', amount: 500, methodCode: 'telebirr', destinationAccount: '0911' }, 'wd_tx1')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      playerRef: 'u1', amount: 500, methodCode: 'telebirr', destinationAccount: '0911',
    })
  })

  it('reads float without an idempotency key', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { mode: 'test', balance: 1000, reserved: 0, available: 1000, lowFloatThreshold: 100, queuedWithdrawals: 0 }),
    )
    const client = new ZareCashClient(CFG)
    const f = await client.getFloat()
    expect(f.mode).toBe('test')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://zc.test/v1/float')
    expect(init.headers['Idempotency-Key']).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-client.test.ts
```

Expected: FAIL — cannot resolve `../gateways/payment/zarecash/client`.

- [ ] **Step 4: Implement the client**

Create `apps/api/src/gateways/payment/zarecash/client.ts`:

```ts
/**
 * ZareCash HTTP client.
 *
 * Knows the contract and nothing about our domain. Every mutating call takes a
 * caller-supplied Idempotency-Key — derived from our own transaction id, so a
 * retry is always safe.
 */

import { zarecashConfig, type ZareCashConfig } from './config.js'
import {
    ZareCashError,
    PERMANENT_ERROR_CODES,
    type CreateDepositInput,
    type CreateWithdrawalInput,
    type ZareCashDeposit,
    type ZareCashWithdrawal,
    type ZareCashFloat,
    type ZareCashEventEnvelope,
} from './types.js'

/** Drops undefined values so we never send `"destinationName": undefined`. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

export class ZareCashClient {
    private readonly cfg: ZareCashConfig

    constructor(cfg?: ZareCashConfig) {
        this.cfg = cfg ?? zarecashConfig()
    }

    private async request<T>(
        method: 'GET' | 'POST',
        path: string,
        opts: { body?: unknown; idempotencyKey?: string } = {},
    ): Promise<T> {
        const headers: Record<string, string> = { 'x-api-key': this.cfg.apiKey }
        if (opts.body !== undefined) headers['content-type'] = 'application/json'
        if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs)

        let res: Response
        try {
            res = await fetch(`${this.cfg.baseUrl}${path}`, {
                method,
                headers,
                body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
                signal: controller.signal,
            })
        } catch (err) {
            throw new ZareCashError({
                code: 'network_error',
                message: (err as Error)?.message ?? 'request failed',
                status: 0,
                permanent: false,
            })
        } finally {
            clearTimeout(timer)
        }

        const text = await res.text()
        const parsed: any = text ? safeJson(text) : null

        if (!res.ok) {
            const code = parsed?.error ?? `http_${res.status}`
            const retryHeader = res.headers.get('retry-after')
            throw new ZareCashError({
                code,
                message: parsed?.message ?? `ZareCash ${method} ${path} failed with ${res.status}`,
                status: res.status,
                permanent: PERMANENT_ERROR_CODES.has(code),
                retryAfterSeconds: parsed?.retryAfterSeconds ?? (retryHeader ? Number(retryHeader) : undefined),
            })
        }

        return parsed as T
    }

    createDeposit(input: CreateDepositInput, idempotencyKey: string): Promise<ZareCashDeposit> {
        return this.request<ZareCashDeposit>('POST', '/v1/deposits', { body: compact(input as any), idempotencyKey })
    }

    createWithdrawal(input: CreateWithdrawalInput, idempotencyKey: string): Promise<ZareCashWithdrawal> {
        return this.request<ZareCashWithdrawal>('POST', '/v1/withdrawals', { body: compact(input as any), idempotencyKey })
    }

    getFloat(): Promise<ZareCashFloat> {
        return this.request<ZareCashFloat>('GET', '/v1/float')
    }

    listEvents(params: { cursor?: string; limit?: number } = {}): Promise<{
        data: ZareCashEventEnvelope[]
        nextCursor: string | null
    }> {
        const qs = new URLSearchParams()
        if (params.cursor) qs.set('cursor', params.cursor)
        qs.set('limit', String(params.limit ?? 100))
        return this.request('GET', `/v1/events?${qs.toString()}`)
    }

    freezePlayer(ref: string, reason: string): Promise<unknown> {
        return this.request('POST', `/v1/players/${encodeURIComponent(ref)}/freeze`, {
            body: { reason },
            idempotencyKey: `freeze_${ref}_${Date.now()}`,
        })
    }

    unfreezePlayer(ref: string, reason: string): Promise<unknown> {
        return this.request('POST', `/v1/players/${encodeURIComponent(ref)}/unfreeze`, {
            body: { reason },
            idempotencyKey: `unfreeze_${ref}_${Date.now()}`,
        })
    }
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text)
    } catch {
        return null
    }
}

let singleton: ZareCashClient | null = null
export function zarecashClient(): ZareCashClient {
    if (!singleton) singleton = new ZareCashClient()
    return singleton
}
/** Test seam — drops the cached singleton so a new config is picked up. */
export function resetZareCashClient(): void {
    singleton = null
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-client.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/gateways/payment/zarecash/types.ts \
        apps/api/src/gateways/payment/zarecash/client.ts \
        apps/api/src/test/zarecash-client.test.ts
git commit -m "feat(zarecash): add contract types and HTTP client"
```

---

### Task 4: Method routing and config source

**Files:**
- Create: `apps/api/src/gateways/payment/zarecash/method-config.ts`
- Test: `apps/api/src/test/zarecash-method-config.test.ts`

**Interfaces:**
- Produces: `resolveMethod(code): Promise<ResolvedMethod | null>` and `isZareCashMethod(code): Promise<boolean>`. Tasks 6 and 9 call these to decide routing.
- Produces: `ResolvedMethod = { code, gateway, gatewayMethodCode, collectionAccount, name }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/zarecash-method-config.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: { paymentMethod: { findUnique: vi.fn() } },
}))

import prisma from '../lib/prisma'
import { resolveMethod, isZareCashMethod, clearMethodCache } from '../gateways/payment/zarecash/method-config'

describe('method routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearMethodCache()
  })

  it('returns null for an unknown method code', async () => {
    ;(prisma as any).paymentMethod.findUnique.mockResolvedValue(null)
    expect(await resolveMethod('nope')).toBeNull()
    expect(await isZareCashMethod('nope')).toBe(false)
  })

  it('reports a manual method as not zarecash', async () => {
    ;(prisma as any).paymentMethod.findUnique.mockResolvedValue({
      code: 'cbe', name: 'CBE', gateway: 'manual', gatewayMethodCode: null, merchantAccount: '1000', merchantName: 'Us',
    })
    expect(await isZareCashMethod('cbe')).toBe(false)
  })

  it('reports an opted-in method as zarecash', async () => {
    ;(prisma as any).paymentMethod.findUnique.mockResolvedValue({
      code: 'telebirr', name: 'TeleBirr', gateway: 'zarecash', gatewayMethodCode: 'telebirr',
      merchantAccount: '0911552200', merchantName: 'ZareCash Merchant',
    })
    expect(await isZareCashMethod('telebirr')).toBe(true)
    const m = await resolveMethod('telebirr')
    expect(m?.gatewayMethodCode).toBe('telebirr')
    expect(m?.collectionAccount).toEqual({ receiverName: 'ZareCash Merchant', account: '0911552200' })
  })

  it('falls back to the local code when gatewayMethodCode is unset', async () => {
    ;(prisma as any).paymentMethod.findUnique.mockResolvedValue({
      code: 'telebirr', name: 'TeleBirr', gateway: 'zarecash', gatewayMethodCode: null,
      merchantAccount: '0911', merchantName: null,
    })
    expect((await resolveMethod('telebirr'))?.gatewayMethodCode).toBe('telebirr')
  })

  it('caches within the TTL and refetches after clearing', async () => {
    ;(prisma as any).paymentMethod.findUnique.mockResolvedValue({
      code: 'telebirr', name: 'TeleBirr', gateway: 'zarecash', gatewayMethodCode: 'telebirr',
      merchantAccount: '0911', merchantName: 'ZC',
    })
    await resolveMethod('telebirr')
    await resolveMethod('telebirr')
    expect((prisma as any).paymentMethod.findUnique).toHaveBeenCalledTimes(1)
    clearMethodCache()
    await resolveMethod('telebirr')
    expect((prisma as any).paymentMethod.findUnique).toHaveBeenCalledTimes(2)
  })

  it('treats a null method code as manual', async () => {
    expect(await isZareCashMethod(null)).toBe(false)
    expect((prisma as any).paymentMethod.findUnique).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-method-config.test.ts
```

Expected: FAIL — cannot resolve `../gateways/payment/zarecash/method-config`.

- [ ] **Step 3: Implement**

Create `apps/api/src/gateways/payment/zarecash/method-config.ts`:

```ts
/**
 * Method routing and configuration.
 *
 * `MethodConfigSource` is the seam described in the spec: today the collection
 * account is mirrored by hand into PaymentMethod.merchantAccount, because
 * ZareCash exposes no GET /v1/methods. When that endpoint ships, add a remote
 * source here and change the export below — nothing else moves.
 */

import prisma from '../../../lib/prisma.js'

export interface CollectionAccount {
    receiverName: string | null
    account: string | null
}

export interface ResolvedMethod {
    code: string
    name: string
    gateway: string
    /** The methodCode ZareCash expects. Falls back to our own code. */
    gatewayMethodCode: string
    collectionAccount: CollectionAccount
}

export interface MethodConfigSource {
    resolve(code: string): Promise<ResolvedMethod | null>
}

const CACHE_TTL_MS = 60_000
const cache = new Map<string, { at: number; value: ResolvedMethod | null }>()

/** Mirrored source: reads the account an operator typed into our own admin panel. */
class MirroredMethodConfigSource implements MethodConfigSource {
    async resolve(code: string): Promise<ResolvedMethod | null> {
        const row = await prisma.paymentMethod.findUnique({ where: { code } })
        if (!row) return null
        return {
            code: row.code,
            name: row.name,
            gateway: row.gateway ?? 'manual',
            gatewayMethodCode: row.gatewayMethodCode ?? row.code,
            collectionAccount: { receiverName: row.merchantName, account: row.merchantAccount },
        }
    }
}

const source: MethodConfigSource = new MirroredMethodConfigSource()

export async function resolveMethod(code: string | null | undefined): Promise<ResolvedMethod | null> {
    if (!code) return null
    const hit = cache.get(code)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
    const value = await source.resolve(code)
    cache.set(code, { at: Date.now(), value })
    return value
}

export async function isZareCashMethod(code: string | null | undefined): Promise<boolean> {
    const m = await resolveMethod(code)
    return m?.gateway === 'zarecash'
}

/** Test seam, and the hook an admin-side config change should call. */
export function clearMethodCache(): void {
    cache.clear()
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-method-config.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/gateways/payment/zarecash/method-config.ts apps/api/src/test/zarecash-method-config.test.ts
git commit -m "feat(zarecash): resolve per-method gateway routing behind a config source"
```

---

### Task 5: Extract withdrawal rejection into WalletService

Pure refactor with no behaviour change. Task 9 needs to refund a debited player from a worker, and that logic currently lives inside `AdminService.reviewTransaction`'s REJECTED branch, reachable only through an admin request.

**Files:**
- Modify: `apps/api/src/services/wallet.service.ts`
- Modify: `apps/api/src/services/admin.service.ts:302-375`
- Test: `apps/api/src/test/withdrawal.service.test.ts` (existing — must stay green)
- Test: `apps/api/src/test/admin.service.test.ts` (existing — must stay green)

**Interfaces:**
- Produces: `WalletService.rejectWithdrawal(transactionId: string, note?: string, reviewerId?: string): Promise<Transaction>` — atomically claims `PENDING_REVIEW → REJECTED`, re-credits the wallet under `SELECT FOR UPDATE`, writes the `REFUND` compensation row, pushes the balance, notifies, and increments `wbWithdrawalsTotal.labels('rejected')`. Throws `'Transaction is not pending review'` when the claim finds nothing.

- [ ] **Step 1: Capture the current behaviour as a baseline**

```bash
pnpm --filter @world-bingo/api test src/test/withdrawal.service.test.ts src/test/admin.service.test.ts
```

Expected at commit `7d4008e`: **5 failed | 35 passed (40)** — `admin.service.test.ts` fully green, `withdrawal.service.test.ts` contributing 5 pre-existing failures (3 in `getTransactions — pagination and filtering`, 2 in `requestWithdrawal — complete flow`). Those 5 are stale tests that predate the one-pending-withdrawal rule; they are NOT yours to fix in this task.

Record the exact failing test names. That list is your gate: after the refactor it must be identical. A 6th failure means you changed behaviour.

- [ ] **Step 2: Move the logic into WalletService**

In `apps/api/src/services/wallet.service.ts`, add this method after `requestWithdrawal`. The body is the existing REJECTED-withdrawal branch of `AdminService.reviewTransaction`, moved verbatim — same atomic claim, same lock order, same compensation row.

```ts
    /**
     * Reject a pending withdrawal and refund the player.
     *
     * Extracted from AdminService so both a human reviewer and the ZareCash
     * withdrawal worker can reach it. The claim is an atomic conditional update:
     * two concurrent rejects serialize on the row and the loser aborts BEFORE
     * crediting, so the wallet can never be double-refunded.
     */
    static async rejectWithdrawal(transactionId: string, note?: string, reviewerId?: string) {
        const existing = await prisma.transaction.findUnique({ where: { id: transactionId } })
        if (!existing) throw new Error('Transaction not found')
        if (existing.type !== TransactionType.WITHDRAWAL) {
            throw new Error('rejectWithdrawal only applies to withdrawals')
        }

        const result = await prisma.$transaction(async (tx) => {
            const claim = await tx.transaction.updateMany({
                where: { id: transactionId, status: PaymentStatus.PENDING_REVIEW },
                data: { status: PaymentStatus.REJECTED, note, reviewedById: reviewerId },
            })
            if (claim.count === 0) {
                throw new Error('Transaction is not pending review')
            }
            const updated = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } })

            const wallets = await tx.$queryRaw<Array<{ id: string; realBalance: Decimal; bonusBalance: Decimal }>>`
                SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${existing.userId} FOR UPDATE
            `
            const wallet = wallets[0]
            if (!wallet) throw new Error('Wallet not found')

            const realBefore = new Decimal(wallet.realBalance)
            const realAfter = realBefore.plus(new Decimal(existing.amount))
            const bonusBefore = new Decimal(wallet.bonusBalance)

            await tx.wallet.update({
                where: { userId: existing.userId },
                data: { realBalance: { increment: existing.amount } },
            })

            await tx.transaction.create({
                data: {
                    userId: existing.userId,
                    type: TransactionType.REFUND,
                    amount: existing.amount,
                    status: PaymentStatus.APPROVED,
                    referenceId: transactionId,
                    note: `Refund for rejected withdrawal${note ? `: ${note}` : ''}`,
                    balanceBefore: realBefore,
                    balanceAfter: realAfter,
                    bonusBalanceBefore: bonusBefore,
                    bonusBalanceAfter: bonusBefore,
                },
            })

            return { updated, realAfter, bonusBefore }
        })

        NotificationService.pushWalletUpdate(
            existing.userId,
            result.realAfter.toNumber(),
            result.bonusBefore.toNumber(),
        )

        await NotificationService.create(
            existing.userId,
            NotificationType.WITHDRAWAL_PROCESSED,
            'Withdrawal Rejected',
            `Your withdrawal of ${Number(existing.amount).toFixed(2)} ETB was rejected and refunded to your wallet.${note ? ` Reason: ${note}` : ''}`,
            { transactionId, amount: Number(existing.amount), note },
        ).catch(() => {})

        wbWithdrawalsTotal.labels('rejected').inc()

        return result.updated
    }
```

Add `wbWithdrawalsTotal` to the existing metrics import at the top of `wallet.service.ts`:

```ts
import { wbDepositsTotal, wbWithdrawalsTotal } from '../lib/metrics'
```

- [ ] **Step 3: Delegate from AdminService**

In `apps/api/src/services/admin.service.ts`, replace the whole `if (existing.type === TransactionType.WITHDRAWAL) { ... }` block inside the REJECTED path (the block that opens at line ~302 and ends with `return result.updated`) with:

```ts
        if (existing.type === TransactionType.WITHDRAWAL) {
            return await WalletService.rejectWithdrawal(transactionId, note, reviewerId)
        }
```

Leave the `PENDING_REVIEW` guard above it untouched — `rejectWithdrawal` re-checks under the claim, but the early guard still gives admins the clearer error message.

- [ ] **Step 4: Run the baseline tests — behaviour must be unchanged**

```bash
pnpm --filter @world-bingo/api test src/test/withdrawal.service.test.ts src/test/admin.service.test.ts
```

Expected: **the identical 5 failures from Step 1 and nothing else** — same test names, same count. Any new failure, or a Step 1 failure that now passes, means the refactor altered behaviour. Revert and re-read the original branch.

- [ ] **Step 5: Run the full api suite**

```bash
pnpm --filter @world-bingo/api test
```

Expected: **27 failed | 944 passed**, matching `baseline-failures.txt` exactly. This method is reached by several suites, so an unchanged failure set is the real gate. Diff your output against that file before claiming the refactor is clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/wallet.service.ts apps/api/src/services/admin.service.ts
git commit -m "refactor(wallet): extract rejectWithdrawal from AdminService

No behaviour change. The ZareCash withdrawal worker needs to refund a
debited player without going through an admin request."
```

---

### Task 6: Route deposits to ZareCash

**Files:**
- Create: `apps/api/src/services/zarecash.service.ts`
- Modify: `apps/api/src/services/wallet.service.ts` (`initiateDeposit`)
- Test: `apps/api/src/test/zarecash-deposit-submit.test.ts`
- Test: `apps/api/src/test/deposit-initiate-enqueue.test.ts` (existing — must stay green)

**Interfaces:**
- Produces: `ZareCashService.submitDeposit(transactionId: string): Promise<void>` — submits, stores `gatewayRef`, and credits immediately when ZareCash returns `APPROVED`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/zarecash-deposit-submit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    transaction: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
  },
}))
const { createDeposit } = vi.hoisted(() => ({ createDeposit: vi.fn() }))
vi.mock('../gateways/payment/zarecash/client', () => ({
  zarecashClient: () => ({ createDeposit }),
}))
const { approveDeposit } = vi.hoisted(() => ({ approveDeposit: vi.fn().mockResolvedValue({}) }))
vi.mock('../services/wallet.service', () => ({ WalletService: { approveDeposit } }))
vi.mock('../gateways/payment/zarecash/method-config', () => ({
  resolveMethod: vi.fn().mockResolvedValue({
    code: 'telebirr', name: 'TeleBirr', gateway: 'zarecash', gatewayMethodCode: 'telebirr',
    collectionAccount: { receiverName: 'ZC', account: '0911' },
  }),
}))

import prisma from '../lib/prisma'
import { ZareCashService } from '../services/zarecash.service'

const TX = {
  id: 'tx1', userId: 'u1', amount: '500', note: 'telebirr',
  paymentTransactionId: 'ABC123', senderName: 'Abebe', senderAccount: '0912345678',
}

describe('ZareCashService.submitDeposit', () => {
  beforeEach(() => vi.clearAllMocks())

  it('submits with a derived idempotency key and stores the gatewayRef', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createDeposit.mockResolvedValue({ id: 'dp_1', status: 'PENDING_REVIEW', approvedAmount: null })

    await ZareCashService.submitDeposit('tx1')

    expect(createDeposit).toHaveBeenCalledWith(
      {
        playerRef: 'u1', amount: 500, methodCode: 'telebirr', receiptRef: 'ABC123',
        payerName: 'Abebe', payerAccount: '0912345678',
      },
      'dep_tx1',
    )
    expect((prisma as any).transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx1' }, data: { gatewayRef: 'dp_1' },
    })
    expect(approveDeposit).not.toHaveBeenCalled()
  })

  it('credits immediately when ZareCash approves inline, using approvedAmount', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createDeposit.mockResolvedValue({ id: 'dp_2', status: 'APPROVED', approvedAmount: 480 })

    await ZareCashService.submitDeposit('tx1')

    expect(approveDeposit).toHaveBeenCalledWith('tx1', 480)
  })

  it('falls back to the stated amount when approvedAmount is null', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createDeposit.mockResolvedValue({ id: 'dp_3', status: 'APPROVED', approvedAmount: null })

    await ZareCashService.submitDeposit('tx1')

    expect(approveDeposit).toHaveBeenCalledWith('tx1', 500)
  })

  it('does not credit when ZareCash rejects inline', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createDeposit.mockResolvedValue({ id: 'dp_4', status: 'REJECTED', approvedAmount: null })

    await ZareCashService.submitDeposit('tx1')

    expect(approveDeposit).not.toHaveBeenCalled()
    expect((prisma as any).transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx1' }, data: { gatewayRef: 'dp_4' },
    })
  })

  it('is a no-op when the transaction has vanished', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(null)
    await ZareCashService.submitDeposit('gone')
    expect(createDeposit).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-deposit-submit.test.ts
```

Expected: FAIL — cannot resolve `../services/zarecash.service`.

- [ ] **Step 3: Implement the service**

Create `apps/api/src/services/zarecash.service.ts`:

```ts
/**
 * ZareCash domain mapping.
 *
 * The only module that knows about both Transaction rows and ZareCash payloads.
 * Deposit approval always funnels through WalletService.approveDeposit — that
 * function also grants bonuses, fires the referral payout, and emits metrics.
 */

import prisma from '../lib/prisma.js'
import { zarecashClient } from '../gateways/payment/zarecash/client.js'
import { resolveMethod } from '../gateways/payment/zarecash/method-config.js'
import { WalletService } from './wallet.service.js'
import { PaymentStatus } from '@world-bingo/shared-types'
import { ZareCashError } from '../gateways/payment/zarecash/types.js'

export class ZareCashService {
    /** Idempotency keys are derived from our own row, so every retry is safe. */
    static depositKey(transactionId: string): string {
        return `dep_${transactionId}`
    }

    static withdrawalKey(transactionId: string): string {
        return `wd_${transactionId}`
    }

    static async submitDeposit(transactionId: string): Promise<void> {
        const tx = await prisma.transaction.findUnique({ where: { id: transactionId } })
        if (!tx) return

        const method = await resolveMethod(tx.note)

        let res
        try {
            res = await zarecashClient().createDeposit(
                {
                    playerRef: tx.userId,
                    amount: Number(tx.amount),
                    methodCode: method?.gatewayMethodCode ?? tx.note ?? '',
                    receiptRef: tx.paymentTransactionId ?? '',
                    payerName: tx.senderName ?? undefined,
                    payerAccount: tx.senderAccount ?? undefined,
                },
                ZareCashService.depositKey(transactionId),
            )
        } catch (err) {
            const zc = err as ZareCashError
            // A permanent refusal (duplicate_receipt, amount_out_of_range, …) will
            // never succeed on retry. Reject locally so the deposit does not sit in
            // review forever. No wallet change — nothing was ever credited.
            if (zc?.permanent) {
                await prisma.transaction.updateMany({
                    where: { id: transactionId, status: PaymentStatus.PENDING_REVIEW },
                    data: { status: PaymentStatus.REJECTED, note: `ZareCash refused (${zc.code}): ${zc.message}` },
                })
                return
            }
            throw err
        }

        await prisma.transaction.update({ where: { id: transactionId }, data: { gatewayRef: res.id } })

        // Test mode approves clean refs inline. Credit now rather than waiting for
        // the webhook; the webhook still arrives and the PENDING_REVIEW guard in
        // approveDeposit makes it a no-op.
        if (res.status === 'APPROVED') {
            await WalletService.approveDeposit(transactionId, res.approvedAmount ?? Number(tx.amount))
        }
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-deposit-submit.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Branch initiateDeposit**

In `apps/api/src/services/wallet.service.ts`, replace the tail of `initiateDeposit` (the two lines after the `prisma.transaction.create({...})` call) with:

```ts
        // Route to ZareCash when the method has opted in; otherwise keep the
        // manual flow untouched, including local auto-verification.
        if (await isZareCashMethod(data.methodCode)) {
            // Submit on a queue, not inline: it buys retries for free, and it
            // keeps wallet.service from importing zarecash.service (which imports
            // WalletService back — a cycle that leaves one of them undefined at
            // module init). A failed submit leaves the deposit PENDING_REVIEW,
            // which is a safe state: no money has moved.
            await getQueue(QUEUE_NAMES.ZARECASH_DEPOSIT).add('submit', { transactionId: transaction.id })
            return transaction
        }

        // Best-effort: kick off async auto-verification. Swallows its own errors so a
        // queue hiccup can never break deposit submission — the deposit still goes to manual.
        await DepositVerificationService.enqueue(transaction.id)
        return transaction
```

Add the imports at the top of `wallet.service.ts`. **Do not import `ZareCashService` here** — the queue is deliberately the boundary between these two modules.

```ts
import { isZareCashMethod } from '../gateways/payment/zarecash/method-config'
import { getQueue, QUEUE_NAMES } from '../lib/queue'
```

- [ ] **Step 6: Add the routing test**

Append to `apps/api/src/test/deposit-initiate-enqueue.test.ts`, inside the existing `describe`, and add the two mocks below to the top of that file alongside the existing ones:

```ts
const { isZareCashMethod } = vi.hoisted(() => ({ isZareCashMethod: vi.fn().mockResolvedValue(false) }))
vi.mock('../gateways/payment/zarecash/method-config', () => ({ isZareCashMethod }))
const { add } = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/queue', () => ({
  getQueue: () => ({ add }),
  QUEUE_NAMES: { ZARECASH_DEPOSIT: 'zarecash-deposit', ZARECASH_WITHDRAWAL: 'zarecash-withdrawal' },
}))
```

```ts
  it('submits to ZareCash and skips local verification for an opted-in method', async () => {
    isZareCashMethod.mockResolvedValue(true)
    ;(prisma as any).transaction.create.mockResolvedValue({ id: 'tx-zc', amount: 500 })

    await WalletService.initiateDeposit('user1', {
      amount: 500, transactionId: 'ABC12345', methodCode: 'telebirr',
    } as any)

    expect(add).toHaveBeenCalledWith('submit', { transactionId: 'tx-zc' })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('still enqueues local verification for a manual method', async () => {
    isZareCashMethod.mockResolvedValue(false)
    ;(prisma as any).transaction.create.mockResolvedValue({ id: 'tx-manual', amount: 500 })

    await WalletService.initiateDeposit('user1', {
      amount: 500, transactionId: 'XYZ98765', methodCode: 'cbe',
    } as any)

    expect(enqueue).toHaveBeenCalledWith('tx-manual')
    expect(add).not.toHaveBeenCalled()
  })
```

- [ ] **Step 7: Run both suites**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-deposit-submit.test.ts src/test/deposit-initiate-enqueue.test.ts
```

Expected: PASS. The original "enqueues the created transaction id" test must still pass — the manual path is unchanged.

- [ ] **Step 8: Add the deposit worker**

Create `apps/api/src/workers/zarecash-deposit.worker.ts`:

```ts
/**
 * ZareCash deposit worker.
 *
 * No money has moved when this runs — the player's deposit is PENDING_REVIEW and
 * uncredited — so exhausting retries is a safe (if slow) failure. Contrast the
 * withdrawal worker, where the player is already debited.
 */

import { Worker, Job } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { ZareCashService } from '../services/zarecash.service.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

interface ZareCashDepositJobData {
    transactionId: string
}

const worker = new Worker<ZareCashDepositJobData>(
    QUEUE_NAMES.ZARECASH_DEPOSIT,
    async (job: Job<ZareCashDepositJobData>) => {
        await ZareCashService.submitDeposit(job.data.transactionId)
    },
    {
        connection: {
            url: REDIS_URL,
            maxRetriesPerRequest: null as any,
            enableReadyCheck: false,
        } as any,
        concurrency: 4,
    },
)

worker.on('failed', (job, err) => {
    console.error(`[ZareCashDepositWorker] Job ${job?.id} failed:`, err?.message)
    reportError(err as Error, { worker: 'zarecash-deposit' })
})

worker.on('error', (err) => {
    console.error('[ZareCashDepositWorker] Worker error:', err.message)
    reportError(err, { worker: 'zarecash-deposit' })
})

export default worker
```

In `apps/api/src/index.ts`, add beside the other worker imports:

```ts
import './workers/zarecash-deposit.worker.js'
```

- [ ] **Step 9: Add the permanent-rejection test**

Append to `apps/api/src/test/zarecash-deposit-submit.test.ts`, and add this import at the top of that file:

```ts
import { ZareCashError } from '../gateways/payment/zarecash/types'
```

```ts
  it('rejects locally on a permanent refusal instead of retrying forever', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    ;(prisma as any).transaction.updateMany = vi.fn().mockResolvedValue({ count: 1 })
    createDeposit.mockRejectedValue(
      new ZareCashError({ code: 'duplicate_receipt', message: 'already used', status: 409, permanent: true }),
    )

    await ZareCashService.submitDeposit('tx1')

    expect((prisma as any).transaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx1', status: 'PENDING_REVIEW' },
      data: { status: 'REJECTED', note: expect.stringContaining('duplicate_receipt') },
    })
    expect(approveDeposit).not.toHaveBeenCalled()
  })

  it('rethrows a retryable error so the job retries', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createDeposit.mockRejectedValue(
      new ZareCashError({ code: 'network_error', message: 'ECONNREFUSED', status: 0, permanent: false }),
    )
    await expect(ZareCashService.submitDeposit('tx1')).rejects.toThrow('ECONNREFUSED')
  })
```

Add `updateMany` to the prisma mock at the top of that file:

```ts
    transaction: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
```

- [ ] **Step 10: Run both suites**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-deposit-submit.test.ts src/test/deposit-initiate-enqueue.test.ts
```

Expected: PASS, 7 + 3 tests.

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/services/zarecash.service.ts apps/api/src/services/wallet.service.ts \
        apps/api/src/workers/zarecash-deposit.worker.ts apps/api/src/index.ts \
        apps/api/src/test/zarecash-deposit-submit.test.ts apps/api/src/test/deposit-initiate-enqueue.test.ts
git commit -m "feat(zarecash): route opted-in deposits to ZareCash"
```

---

### Task 7: Webhook receiver

**Files:**
- Create: `apps/api/src/routes/zarecash/webhook.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/test/zarecash-webhook-route.test.ts`

**Interfaces:**
- Consumes: `verifyWebhookSignature`, `SIGNATURE_HEADER` (Task 2); `zarecashConfig` (Task 1).
- Produces: route `POST /v1/zarecash/webhook`. Persists a `ZareCashEvent` row and enqueues `{ eventId }` on `QUEUE_NAMES.ZARECASH_EVENT`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/zarecash-webhook-route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import Fastify from 'fastify'

vi.mock('../lib/prisma', () => ({
  default: { zareCashEvent: { create: vi.fn() } },
}))
const { add } = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/queue', () => ({
  getQueue: () => ({ add }),
  QUEUE_NAMES: { ZARECASH_EVENT: 'zarecash-event' },
}))

import prisma from '../lib/prisma'
import zarecashWebhookRoute from '../routes/zarecash/webhook'

const SECRET = 'whsec_test'

function build() {
  const app = Fastify()
  return app.register(zarecashWebhookRoute, { prefix: '/v1/zarecash/webhook' })
}

function signed(body: string, secret = SECRET, tOverride?: number) {
  const t = tOverride ?? Math.floor(Date.now() / 1000)
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${v1}`
}

const BODY = JSON.stringify({ id: 'evt_1', type: 'deposit.approved', created: 1, data: { id: 'dp_1' } })

describe('POST /v1/zarecash/webhook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ZARECASH_ENABLED = 'true'
    process.env.ZARECASH_API_KEY = 'pk_test_ABC'
    process.env.ZARECASH_WEBHOOK_SECRET = SECRET
  })

  it('accepts a valid delivery, persists it, and enqueues processing', async () => {
    ;(prisma as any).zareCashEvent.create.mockResolvedValue({ id: 'evt_1' })
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/v1/zarecash/webhook', payload: BODY,
      headers: { 'content-type': 'application/json', 'pmv2-signature': signed(BODY) },
    })
    expect(res.statusCode).toBe(200)
    expect((prisma as any).zareCashEvent.create).toHaveBeenCalledWith({
      data: { id: 'evt_1', type: 'deposit.approved', payload: JSON.parse(BODY) },
    })
    expect(add).toHaveBeenCalledWith('process', { eventId: 'evt_1' })
    await app.close()
  })

  it('rejects a bad signature without touching the database', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/v1/zarecash/webhook', payload: BODY,
      headers: { 'content-type': 'application/json', 'pmv2-signature': signed(BODY, 'wrong_secret') },
    })
    expect(res.statusCode).toBe(401)
    expect((prisma as any).zareCashEvent.create).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects a missing signature header', async () => {
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/v1/zarecash/webhook', payload: BODY,
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('returns 200 on redelivery without re-enqueuing', async () => {
    ;(prisma as any).zareCashEvent.create.mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    )
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/v1/zarecash/webhook', payload: BODY,
      headers: { 'content-type': 'application/json', 'pmv2-signature': signed(BODY) },
    })
    expect(res.statusCode).toBe(200)
    expect(add).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects an envelope with no id', async () => {
    const bad = JSON.stringify({ type: 'deposit.approved', data: {} })
    const app = await build()
    const res = await app.inject({
      method: 'POST', url: '/v1/zarecash/webhook', payload: bad,
      headers: { 'content-type': 'application/json', 'pmv2-signature': signed(bad) },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-webhook-route.test.ts
```

Expected: FAIL — cannot resolve `../routes/zarecash/webhook`.

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/zarecash/webhook.ts`:

```ts
/**
 * POST /v1/zarecash/webhook
 *
 * Public, unauthenticated by JWT — the HMAC is the authentication. Verifies over
 * the RAW body, dedupes on the event id, returns 200 immediately, and hands the
 * work to a worker. The contract allows 10 seconds; we use a fraction of it.
 */

import { FastifyPluginAsync } from 'fastify'
import prisma from '../../lib/prisma.js'
import { getQueue, QUEUE_NAMES } from '../../lib/queue.js'
import { zarecashConfig } from '../../gateways/payment/zarecash/config.js'
import { verifyWebhookSignature, SIGNATURE_HEADER } from '../../gateways/payment/zarecash/signature.js'

interface RawBodyPayload {
    __rawBody?: string
    id?: string
    type?: string
    [k: string]: unknown
}

const zarecashWebhookRoute: FastifyPluginAsync = async (fastify) => {
    // Route-scoped raw-body capture — same pattern as routes/hub/spoke-callback.ts.
    fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
        try {
            done(null, { __rawBody: body as string, ...JSON.parse(body as string) })
        } catch (e) {
            done(e as Error, undefined)
        }
    })

    fastify.post('/', async (req, reply) => {
        const cfg = zarecashConfig()
        const payload = req.body as RawBodyPayload
        const raw = payload?.__rawBody ?? ''
        const header = req.headers[SIGNATURE_HEADER] as string | undefined

        if (!verifyWebhookSignature({ secret: cfg.webhookSecret, rawBody: raw, header })) {
            req.log.warn('[ZareCash] webhook rejected: invalid signature')
            return reply.code(401).send({ error: 'invalid_signature' })
        }

        const { __rawBody, ...envelope } = payload
        if (!envelope.id || !envelope.type) {
            return reply.code(400).send({ error: 'invalid_envelope' })
        }

        try {
            await prisma.zareCashEvent.create({
                data: { id: String(envelope.id), type: String(envelope.type), payload: envelope as object },
            })
        } catch (err: any) {
            // P2002 = unique violation = at-least-once redelivery. Already have it.
            if (err?.code === 'P2002') return reply.code(200).send({ received: true, duplicate: true })
            throw err
        }

        await getQueue(QUEUE_NAMES.ZARECASH_EVENT).add('process', { eventId: String(envelope.id) })
        return reply.code(200).send({ received: true })
    })
}

export default zarecashWebhookRoute
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-webhook-route.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Register the route**

In `apps/api/src/index.ts`, add the import beside the other route imports:

```ts
import zarecashWebhookRoute from './routes/zarecash/webhook.js'
```

and register it next to the other `/v1` callback routes (after the `palaceCallbackRoute` line):

```ts
await server.register(zarecashWebhookRoute, { prefix: '/v1/zarecash/webhook' })
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/zarecash/webhook.ts apps/api/src/index.ts apps/api/src/test/zarecash-webhook-route.test.ts
git commit -m "feat(zarecash): receive and dedupe signed webhooks"
```

---

### Task 8: Process deposit events

**Files:**
- Modify: `apps/api/src/services/zarecash.service.ts`
- Create: `apps/api/src/workers/zarecash-event.worker.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/test/zarecash-event-processing.test.ts`

**Interfaces:**
- Produces: `ZareCashService.processEvent(eventId: string): Promise<void>` — loads the row, dispatches on the envelope `type`, stamps `processedAt`, records `error` on failure and rethrows so BullMQ retries.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/zarecash-event-processing.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    zareCashEvent: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    transaction: { findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  },
}))
const { approveDeposit } = vi.hoisted(() => ({ approveDeposit: vi.fn().mockResolvedValue({}) }))
vi.mock('../services/wallet.service', () => ({
  WalletService: { approveDeposit, rejectWithdrawal: vi.fn() },
}))

import prisma from '../lib/prisma'
import { ZareCashService } from '../services/zarecash.service'

function event(type: string, data: Record<string, unknown>) {
  return { id: 'evt_1', type, payload: { id: 'evt_1', type, created: 1, data }, processedAt: null }
}

describe('ZareCashService.processEvent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('credits with approvedAmount on deposit.approved', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('deposit.approved', { id: 'dp_1', approvedAmount: 480, statedAmount: 500 }),
    )
    ;(prisma as any).transaction.findUnique.mockResolvedValue({ id: 'tx1', amount: '500' })

    await ZareCashService.processEvent('evt_1')

    expect((prisma as any).transaction.findUnique).toHaveBeenCalledWith({ where: { gatewayRef: 'dp_1' } })
    expect(approveDeposit).toHaveBeenCalledWith('tx1', 480)
    expect((prisma as any).zareCashEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt_1' }, data: { processedAt: expect.any(Date), error: null },
    })
  })

  it('falls back to the local amount when approvedAmount is absent', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('deposit.approved', { id: 'dp_1', approvedAmount: null }),
    )
    ;(prisma as any).transaction.findUnique.mockResolvedValue({ id: 'tx1', amount: '500' })
    await ZareCashService.processEvent('evt_1')
    expect(approveDeposit).toHaveBeenCalledWith('tx1', 500)
  })

  it('swallows an already-approved replay instead of failing the job', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('deposit.approved', { id: 'dp_1', approvedAmount: 500 }),
    )
    ;(prisma as any).transaction.findUnique.mockResolvedValue({ id: 'tx1', amount: '500' })
    approveDeposit.mockRejectedValueOnce(new Error('Invalid transaction'))

    await expect(ZareCashService.processEvent('evt_1')).resolves.toBeUndefined()
    expect((prisma as any).zareCashEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt_1' }, data: { processedAt: expect.any(Date), error: null },
    })
  })

  it('marks the deposit rejected without touching the wallet', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('deposit.rejected', { id: 'dp_2' }))
    ;(prisma as any).transaction.findUnique.mockResolvedValue({ id: 'tx2', amount: '500' })

    await ZareCashService.processEvent('evt_1')

    expect(approveDeposit).not.toHaveBeenCalled()
    expect((prisma as any).transaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx2', status: 'PENDING_REVIEW' },
      data: { status: 'REJECTED', note: expect.stringContaining('ZareCash') },
    })
  })

  it('skips an event already processed', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue({
      ...event('deposit.approved', { id: 'dp_1' }), processedAt: new Date(),
    })
    await ZareCashService.processEvent('evt_1')
    expect(approveDeposit).not.toHaveBeenCalled()
  })

  it('ignores an unknown event type without failing', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('something.new', {}))
    await expect(ZareCashService.processEvent('evt_1')).resolves.toBeUndefined()
    expect((prisma as any).zareCashEvent.update).toHaveBeenCalled()
  })

  it('records the error and rethrows so BullMQ retries', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('deposit.approved', { id: 'dp_1', approvedAmount: 500 }),
    )
    ;(prisma as any).transaction.findUnique.mockRejectedValue(new Error('db down'))

    await expect(ZareCashService.processEvent('evt_1')).rejects.toThrow('db down')
    expect((prisma as any).zareCashEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt_1' }, data: { error: 'db down' },
    })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-event-processing.test.ts
```

Expected: FAIL — `ZareCashService.processEvent is not a function`.

- [ ] **Step 3: Implement processEvent**

Add to `apps/api/src/services/zarecash.service.ts`. Note the dispatch is on the envelope `type` — the withdrawal payload has no `status` field, so `data.status` is not a usable discriminator.

```ts
    /**
     * Dispatch a received webhook.
     *
     * Keyed on the envelope `type`, never on `data.status`: the withdrawal payload
     * (WithdrawalsService.payload) carries no status field at all.
     */
    static async processEvent(eventId: string): Promise<void> {
        const row = await prisma.zareCashEvent.findUnique({ where: { id: eventId } })
        if (!row || row.processedAt) return

        const envelope = row.payload as { type?: string; data?: Record<string, any> }
        const data = envelope?.data ?? {}

        try {
            switch (row.type) {
                case 'deposit.approved':
                    await ZareCashService.onDepositApproved(data)
                    break
                case 'deposit.rejected':
                    await ZareCashService.onDepositRejected(data)
                    break
                default:
                    console.log('[ZareCash] unhandled event type %s (%s)', row.type, eventId)
            }
            await prisma.zareCashEvent.update({
                where: { id: eventId },
                data: { processedAt: new Date(), error: null },
            })
        } catch (err) {
            await prisma.zareCashEvent.update({
                where: { id: eventId },
                data: { error: (err as Error).message },
            })
            throw err
        }
    }

    private static async findByGatewayRef(gatewayRef: unknown) {
        if (!gatewayRef) return null
        return prisma.transaction.findUnique({ where: { gatewayRef: String(gatewayRef) } })
    }

    private static async onDepositApproved(data: Record<string, any>): Promise<void> {
        const tx = await ZareCashService.findByGatewayRef(data.id)
        if (!tx) {
            console.warn('[ZareCash] deposit.approved for unknown gatewayRef %s', data.id)
            return
        }
        const amount = data.approvedAmount ?? Number(tx.amount)
        try {
            await WalletService.approveDeposit(tx.id, amount)
        } catch (err) {
            // approveDeposit throws when the row is no longer PENDING_REVIEW, which
            // is exactly what a redelivery looks like. Not an error.
            console.log('[ZareCash] deposit %s not credited: %s', tx.id, (err as Error).message)
        }
    }

    private static async onDepositRejected(data: Record<string, any>): Promise<void> {
        const tx = await ZareCashService.findByGatewayRef(data.id)
        if (!tx) {
            console.warn('[ZareCash] deposit.rejected for unknown gatewayRef %s', data.id)
            return
        }
        // No wallet change — a deposit is never credited before approval.
        await prisma.transaction.updateMany({
            where: { id: tx.id, status: PaymentStatus.PENDING_REVIEW },
            data: {
                status: PaymentStatus.REJECTED,
                note: `Rejected by ZareCash${data.verdict ? `: ${data.verdict}` : ''}`,
            },
        })
    }
```

Add to the imports at the top of `zarecash.service.ts` (if not already added in Task 6):

```ts
import { PaymentStatus } from '@world-bingo/shared-types'
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-event-processing.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Add the worker**

Create `apps/api/src/workers/zarecash-event.worker.ts`:

```ts
/**
 * ZareCash event worker — processes webhook deliveries recorded by the route.
 * Keyed on the event id, so a redelivery or a sweep replay is a no-op.
 */

import { Worker, Job } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { ZareCashService } from '../services/zarecash.service.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

interface ZareCashEventJobData {
    eventId: string
}

const worker = new Worker<ZareCashEventJobData>(
    QUEUE_NAMES.ZARECASH_EVENT,
    async (job: Job<ZareCashEventJobData>) => {
        await ZareCashService.processEvent(job.data.eventId)
    },
    {
        connection: {
            url: REDIS_URL,
            maxRetriesPerRequest: null as any,
            enableReadyCheck: false,
        } as any,
        concurrency: 4,
    },
)

worker.on('failed', (job, err) => {
    console.error(`[ZareCashEventWorker] Job ${job?.id} failed:`, err?.message)
    reportError(err as Error, { worker: 'zarecash-event' })
})

worker.on('error', (err) => {
    console.error('[ZareCashEventWorker] Worker error:', err.message)
    reportError(err, { worker: 'zarecash-event' })
})

export default worker
```

In `apps/api/src/index.ts`, add beside the other worker imports:

```ts
import './workers/zarecash-event.worker.js'
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/zarecash.service.ts apps/api/src/workers/zarecash-event.worker.ts \
        apps/api/src/index.ts apps/api/src/test/zarecash-event-processing.test.ts
git commit -m "feat(zarecash): process deposit webhook events through approveDeposit"
```

---

### Task 9: Submit withdrawals with refund-on-failure

The riskiest task in the plan: the player is already debited when this code runs.

**Files:**
- Modify: `apps/api/src/services/zarecash.service.ts`
- Modify: `apps/api/src/services/wallet.service.ts` (`requestWithdrawal`)
- Create: `apps/api/src/workers/zarecash-withdrawal.worker.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/test/zarecash-withdrawal-submit.test.ts`

**Interfaces:**
- Produces: `ZareCashService.submitWithdrawal(job: { transactionId, methodCode, destinationAccount, destinationName? }): Promise<void>`.

Routing data is passed explicitly on the job rather than parsed back out of `Transaction.note`, which stores the free-form string `` `${paymentMethod}: ${accountNumber}` ``. Round-tripping money-routing data through a display string is how payouts reach the wrong account.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/zarecash-withdrawal-submit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: { transaction: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) } },
}))
const { createWithdrawal } = vi.hoisted(() => ({ createWithdrawal: vi.fn() }))
vi.mock('../gateways/payment/zarecash/client', () => ({ zarecashClient: () => ({ createWithdrawal }) }))
const { rejectWithdrawal } = vi.hoisted(() => ({ rejectWithdrawal: vi.fn().mockResolvedValue({}) }))
vi.mock('../services/wallet.service', () => ({
  WalletService: { rejectWithdrawal, approveDeposit: vi.fn() },
}))
vi.mock('../gateways/payment/zarecash/method-config', () => ({
  resolveMethod: vi.fn().mockResolvedValue({
    code: 'telebirr', name: 'TeleBirr', gateway: 'zarecash', gatewayMethodCode: 'telebirr',
    collectionAccount: { receiverName: 'ZC', account: '0911' },
  }),
}))

import prisma from '../lib/prisma'
import { ZareCashService } from '../services/zarecash.service'
import { ZareCashError } from '../gateways/payment/zarecash/types'

const JOB = { transactionId: 'tx1', methodCode: 'telebirr', destinationAccount: '0912345678', destinationName: 'Abebe' }
const TX = { id: 'tx1', userId: 'u1', amount: '500', status: 'PENDING_REVIEW' }

describe('ZareCashService.submitWithdrawal', () => {
  beforeEach(() => vi.clearAllMocks())

  it('submits with a derived key and stores the gatewayRef on pending', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockResolvedValue({ id: 'wd_1', state: 'pending' })

    await ZareCashService.submitWithdrawal(JOB)

    expect(createWithdrawal).toHaveBeenCalledWith(
      { playerRef: 'u1', amount: 500, methodCode: 'telebirr', destinationAccount: '0912345678', destinationName: 'Abebe' },
      'wd_tx1',
    )
    expect((prisma as any).transaction.update).toHaveBeenCalledWith({
      where: { id: 'tx1' }, data: { gatewayRef: 'wd_1' },
    })
    expect(rejectWithdrawal).not.toHaveBeenCalled()
  })

  it('keeps the payout pending on queued_float', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockResolvedValue({ id: 'wd_2', state: 'queued_float' })
    await ZareCashService.submitWithdrawal(JOB)
    expect(rejectWithdrawal).not.toHaveBeenCalled()
  })

  it('refunds when ZareCash rejects outright', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockResolvedValue({ id: 'wd_3', state: 'rejected' })
    await ZareCashService.submitWithdrawal(JOB)
    expect(rejectWithdrawal).toHaveBeenCalledWith('tx1', expect.stringContaining('ZareCash'))
  })

  it('refunds on a permanent error so the player is not left debited', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockRejectedValue(
      new ZareCashError({ code: 'player_frozen', message: 'frozen', status: 403, permanent: true }),
    )
    await ZareCashService.submitWithdrawal(JOB)
    expect(rejectWithdrawal).toHaveBeenCalledWith('tx1', expect.stringContaining('player_frozen'))
  })

  it('rethrows a retryable error and does NOT refund', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockRejectedValue(
      new ZareCashError({ code: 'network_error', message: 'ECONNREFUSED', status: 0, permanent: false }),
    )
    await expect(ZareCashService.submitWithdrawal(JOB)).rejects.toThrow('ECONNREFUSED')
    expect(rejectWithdrawal).not.toHaveBeenCalled()
  })

  it('never refunds on withdrawal_pending — a payout may be in flight', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    createWithdrawal.mockRejectedValue(
      new ZareCashError({ code: 'withdrawal_pending', message: 'open payout', status: 409, permanent: false }),
    )
    await expect(ZareCashService.submitWithdrawal(JOB)).rejects.toThrow()
    expect(rejectWithdrawal).not.toHaveBeenCalled()
  })

  it('is a no-op when the withdrawal is no longer pending', async () => {
    ;(prisma as any).transaction.findUnique.mockResolvedValue({ ...TX, status: 'REJECTED' })
    await ZareCashService.submitWithdrawal(JOB)
    expect(createWithdrawal).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-withdrawal-submit.test.ts
```

Expected: FAIL — `ZareCashService.submitWithdrawal is not a function`.

- [ ] **Step 3: Implement submitWithdrawal**

Add to `apps/api/src/services/zarecash.service.ts`:

```ts
    /**
     * Submit a payout the player has ALREADY been debited for.
     *
     * A permanent failure must refund, or the player stays debited for a payout
     * that was never accepted. A retryable failure must NOT refund — the job
     * retries. `withdrawal_pending` is classified retryable on purpose: it means
     * our state and ZareCash's disagree, and refunding could double-pay a payout
     * that is genuinely in flight. The sweep resolves it.
     */
    static async submitWithdrawal(job: {
        transactionId: string
        methodCode: string
        destinationAccount: string
        destinationName?: string
    }): Promise<void> {
        const tx = await prisma.transaction.findUnique({ where: { id: job.transactionId } })
        if (!tx || tx.status !== PaymentStatus.PENDING_REVIEW) return

        const method = await resolveMethod(job.methodCode)

        let res
        try {
            res = await zarecashClient().createWithdrawal(
                {
                    playerRef: tx.userId,
                    amount: Number(tx.amount),
                    methodCode: method?.gatewayMethodCode ?? job.methodCode,
                    destinationAccount: job.destinationAccount,
                    destinationName: job.destinationName,
                },
                ZareCashService.withdrawalKey(job.transactionId),
            )
        } catch (err) {
            const zc = err as ZareCashError
            if (zc?.permanent) {
                await WalletService.rejectWithdrawal(
                    job.transactionId,
                    `ZareCash refused the payout (${zc.code}): ${zc.message}`,
                )
                return
            }
            throw err
        }

        await prisma.transaction.update({ where: { id: job.transactionId }, data: { gatewayRef: res.id } })

        if (res.state === 'rejected') {
            await WalletService.rejectWithdrawal(job.transactionId, 'ZareCash rejected the payout')
        }
        // pending / queued_float / risk_hold all stay PENDING_REVIEW here; the
        // terminal state arrives as a webhook.
    }
```

`ZareCashError` and `PaymentStatus` were already imported in Task 6 — no new imports here.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-withdrawal-submit.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Enqueue from requestWithdrawal**

In `apps/api/src/services/wallet.service.ts`, in `requestWithdrawal`, replace the `.then(...)` block at the end with:

```ts
        }).then(async ({ transaction, realAfter, bonusBefore }) => {
            // Push balance update
            NotificationService.pushWalletUpdate(userId, realAfter.toNumber(), bonusBefore.toNumber())

            // Submit AFTER the DB transaction commits — never hold the wallet lock
            // across a network call. Routing data travels on the job rather than
            // being parsed back out of the free-form `note` string.
            if (await isZareCashMethod(data.paymentMethod)) {
                await getQueue(QUEUE_NAMES.ZARECASH_WITHDRAWAL).add('submit', {
                    transactionId: transaction.id,
                    methodCode: data.paymentMethod,
                    destinationAccount: data.accountNumber,
                })
            }
            return transaction
        })
```

Add to the imports at the top of `wallet.service.ts`:

```ts
import { getQueue, QUEUE_NAMES } from '../lib/queue'
```

- [ ] **Step 6: Add the worker**

Create `apps/api/src/workers/zarecash-withdrawal.worker.ts`:

```ts
/**
 * ZareCash withdrawal worker.
 *
 * The player is already debited when this runs. `submitWithdrawal` refunds on a
 * permanent failure and rethrows on a retryable one; when retries are exhausted,
 * the `failed` handler below performs the terminal refund.
 */

import { Worker, Job } from 'bullmq'
import { QUEUE_NAMES } from '../lib/queue.js'
import { ZareCashService } from '../services/zarecash.service.js'
import { WalletService } from '../services/wallet.service.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const MAX_ATTEMPTS = Number(process.env.ZARECASH_WITHDRAWAL_ATTEMPTS || '8')

interface ZareCashWithdrawalJobData {
    transactionId: string
    methodCode: string
    destinationAccount: string
    destinationName?: string
}

const worker = new Worker<ZareCashWithdrawalJobData>(
    QUEUE_NAMES.ZARECASH_WITHDRAWAL,
    async (job: Job<ZareCashWithdrawalJobData>) => {
        await ZareCashService.submitWithdrawal(job.data)
    },
    {
        connection: {
            url: REDIS_URL,
            maxRetriesPerRequest: null as any,
            enableReadyCheck: false,
        } as any,
        concurrency: 2,
    },
)

worker.on('failed', async (job, err) => {
    console.error(`[ZareCashWithdrawalWorker] Job ${job?.id} failed:`, err?.message)
    reportError(err as Error, { worker: 'zarecash-withdrawal' })

    // Retries exhausted: the player is still debited for a payout that was never
    // accepted. Refund is the only safe terminal state.
    if (job && job.attemptsMade >= (job.opts.attempts ?? MAX_ATTEMPTS)) {
        try {
            await WalletService.rejectWithdrawal(
                job.data.transactionId,
                `Could not reach ZareCash after ${job.attemptsMade} attempts — refunded`,
            )
        } catch (refundErr) {
            console.error('[ZareCashWithdrawalWorker] terminal refund failed:', (refundErr as Error).message)
            reportError(refundErr as Error, { worker: 'zarecash-withdrawal', phase: 'terminal-refund' })
        }
    }
})

worker.on('error', (err) => {
    console.error('[ZareCashWithdrawalWorker] Worker error:', err.message)
    reportError(err, { worker: 'zarecash-withdrawal' })
})

export default worker
```

In `apps/api/src/index.ts`:

```ts
import './workers/zarecash-withdrawal.worker.js'
```

- [ ] **Step 7: Run the full suite**

```bash
pnpm --filter @world-bingo/api test
```

Expected: **27 failed | 944 passed**, matching `baseline-failures.txt` exactly. `withdrawal.service.test.ts` exercises `requestWithdrawal`, so an unchanged failure set is what proves the manual path is unaffected. A 28th failure is yours.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/zarecash.service.ts apps/api/src/services/wallet.service.ts \
        apps/api/src/workers/zarecash-withdrawal.worker.ts apps/api/src/index.ts \
        apps/api/src/test/zarecash-withdrawal-submit.test.ts
git commit -m "feat(zarecash): submit payouts with refund-on-permanent-failure"
```

---

### Task 10: Process withdrawal events

**Files:**
- Modify: `apps/api/src/services/zarecash.service.ts`
- Test: `apps/api/src/test/zarecash-withdrawal-events.test.ts`

**Interfaces:**
- Consumes: `WalletService.rejectWithdrawal` (Task 5), `ZareCashService.processEvent` dispatch (Task 8).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/zarecash-withdrawal-events.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    zareCashEvent: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    transaction: { findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  },
}))
const { rejectWithdrawal } = vi.hoisted(() => ({ rejectWithdrawal: vi.fn().mockResolvedValue({}) }))
vi.mock('../services/wallet.service', () => ({
  WalletService: { rejectWithdrawal, approveDeposit: vi.fn() },
}))
const { create } = vi.hoisted(() => ({ create: vi.fn().mockResolvedValue({}) }))
vi.mock('../services/notification.service', () => ({
  NotificationService: { create, pushWalletUpdate: vi.fn() },
}))

import prisma from '../lib/prisma'
import { ZareCashService } from '../services/zarecash.service'

function event(type: string, data: Record<string, unknown>) {
  return { id: 'evt_x', type, payload: { id: 'evt_x', type, created: 1, data }, processedAt: null }
}
const TX = { id: 'tx1', userId: 'u1', amount: '500', status: 'PENDING_REVIEW' }

describe('withdrawal webhook events', () => {
  beforeEach(() => vi.clearAllMocks())

  it('settles the withdrawal and records the settlementRef', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('withdrawal.approved', { id: 'wd_1', settlementRef: 'STL-123456789' }),
    )
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)

    await ZareCashService.processEvent('evt_x')

    expect((prisma as any).transaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx1', status: 'PENDING_REVIEW' },
      data: { status: 'APPROVED', note: expect.stringContaining('STL-123456789') },
    })
    expect(rejectWithdrawal).not.toHaveBeenCalled()
  })

  it('refunds on withdrawal.rejected', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('withdrawal.rejected', { id: 'wd_2' }))
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    await ZareCashService.processEvent('evt_x')
    expect(rejectWithdrawal).toHaveBeenCalledWith('tx1', expect.stringContaining('ZareCash'))
  })

  it('refunds on withdrawal.cancelled', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('withdrawal.cancelled', { id: 'wd_3' }))
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    await ZareCashService.processEvent('evt_x')
    expect(rejectWithdrawal).toHaveBeenCalledWith('tx1', expect.stringContaining('cancelled'))
  })

  it('keeps queued_float pending and notifies the player', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('withdrawal.queued_float', { id: 'wd_4' }))
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    await ZareCashService.processEvent('evt_x')
    expect(rejectWithdrawal).not.toHaveBeenCalled()
    expect((prisma as any).transaction.updateMany).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalled()
  })

  it('keeps risk_hold pending without notifying the player', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('withdrawal.risk_hold', { id: 'wd_5' }))
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    await ZareCashService.processEvent('evt_x')
    expect(rejectWithdrawal).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('tolerates a refund replay for an already-rejected withdrawal', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(event('withdrawal.rejected', { id: 'wd_2' }))
    ;(prisma as any).transaction.findUnique.mockResolvedValue(TX)
    rejectWithdrawal.mockRejectedValueOnce(new Error('Transaction is not pending review'))
    await expect(ZareCashService.processEvent('evt_x')).resolves.toBeUndefined()
  })

  it('logs float.low without touching any transaction', async () => {
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(
      event('float.low', { available: 5000, lowFloatThreshold: 100000 }),
    )
    await ZareCashService.processEvent('evt_x')
    expect((prisma as any).transaction.findUnique).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-withdrawal-events.test.ts
```

Expected: FAIL — withdrawal event types fall through to the `default` branch, so no assertion fires.

- [ ] **Step 3: Add the withdrawal cases**

In `apps/api/src/services/zarecash.service.ts`, add these cases to the `switch` in `processEvent`, before `default`:

```ts
                case 'withdrawal.approved':
                    await ZareCashService.onWithdrawalApproved(data)
                    break
                case 'withdrawal.rejected':
                    await ZareCashService.onWithdrawalRefunded(data, 'ZareCash rejected the payout')
                    break
                case 'withdrawal.cancelled':
                    await ZareCashService.onWithdrawalRefunded(data, 'Payout was cancelled at ZareCash')
                    break
                case 'withdrawal.queued_float':
                    await ZareCashService.onWithdrawalQueued(data)
                    break
                case 'withdrawal.risk_hold':
                    console.warn('[ZareCash] withdrawal %s placed on risk hold', data.id)
                    break
                case 'float.low':
                    console.warn(
                        '[ZareCash] float low: available=%s threshold=%s',
                        data.available,
                        data.lowFloatThreshold,
                    )
                    break
```

and add the handlers alongside the deposit ones:

```ts
    private static async onWithdrawalApproved(data: Record<string, any>): Promise<void> {
        const tx = await ZareCashService.findByGatewayRef(data.id)
        if (!tx) {
            console.warn('[ZareCash] withdrawal.approved for unknown gatewayRef %s', data.id)
            return
        }
        const claim = await prisma.transaction.updateMany({
            where: { id: tx.id, status: PaymentStatus.PENDING_REVIEW },
            data: {
                status: PaymentStatus.APPROVED,
                note: `Settled by ZareCash${data.settlementRef ? ` (ref ${data.settlementRef})` : ''}`,
            },
        })
        if (claim.count === 0) return // redelivery

        await NotificationService.create(
            tx.userId,
            NotificationType.WITHDRAWAL_PROCESSED,
            'Withdrawal Processed ✅',
            `Your withdrawal of ${Number(tx.amount).toFixed(2)} ETB has been transferred.`,
            { transactionId: tx.id, amount: Number(tx.amount) },
        ).catch(() => {})
        wbWithdrawalsTotal.labels('approved').inc()
    }

    private static async onWithdrawalRefunded(data: Record<string, any>, reason: string): Promise<void> {
        const tx = await ZareCashService.findByGatewayRef(data.id)
        if (!tx) {
            console.warn('[ZareCash] withdrawal refund for unknown gatewayRef %s', data.id)
            return
        }
        try {
            await WalletService.rejectWithdrawal(tx.id, reason)
        } catch (err) {
            // Already terminal — this is a redelivery, not a failure.
            console.log('[ZareCash] withdrawal %s not refunded: %s', tx.id, (err as Error).message)
        }
    }

    private static async onWithdrawalQueued(data: Record<string, any>): Promise<void> {
        const tx = await ZareCashService.findByGatewayRef(data.id)
        if (!tx) return
        // Stays PENDING_REVIEW — queued_float is a normal state, not a fault.
        await NotificationService.create(
            tx.userId,
            NotificationType.WITHDRAWAL_PROCESSED,
            'Withdrawal Processing',
            `Your withdrawal of ${Number(tx.amount).toFixed(2)} ETB is queued and will be paid shortly.`,
            { transactionId: tx.id, amount: Number(tx.amount) },
        ).catch(() => {})
    }
```

Add to the imports at the top of `zarecash.service.ts`:

```ts
import { NotificationType } from '@world-bingo/shared-types'
import { NotificationService } from './notification.service.js'
import { wbWithdrawalsTotal } from '../lib/metrics.js'
```

- [ ] **Step 4: Run both event suites**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-withdrawal-events.test.ts src/test/zarecash-event-processing.test.ts
```

Expected: PASS, 7 + 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/zarecash.service.ts apps/api/src/test/zarecash-withdrawal-events.test.ts
git commit -m "feat(zarecash): handle withdrawal webhook events"
```

---

### Task 11: Boot assertion and reconciliation sweep

**Files:**
- Modify: `apps/api/src/services/zarecash.service.ts`
- Create: `apps/api/src/workers/zarecash-sweep.worker.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/test/zarecash-sweep.test.ts`

**Interfaces:**
- Produces: `ZareCashService.assertMode(): Promise<void>` — throws when the live `mode` disagrees with `ZARECASH_MODE`.
- Produces: `ZareCashService.sweepEvents(): Promise<{ scanned: number; replayed: number }>`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/zarecash-sweep.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    zareCashEvent: { findMany: vi.fn(), create: vi.fn().mockResolvedValue({}) },
    siteSetting: { findUnique: vi.fn(), upsert: vi.fn().mockResolvedValue({}) },
  },
}))
const { listEvents, getFloat } = vi.hoisted(() => ({ listEvents: vi.fn(), getFloat: vi.fn() }))
vi.mock('../gateways/payment/zarecash/client', () => ({ zarecashClient: () => ({ listEvents, getFloat }) }))
const { add } = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/queue', () => ({
  getQueue: () => ({ add }),
  QUEUE_NAMES: { ZARECASH_EVENT: 'zarecash-event', ZARECASH_SWEEP: 'zarecash-sweep' },
}))

import prisma from '../lib/prisma'
import { ZareCashService } from '../services/zarecash.service'

describe('ZareCashService.assertMode', () => {
  const ORIGINAL = { ...process.env }
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ZARECASH_ENABLED = 'true'
    process.env.ZARECASH_API_KEY = 'pk_test_ABC'
    process.env.ZARECASH_WEBHOOK_SECRET = 'whsec'
    process.env.ZARECASH_MODE = 'test'
  })
  afterEach(() => { process.env = { ...ORIGINAL } })

  it('passes when the remote mode matches', async () => {
    getFloat.mockResolvedValue({ mode: 'test', balance: 1, reserved: 0, available: 1, lowFloatThreshold: 0, queuedWithdrawals: 0 })
    await expect(ZareCashService.assertMode()).resolves.toBeUndefined()
  })

  it('throws when a live key is configured as test', async () => {
    getFloat.mockResolvedValue({ mode: 'live', balance: 1, reserved: 0, available: 1, lowFloatThreshold: 0, queuedWithdrawals: 0 })
    await expect(ZareCashService.assertMode()).rejects.toThrow(/mode mismatch/i)
  })
})

describe('ZareCashService.sweepEvents', () => {
  beforeEach(() => vi.clearAllMocks())

  it('inserts and enqueues only events we have never seen', async () => {
    ;(prisma as any).siteSetting.findUnique.mockResolvedValue(null)
    listEvents.mockResolvedValue({
      data: [
        { id: 'evt_1', type: 'deposit.approved', created: 1, data: { id: 'dp_1' } },
        { id: 'evt_2', type: 'deposit.rejected', created: 2, data: { id: 'dp_2' } },
      ],
      nextCursor: null,
    })
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([{ id: 'evt_1' }])

    const result = await ZareCashService.sweepEvents()

    expect(result).toEqual({ scanned: 2, replayed: 1 })
    expect((prisma as any).zareCashEvent.create).toHaveBeenCalledTimes(1)
    expect((prisma as any).zareCashEvent.create).toHaveBeenCalledWith({
      data: { id: 'evt_2', type: 'deposit.rejected', payload: expect.objectContaining({ id: 'evt_2' }) },
    })
    expect(add).toHaveBeenCalledWith('process', { eventId: 'evt_2' })
  })

  it('stores the cursor for the next run', async () => {
    ;(prisma as any).siteSetting.findUnique.mockResolvedValue(null)
    listEvents.mockResolvedValue({ data: [], nextCursor: 'cur_42' })
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([])

    await ZareCashService.sweepEvents()

    expect((prisma as any).siteSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'zarecash_events_cursor' },
      create: { key: 'zarecash_events_cursor', value: 'cur_42' },
      update: { value: 'cur_42' },
    })
  })

  it('resumes from the stored cursor', async () => {
    ;(prisma as any).siteSetting.findUnique.mockResolvedValue({ key: 'zarecash_events_cursor', value: 'cur_7' })
    listEvents.mockResolvedValue({ data: [], nextCursor: null })
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([])

    await ZareCashService.sweepEvents()

    expect(listEvents).toHaveBeenCalledWith({ cursor: 'cur_7', limit: 100 })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-sweep.test.ts
```

Expected: FAIL — `ZareCashService.assertMode is not a function`.

- [ ] **Step 3: Implement**

Add to `apps/api/src/services/zarecash.service.ts`:

```ts
    const CURSOR_KEY = 'zarecash_events_cursor'

    /**
     * Refuse to run against the wrong keyspace. Contract checklist item 9 — the
     * cheapest guard against a test key in production, or a live key in CI.
     */
    static async assertMode(): Promise<void> {
        const cfg = zarecashConfig()
        if (!cfg.enabled) return
        const float = await zarecashClient().getFloat()
        if (float.mode !== cfg.mode) {
            throw new Error(
                `ZareCash mode mismatch: ZARECASH_MODE=${cfg.mode} but the API key reports "${float.mode}". Refusing to start.`,
            )
        }
        console.log('[ZareCash] connected in %s mode (available float: %s ETB)', float.mode, float.available)
    }

    /**
     * Backfill anything a webhook outage lost. Events carry full payloads, so no
     * follow-up fetch is needed, and processing is keyed on the event id, so a
     * replay of something already handled is a no-op.
     */
    static async sweepEvents(): Promise<{ scanned: number; replayed: number }> {
        const cursorRow = await prisma.siteSetting.findUnique({ where: { key: CURSOR_KEY } })
        const page = await zarecashClient().listEvents({
            cursor: cursorRow?.value ?? undefined,
            limit: 100,
        })

        const scanned = page.data.length
        let replayed = 0

        if (scanned > 0) {
            const ids = page.data.map((e) => e.id)
            const known = await prisma.zareCashEvent.findMany({
                where: { id: { in: ids } },
                select: { id: true },
            })
            const knownIds = new Set(known.map((k) => k.id))

            for (const evt of page.data) {
                if (knownIds.has(evt.id)) continue
                await prisma.zareCashEvent.create({
                    data: { id: evt.id, type: evt.type, payload: evt as unknown as object },
                })
                await getQueue(QUEUE_NAMES.ZARECASH_EVENT).add('process', { eventId: evt.id })
                replayed++
            }
        }

        if (page.nextCursor) {
            await prisma.siteSetting.upsert({
                where: { key: CURSOR_KEY },
                create: { key: CURSOR_KEY, value: page.nextCursor },
                update: { value: page.nextCursor },
            })
        }

        return { scanned, replayed }
    }
```

Move `const CURSOR_KEY = 'zarecash_events_cursor'` to module scope, above the `export class ZareCashService {` line — a `const` cannot sit directly in a class body.

Add to the imports at the top of `zarecash.service.ts`:

```ts
import { zarecashConfig } from '../gateways/payment/zarecash/config.js'
import { getQueue, QUEUE_NAMES } from '../lib/queue.js'
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-sweep.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Add the sweep worker and boot assertion**

Create `apps/api/src/workers/zarecash-sweep.worker.ts`:

```ts
/**
 * Nightly reconciliation sweep. A webhook outage is only survivable because of
 * this — see contract checklist item 7.
 */

import { Worker, Job } from 'bullmq'
import { getQueue, QUEUE_NAMES } from '../lib/queue.js'
import { ZareCashService } from '../services/zarecash.service.js'
import { isZareCashEnabled } from '../gateways/payment/zarecash/config.js'
import { reportError } from '../lib/sentry.js'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

const worker = new Worker(
    QUEUE_NAMES.ZARECASH_SWEEP,
    async (_job: Job) => {
        const result = await ZareCashService.sweepEvents()
        console.log('[ZareCashSweep] scanned=%d replayed=%d', result.scanned, result.replayed)
        return result
    },
    {
        connection: {
            url: REDIS_URL,
            maxRetriesPerRequest: null as any,
            enableReadyCheck: false,
        } as any,
        concurrency: 1,
    },
)

worker.on('failed', (job, err) => {
    console.error(`[ZareCashSweep] Job ${job?.id} failed:`, err?.message)
    reportError(err as Error, { worker: 'zarecash-sweep' })
})

/** Schedule the nightly run. Idempotent — BullMQ dedupes on the repeat key. */
export async function scheduleZareCashSweep(): Promise<void> {
    if (!isZareCashEnabled()) return
    await getQueue(QUEUE_NAMES.ZARECASH_SWEEP).add(
        'sweep',
        {},
        { repeat: { pattern: '0 3 * * *' }, jobId: 'zarecash-nightly-sweep' },
    )
}

export default worker
```

In `apps/api/src/index.ts`, add the import beside the other workers:

```ts
import './workers/zarecash-sweep.worker.js'
import { scheduleZareCashSweep } from './workers/zarecash-sweep.worker.js'
import { ZareCashService } from './services/zarecash.service.js'
```

and near the existing startup work (beside the stuck-game recovery), add:

```ts
if (isZareCashEnabled()) {
    await ZareCashService.assertMode()
    await scheduleZareCashSweep()
}
```

with `import { isZareCashEnabled } from './gateways/payment/zarecash/config.js'` added to the imports.

- [ ] **Step 6: Run the full suite and typecheck**

```bash
pnpm --filter @world-bingo/api test; pnpm --filter @world-bingo/api typecheck
```

Expected: the test run matches `baseline-failures.txt` (27 failed | 944 passed) plus your new suites passing; typecheck PASSES with no errors. Note the `;` rather than `&&` — the test command exits non-zero on the pre-existing failures, which would otherwise skip the typecheck.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/zarecash.service.ts apps/api/src/workers/zarecash-sweep.worker.ts \
        apps/api/src/index.ts apps/api/src/test/zarecash-sweep.test.ts
git commit -m "feat(zarecash): assert keyspace at boot and sweep events nightly"
```

---

### Task 12: Freeze sync

**Files:**
- Modify: `apps/api/src/services/zarecash.service.ts`
- Modify: `apps/api/src/services/admin.service.ts`
- Test: `apps/api/src/test/zarecash-freeze-sync.test.ts`

**Interfaces:**
- Produces: `ZareCashService.syncPlayerFreeze(userId: string, frozen: boolean, reason: string): Promise<void>` — best-effort, never throws.

- [ ] **Step 1: Find the freeze call site**

```bash
grep -n "isActive" apps/api/src/services/admin.service.ts
```

Note the method that sets `isActive` on a user — that is where the sync hooks in. Record its name before continuing.

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/test/zarecash-freeze-sync.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { freezePlayer, unfreezePlayer } = vi.hoisted(() => ({
  freezePlayer: vi.fn().mockResolvedValue({}),
  unfreezePlayer: vi.fn().mockResolvedValue({}),
}))
vi.mock('../gateways/payment/zarecash/client', () => ({
  zarecashClient: () => ({ freezePlayer, unfreezePlayer }),
}))
vi.mock('../lib/prisma', () => ({ default: {} }))

import { ZareCashService } from '../services/zarecash.service'

describe('ZareCashService.syncPlayerFreeze', () => {
  const ORIGINAL = { ...process.env }
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ZARECASH_ENABLED = 'true'
    process.env.ZARECASH_API_KEY = 'pk_test_ABC'
    process.env.ZARECASH_WEBHOOK_SECRET = 'whsec'
    process.env.ZARECASH_MODE = 'test'
  })

  it('freezes the player upstream', async () => {
    await ZareCashService.syncPlayerFreeze('u1', true, 'fraud review')
    expect(freezePlayer).toHaveBeenCalledWith('u1', 'fraud review')
    expect(unfreezePlayer).not.toHaveBeenCalled()
  })

  it('unfreezes the player upstream', async () => {
    await ZareCashService.syncPlayerFreeze('u1', false, 'reinstated')
    expect(unfreezePlayer).toHaveBeenCalledWith('u1', 'reinstated')
  })

  it('never throws — a failed sync must not block the local freeze', async () => {
    freezePlayer.mockRejectedValue(new Error('upstream down'))
    await expect(ZareCashService.syncPlayerFreeze('u1', true, 'fraud')).resolves.toBeUndefined()
  })

  it('does nothing when ZareCash is disabled', async () => {
    process.env.ZARECASH_ENABLED = 'false'
    await ZareCashService.syncPlayerFreeze('u1', true, 'fraud')
    expect(freezePlayer).not.toHaveBeenCalled()
    process.env = { ...ORIGINAL }
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-freeze-sync.test.ts
```

Expected: FAIL — `ZareCashService.syncPlayerFreeze is not a function`.

- [ ] **Step 4: Implement**

Add to `apps/api/src/services/zarecash.service.ts`:

```ts
    /**
     * Mirror a local freeze upstream. Best-effort by design: the LOCAL freeze is
     * the one that protects our own balance, so a failed sync must never block it.
     * Deposits are unaffected on both sides — a frozen player can still fund.
     */
    static async syncPlayerFreeze(userId: string, frozen: boolean, reason: string): Promise<void> {
        if (!isZareCashEnabled()) return
        try {
            const client = zarecashClient()
            if (frozen) await client.freezePlayer(userId, reason)
            else await client.unfreezePlayer(userId, reason)
        } catch (err) {
            console.error('[ZareCash] freeze sync failed for %s: %s', userId, (err as Error).message)
        }
    }
```

Extend the config import at the top of `zarecash.service.ts`:

```ts
import { zarecashConfig, isZareCashEnabled } from '../gateways/payment/zarecash/config.js'
```

- [ ] **Step 5: Call it from the admin freeze path**

In the method identified in Step 1, immediately after the `prisma.user.update({ ... isActive ... })` call, add:

```ts
        // Best-effort mirror; never throws.
        await ZareCashService.syncPlayerFreeze(userId, !isActive, reason ?? 'Admin action')
```

Adjust `userId`, `isActive`, and `reason` to match the local variable names in that method. Add `import { ZareCashService } from './zarecash.service'` to the imports.

- [ ] **Step 6: Run the suite**

```bash
pnpm --filter @world-bingo/api test src/test/zarecash-freeze-sync.test.ts src/test/admin.service.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/zarecash.service.ts apps/api/src/services/admin.service.ts \
        apps/api/src/test/zarecash-freeze-sync.test.ts
git commit -m "feat(zarecash): mirror player freezes upstream"
```

---

### Task 13: Sandbox verification against the deployed instance

Not TDD — this exercises the real API. Requires test credentials.

**Files:**
- Create: `apps/api/scripts/zarecash-sandbox.md` (a runbook, checked in)

- [ ] **Step 1: Configure the test key**

Set in `apps/api/.env` (never commit):

```
ZARECASH_ENABLED=true
ZARECASH_BASE_URL=<deployed base url>
ZARECASH_API_KEY=pk_test_...
ZARECASH_WEBHOOK_SECRET=<from the ZareCash dashboard>
ZARECASH_MODE=test
```

Point the tenant's webhook URL at this deployment's public `/v1/zarecash/webhook` via the ZareCash dashboard (`POST /dashboard/webhook-url`). It must be a public HTTPS URL.

- [ ] **Step 2: Confirm the boot assertion fires**

```bash
pnpm --filter @world-bingo/api dev
```

Expected: `[ZareCash] connected in test mode (available float: … ETB)`. If it reports a mode mismatch, the key and `ZARECASH_MODE` disagree — fix before going further.

- [ ] **Step 3: Opt one method in**

```sql
UPDATE payment_methods
SET gateway = 'zarecash', "gatewayMethodCode" = 'telebirr'
WHERE code = 'telebirr';
```

- [ ] **Step 4: Drive every deposit trigger**

Submit four deposits through the normal player flow, one per row. Sandbox outcomes key off the `receiptRef` prefix, so the collection account shown to the player is irrelevant here.

| Transaction ID entered | Expect |
|---|---|
| `TEST-REJECT-001` | local row `REJECTED`, wallet unchanged |
| `TEST-STALE-001` | local row `REJECTED`, wallet unchanged |
| `TEST-REVIEW-001` | stays `PENDING_REVIEW` |
| `CLEAN-001` | `APPROVED`, wallet credited, **first-deposit bonus granted** |

Verify the last one explicitly — it is the whole reason approvals route through `approveDeposit`:

```sql
SELECT type, amount, status FROM transactions WHERE "userId" = '<uid>' ORDER BY "createdAt" DESC LIMIT 5;
SELECT id, status, remaining FROM bonus_grants WHERE "userId" = '<uid>';
```

- [ ] **Step 5: Drive every withdrawal trigger**

Use a **distinct player per row** — the one-open-withdrawal rule applies in test mode, so reusing one player makes every request after the first fail with `409 withdrawal_pending`.

| Amount | Expect |
|---|---|
| `500.01` | `rejected` → wallet re-credited, `REFUND` row written |
| `500.02` | `queued_float` → stays `PENDING_REVIEW`, "processing" notification |
| `500.03` | stays `pending`, held in ZareCash's `reserved` |
| `500.00` | settled → local `APPROVED`, note carries the `settlementRef` |

- [ ] **Step 6: Verify the outage path**

Stop the API, submit a deposit through the ZareCash dashboard so a webhook fires into the void, restart, then run the sweep manually from the BullMQ dashboard at `/admin/queues` (queue `zarecash-sweep`). Confirm the missed event lands in `zarecash_events` and is processed.

- [ ] **Step 7: Write the runbook**

Create `apps/api/scripts/zarecash-sandbox.md` recording the steps above, the SQL to opt a method in and out, and the observed result of each trigger. This is what someone re-runs after a ZareCash upgrade.

- [ ] **Step 8: Commit**

```bash
git add apps/api/scripts/zarecash-sandbox.md
git commit -m "docs(zarecash): add the sandbox verification runbook"
```

---

## Deferred — blocked on ZareCash

Not implementable here; tracked in `paymentmgmtv2`. See the spec's *ZareCash-side prerequisites* table.

- **Remote `MethodConfigSource`** — blocked on `GET /v1/methods`. When it ships, add a `RemoteMethodConfigSource` to `method-config.ts` and change the `source` binding. Everything else stays put.
- **Live-phase `receipt` forwarding** — keep our TeleBirr scraper, stop it deciding, map `ParsedReceipt` to ZareCash's shape (`settledAmount`→`amount`, `receiptNumber`→`receiptRef`, `receiverNumberMasked`→`receiverMasked`, `ageHours` from `receiptTime`) and send it on `POST /v1/deposits`. Test phase ignores `receipt` entirely, so there is nothing to verify until go-live.
