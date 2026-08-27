# ZareCash Hosted Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a player deposit by entering an amount and being redirected to ZareCash's hosted payment page, with the local wallet credited only by the `deposit.approved` webhook.

**Architecture:** A `ZareCashCheckoutSession` row is created before ZareCash is called and supplies the `Idempotency-Key`. No `Transaction` exists until we first learn a `depositId` — from the return redirect, the webhook, or the nightly sweep — at which point the row is created `PENDING_REVIEW` with `gateway = "zarecash"` and `gatewayRef = dp_…`, and every existing credit path works unmodified. The deposit modal becomes a stack of method cards: a hosted-checkout card that only asks for an amount, and the current manual card that expands to today's form.

**Tech Stack:** Fastify v5, Prisma 5 (PostgreSQL), BullMQ, Vitest (`vi.mock`-style unit tests), Nuxt 3 + Pinia, Playwright for E2E.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-27-zarecash-hosted-checkout-design.md`. Contract: `~/Developer/paymentmgmtv2/apps/api/src/docs/llms.txt` (commit `9d15ef5`). Re-read the published `https://api.zarecash.com/llms.txt` before starting and reconcile any drift.
- **Never credit on the return redirect.** `status=pending` means a receipt was accepted, not that money arrived. Credit happens only in `WalletService.approveDeposit`, driven by `deposit.approved`.
- Credited amount always comes from `approvedAmount` on the event, never from the amount we recorded.
- Every mutating ZareCash call carries a unique `Idempotency-Key` or the API returns `400 idempotency_key_required`.
- Repeating an `Idempotency-Key` returns the same session with a **fresh** URL; the old link dies. Always redirect to the URL from the most recent response.
- `returnUrl` must share an origin with the tenant's configured Custom URL. It is built from `process.env.WEB_BASE_URL`.
- Every `Transaction` this feature creates sets `gateway = "zarecash"`. The admin double-pay guard keys on that field.
- Prettier: single quotes, no semicolons, trailing commas. 4-space indent in `apps/api`, 2-space in `apps/web`.
- Run API tests with `pnpm --filter @world-bingo/api test`.

---

### Task 1: Schema, migration, seed, catalog endpoint

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_zarecash_hosted_checkout/migration.sql` (generated)
- Modify: `apps/api/prisma/seed.ts`
- Modify: `apps/api/src/routes/payment-methods/index.ts`
- Modify: `apps/api/src/routes/admin/index.ts:102-126`
- Modify: `apps/admin/pages/settings/payment-methods.vue`
- Test: `apps/api/src/test/payment-methods-catalog.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PaymentMethod.hostedCheckout: boolean`, `PaymentMethod.logoUrl: string | null`, and the `ZareCashCheckoutSession` model with fields `id`, `sessionId`, `userId`, `amount`, `status`, `depositId`, `transactionId`, `methodCode`, `returnUrl`, `expiresAt`, `createdAt`, `updatedAt`. Prisma accessor is `prisma.zareCashCheckoutSession`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/payment-methods-catalog.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
    default: { paymentMethod: { findMany: vi.fn() } },
}))

import prisma from '../lib/prisma'
import paymentMethodRoutes from '../routes/payment-methods/index'

/** Minimal Fastify stand-in: captures the handler the plugin registers. */
function captureGet() {
    let handler: any
    const fastify: any = { get: (_path: string, opts: any) => { handler = opts.handler ?? opts } }
    return { fastify, run: (req: any) => handler(req, {}) }
}

describe('GET /payment-methods', () => {
    beforeEach(() => vi.clearAllMocks())

    it('exposes the fields the deposit cards need', async () => {
        ;(prisma as any).paymentMethod.findMany.mockResolvedValue([])
        const { fastify, run } = captureGet()
        await paymentMethodRoutes(fastify, {} as any)
        await run({ query: { type: 'DEPOSIT' } })

        const select = (prisma as any).paymentMethod.findMany.mock.calls[0][0].select
        expect(select.gateway).toBe(true)
        expect(select.hostedCheckout).toBe(true)
        expect(select.logoUrl).toBe(true)
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test payment-methods-catalog`
Expected: FAIL — `expect(select.gateway).toBe(true)` receives `undefined`.

- [ ] **Step 3: Add the schema changes**

In `apps/api/prisma/schema.prisma`, add two fields to `model PaymentMethod` beside `gatewayMethodCode`:

```prisma
  /// Deposits for this method are collected on ZareCash's hosted page rather
  /// than by our own receipt form. Requires gateway = "zarecash".
  hostedCheckout    Boolean           @default(false)
  /// Card header image for the deposit UI. Falls back to `icon` when unset.
  logoUrl           String?
```

Add the new model at the end of the file, next to `ZareCashEvent`:

```prisma
/// One row per hosted-checkout attempt. Created BEFORE ZareCash is called so its
/// `id` can serve as the Idempotency-Key. Carries no money: the Transaction is
/// only created once a depositId exists, so an abandoned session never reaches
/// the admin deposit queue.
model ZareCashCheckoutSession {
  id            String   @id @default(cuid())
  /// cs_… — null only in the window between our insert and ZareCash's answer.
  sessionId     String?  @unique
  userId        String
  amount        Decimal  @db.Decimal(12, 2)
  /// open | submitted | expired | cancelled | dead ("dead" is ours, not theirs)
  status        String   @default("open")
  /// dp_… once the player submits a receipt on the hosted page.
  depositId     String?  @unique
  /// Our Transaction, once materialised.
  transactionId String?  @unique
  methodCode    String
  returnUrl     String
  expiresAt     DateTime
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, status])
  @@index([status, expiresAt])
  @@map("zarecash_checkout_sessions")
}
```

Add the back-relation to `model User`, beside its other relation fields:

```prisma
  zarecashCheckoutSessions ZareCashCheckoutSession[]
```

- [ ] **Step 4: Generate the migration**

```bash
cd apps/api && pnpm prisma migrate dev --name zarecash_hosted_checkout
```

Expected: a new folder under `prisma/migrations/` and a regenerated client. Confirm the SQL contains `CREATE TABLE "zarecash_checkout_sessions"` and two `ALTER TABLE "payment_methods" ADD COLUMN`.

- [ ] **Step 5: Widen the catalog endpoint**

In `apps/api/src/routes/payment-methods/index.ts`, add to the `select` block:

```ts
                gateway: true,
                hostedCheckout: true,
                logoUrl: true,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test payment-methods-catalog`
Expected: PASS

- [ ] **Step 7: Let an operator set the logo**

`hostedCheckout` stays DB/seed-only — it is structural, exactly like `gateway`, which the admin schemas also omit. `logoUrl` is presentation and an operator will want it. Add to both zod schemas in `apps/api/src/routes/admin/index.ts:102-126`:

```ts
    logoUrl: z.string().url().nullish(),
```

In `apps/admin/pages/settings/payment-methods.vue`, add `logoUrl: ''` to the `form` reactive object, `form.logoUrl = m.logoUrl ?? ''` in the edit loader, `form.logoUrl = ''` in the reset, `logoUrl: form.logoUrl || null` in the save payload, and a field beside the icon input:

```vue
          <UFormField label="Logo URL" hint="Card header image; falls back to the icon">
            <UInput v-model="form.logoUrl" placeholder="https://…" />
          </UFormField>
```

- [ ] **Step 8: Seed the ZareCash method**

In `apps/api/prisma/seed.ts`, beside the existing payment-method seeding:

```ts
    await prisma.paymentMethod.upsert({
        where: { code: 'zarecash' },
        update: {},
        create: {
            code: 'zarecash',
            name: 'ZareCash',
            type: 'DEPOSIT',
            gateway: 'zarecash',
            hostedCheckout: true,
            icon: '⚡',
            instructions: 'Pay on the ZareCash page — we will confirm your deposit automatically.',
            sortOrder: 0,
            // Ships OFF. An operator enables it once the tenant's Custom URL and
            // webhook are configured in the ZareCash console.
            enabled: false,
        },
    })
```

- [ ] **Step 9: Commit**

```bash
git add apps/api/prisma apps/api/src/routes apps/api/src/test/payment-methods-catalog.test.ts apps/admin/pages/settings/payment-methods.vue
git commit -m "feat(zarecash): add hosted-checkout schema, seed and catalog fields"
```

---

### Task 2: Checkout endpoints on the HTTP client

**Files:**
- Modify: `apps/api/src/gateways/payment/zarecash/types.ts`
- Modify: `apps/api/src/gateways/payment/zarecash/client.ts`
- Test: `apps/api/src/test/zarecash-checkout-client.test.ts`

**Interfaces:**
- Consumes: `ZareCashClient.request` (private), `ZareCashError`, `PERMANENT_ERROR_CODES`.
- Produces:
  - `type ZareCashCheckoutStatus = 'open' | 'submitted' | 'expired' | 'cancelled'`
  - `interface CreateCheckoutSessionInput { playerRef: string; amount: number; returnUrl: string }`
  - `interface ZareCashCheckoutSession { id: string; url: string; status: ZareCashCheckoutStatus; amount: number; playerRef: string; expiresAt: string; depositId: string | null }`
  - `ZareCashClient.createCheckoutSession(input: CreateCheckoutSessionInput, idempotencyKey: string): Promise<ZareCashCheckoutSession>`
  - `ZareCashClient.getCheckoutSession(id: string): Promise<ZareCashCheckoutSession>`
  - `ZareCashClient.cancelCheckoutSession(id: string): Promise<ZareCashCheckoutSession>`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/zarecash-checkout-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../gateways/payment/zarecash/config', () => ({
    zarecashConfig: () => ({
        enabled: true,
        baseUrl: 'https://zc.test',
        apiKey: 'pk_test_key',
        mode: 'test',
        timeoutMs: 5000,
    }),
}))

import { ZareCashClient } from '../gateways/payment/zarecash/client'
import { ZareCashError } from '../gateways/payment/zarecash/types'

const SESSION = {
    id: 'cs_9F4KQ2',
    url: 'https://zc.test/pay/tok',
    status: 'open',
    amount: 500,
    playerRef: 'u1',
    expiresAt: '2026-08-27T08:23:00.609Z',
    depositId: null,
}

function mockFetch(status: number, body: unknown) {
    const fn = vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
        headers: { get: () => null },
    })
    vi.stubGlobal('fetch', fn)
    return fn
}

describe('ZareCashClient checkout', () => {
    beforeEach(() => vi.unstubAllGlobals())

    it('creates a session with the caller-supplied idempotency key', async () => {
        const fetchMock = mockFetch(200, SESSION)

        const res = await new ZareCashClient().createCheckoutSession(
            { playerRef: 'u1', amount: 500, returnUrl: 'https://site.test/wallet' },
            'ck_local_1',
        )

        expect(res.url).toBe('https://zc.test/pay/tok')
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('https://zc.test/v1/checkout/sessions')
        expect(init.method).toBe('POST')
        expect(init.headers['Idempotency-Key']).toBe('ck_local_1')
        expect(init.headers['x-api-key']).toBe('pk_test_key')
        expect(JSON.parse(init.body)).toEqual({
            playerRef: 'u1',
            amount: 500,
            returnUrl: 'https://site.test/wallet',
        })
    })

    it('reads a session by id', async () => {
        const fetchMock = mockFetch(200, { ...SESSION, status: 'submitted', depositId: 'dp_1' })

        const res = await new ZareCashClient().getCheckoutSession('cs_9F4KQ2')

        expect(res.depositId).toBe('dp_1')
        expect(fetchMock.mock.calls[0][0]).toBe('https://zc.test/v1/checkout/sessions/cs_9F4KQ2')
    })

    it('cancels a session with a deterministic key', async () => {
        const fetchMock = mockFetch(200, { ...SESSION, status: 'cancelled' })

        await new ZareCashClient().cancelCheckoutSession('cs_9F4KQ2')

        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('https://zc.test/v1/checkout/sessions/cs_9F4KQ2/cancel')
        expect(init.headers['Idempotency-Key']).toBe('cancel_cs_9F4KQ2')
    })

    it('treats invalid_return_url as permanent', async () => {
        mockFetch(400, { error: 'invalid_return_url', message: 'origin mismatch' })

        const err = await new ZareCashClient()
            .createCheckoutSession({ playerRef: 'u1', amount: 500, returnUrl: 'https://evil.test' }, 'k')
            .catch((e) => e)

        expect(err).toBeInstanceOf(ZareCashError)
        expect(err.code).toBe('invalid_return_url')
        expect(err.permanent).toBe(true)
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test zarecash-checkout-client`
Expected: FAIL — `createCheckoutSession is not a function`.

- [ ] **Step 3: Add the types**

Append to `apps/api/src/gateways/payment/zarecash/types.ts`, above `ZareCashError`:

```ts
export type ZareCashCheckoutStatus = 'open' | 'submitted' | 'expired' | 'cancelled'

export interface CreateCheckoutSessionInput {
    playerRef: string
    amount: number
    returnUrl: string
}

export interface ZareCashCheckoutSession {
    id: string
    /** Redirect the player here. A repeated Idempotency-Key mints a FRESH url
     *  and kills the previous one, so never cache this. */
    url: string
    status: ZareCashCheckoutStatus
    amount: number
    playerRef: string
    expiresAt: string
    /** dp_… once the player has submitted a receipt on the hosted page. */
    depositId: string | null
}
```

And add one entry to `PERMANENT_ERROR_CODES` — a returnUrl whose origin does not match the tenant's Custom URL will never succeed on retry:

```ts
    'invalid_return_url',
```

- [ ] **Step 4: Add the client methods**

In `apps/api/src/gateways/payment/zarecash/client.ts`, extend the type import with `CreateCheckoutSessionInput` and `ZareCashCheckoutSession`, then add after `createWithdrawal`:

```ts
    createCheckoutSession(
        input: CreateCheckoutSessionInput,
        idempotencyKey: string,
    ): Promise<ZareCashCheckoutSession> {
        return this.request<ZareCashCheckoutSession>('POST', '/v1/checkout/sessions', {
            body: compact(input as any),
            idempotencyKey,
        })
    }

    getCheckoutSession(id: string): Promise<ZareCashCheckoutSession> {
        return this.request<ZareCashCheckoutSession>(
            'GET',
            `/v1/checkout/sessions/${encodeURIComponent(id)}`,
        )
    }

    // Mutating, so the contract requires a key. Deterministic from the session id:
    // cancelling twice is the same logical request and must not be two of them.
    cancelCheckoutSession(id: string): Promise<ZareCashCheckoutSession> {
        return this.request<ZareCashCheckoutSession>(
            'POST',
            `/v1/checkout/sessions/${encodeURIComponent(id)}/cancel`,
            { idempotencyKey: `cancel_${id}` },
        )
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test zarecash-checkout-client`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/gateways/payment/zarecash apps/api/src/test/zarecash-checkout-client.test.ts
git commit -m "feat(zarecash): add checkout session endpoints to the client"
```

---

### Task 3: Create a checkout session

**Files:**
- Create: `apps/api/src/services/zarecash-checkout.service.ts`
- Modify: `packages/shared-types/src/api/index.ts:38-45`
- Modify: `apps/api/src/controllers/wallet.controller.ts`
- Modify: `apps/api/src/routes/wallet/index.ts`
- Test: `apps/api/src/test/zarecash-checkout-create.test.ts`

**Interfaces:**
- Consumes: `zarecashClient()`, `isZareCashEnabled()`, `prisma.zareCashCheckoutSession`, `prisma.paymentMethod`, `prisma.siteSetting`.
- Produces:
  - `ZareCashCheckoutService.createSession(userId: string, amount: number, methodCode: string): Promise<{ url: string; expiresAt: Date; localId: string }>` — `localId` is OUR row id, not the `cs_…` one stored in the `sessionId` column
  - `CheckoutSessionSchema` = `z.object({ amount: z.number().positive(), methodCode: z.string().min(1) })`
  - `WalletController.createCheckoutSession(request, reply)`
  - Route `POST /wallet/deposit/checkout`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/zarecash-checkout-create.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
    default: {
        siteSetting: { findUnique: vi.fn().mockResolvedValue(null) },
        paymentMethod: { findUnique: vi.fn() },
        zareCashCheckoutSession: { create: vi.fn(), update: vi.fn().mockResolvedValue({}) },
        transaction: { create: vi.fn() },
    },
}))
const { createCheckoutSession } = vi.hoisted(() => ({ createCheckoutSession: vi.fn() }))
vi.mock('../gateways/payment/zarecash/client', () => ({
    zarecashClient: () => ({ createCheckoutSession }),
}))
vi.mock('../gateways/payment/zarecash/config', () => ({ isZareCashEnabled: () => true }))

import prisma from '../lib/prisma'
import { ZareCashCheckoutService } from '../services/zarecash-checkout.service'

const METHOD = {
    code: 'zarecash',
    name: 'ZareCash',
    type: 'DEPOSIT',
    enabled: true,
    gateway: 'zarecash',
    hostedCheckout: true,
}

beforeEach(() => {
    vi.clearAllMocks()
    process.env.WEB_BASE_URL = 'https://site.test'
    ;(prisma as any).paymentMethod.findUnique.mockResolvedValue(METHOD)
    ;(prisma as any).zareCashCheckoutSession.create.mockResolvedValue({ id: 'local1' })
    createCheckoutSession.mockResolvedValue({
        id: 'cs_1',
        url: 'https://zc.test/pay/tok',
        status: 'open',
        amount: 500,
        playerRef: 'u1',
        expiresAt: '2026-08-27T08:23:00.609Z',
        depositId: null,
    })
})

describe('ZareCashCheckoutService.createSession', () => {
    it('keys the call on our own row id and stores the session', async () => {
        const res = await ZareCashCheckoutService.createSession('u1', 500, 'zarecash')

        expect(createCheckoutSession).toHaveBeenCalledWith(
            { playerRef: 'u1', amount: 500, returnUrl: 'https://site.test/wallet' },
            'local1',
        )
        expect(res.url).toBe('https://zc.test/pay/tok')
        expect((prisma as any).zareCashCheckoutSession.update).toHaveBeenCalledWith({
            where: { id: 'local1' },
            data: {
                sessionId: 'cs_1',
                status: 'open',
                expiresAt: new Date('2026-08-27T08:23:00.609Z'),
            },
        })
    })

    it('creates no Transaction — an abandoned session must not reach the deposit queue', async () => {
        await ZareCashCheckoutService.createSession('u1', 500, 'zarecash')
        expect((prisma as any).transaction.create).not.toHaveBeenCalled()
    })

    it('rejects an amount below the site minimum before calling ZareCash', async () => {
        ;(prisma as any).siteSetting.findUnique.mockResolvedValue({ value: '200' })

        const err = await ZareCashCheckoutService.createSession('u1', 50, 'zarecash').catch((e) => e)

        expect(err.statusCode).toBe(400)
        expect(err.message).toMatch(/Minimum deposit/)
        expect(createCheckoutSession).not.toHaveBeenCalled()
    })

    it('refuses a method that is not hosted checkout', async () => {
        ;(prisma as any).paymentMethod.findUnique.mockResolvedValue({
            ...METHOD,
            hostedCheckout: false,
        })

        const err = await ZareCashCheckoutService.createSession('u1', 500, 'telebirr').catch((e) => e)

        expect(err.statusCode).toBe(400)
        expect(createCheckoutSession).not.toHaveBeenCalled()
    })

    it('refuses a disabled method', async () => {
        ;(prisma as any).paymentMethod.findUnique.mockResolvedValue({ ...METHOD, enabled: false })

        const err = await ZareCashCheckoutService.createSession('u1', 500, 'zarecash').catch((e) => e)

        expect(err.statusCode).toBe(400)
        expect(createCheckoutSession).not.toHaveBeenCalled()
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test zarecash-checkout-create`
Expected: FAIL — cannot resolve `../services/zarecash-checkout.service`.

- [ ] **Step 3: Write the service**

Create `apps/api/src/services/zarecash-checkout.service.ts`:

```ts
/**
 * ZareCash hosted checkout.
 *
 * Split from zarecash.service.ts on purpose: that file owns the record-and-review
 * flow, where WE hold the receipt reference. Here ZareCash collects the receipt
 * and creates the deposit, so the local Transaction cannot exist until a
 * depositId does. Keeping the two lifecycles in separate files keeps either one
 * readable in a single pass.
 */

import prisma from '../lib/prisma.js'
import { zarecashClient } from '../gateways/payment/zarecash/client.js'
import { isZareCashEnabled } from '../gateways/payment/zarecash/config.js'
import { ZareCashError } from '../gateways/payment/zarecash/types.js'
import { reportError } from '../lib/sentry.js'

/** The contract's open window. Overwritten by the expiresAt ZareCash returns. */
const OPEN_WINDOW_MS = 20 * 60 * 1000

function httpError(statusCode: number, message: string): Error {
    return Object.assign(new Error(message), { statusCode })
}

function webBaseUrl(): string {
    return (process.env.WEB_BASE_URL || 'https://www.aradabingo.bet').replace(/\/+$/, '')
}

async function depositLimits(): Promise<{ min: number; max: number }> {
    const [minRow, maxRow] = await Promise.all([
        prisma.siteSetting.findUnique({ where: { key: 'min_deposit_amount' } }),
        prisma.siteSetting.findUnique({ where: { key: 'max_deposit_amount' } }),
    ])
    return { min: minRow ? Number(minRow.value) : 10, max: maxRow ? Number(maxRow.value) : 50000 }
}

export class ZareCashCheckoutService {
    /**
     * Create a hosted payment page and return where to send the player.
     *
     * Deliberately creates NO Transaction. Most sessions are abandoned, and a
     * PENDING_REVIEW row per abandonment would fill the admin deposit queue with
     * ghosts a clerk could approve by hand.
     */
    static async createSession(
        userId: string,
        amount: number,
        methodCode: string,
    ): Promise<{ url: string; expiresAt: Date; localId: string }> {
        if (!isZareCashEnabled()) {
            throw httpError(503, 'Deposits are temporarily unavailable')
        }

        // Validate before creating. The contract warns that an amount outside every
        // method's limits produces a page that can accept nothing — a far worse
        // failure for the player than a form error here.
        const { min, max } = await depositLimits()
        if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'Invalid amount')
        if (amount < min) throw httpError(400, `Minimum deposit amount is ${min} Birr`)
        if (amount > max) throw httpError(400, `Maximum deposit amount is ${max} Birr`)

        const method = await prisma.paymentMethod.findUnique({ where: { code: methodCode } })
        if (
            !method ||
            !method.enabled ||
            method.type !== 'DEPOSIT' ||
            !method.hostedCheckout ||
            method.gateway !== 'zarecash'
        ) {
            throw httpError(400, 'That payment method is not available')
        }

        const returnUrl = `${webBaseUrl()}/wallet`
        const row = await prisma.zareCashCheckoutSession.create({
            data: {
                userId,
                amount,
                methodCode,
                returnUrl,
                status: 'open',
                expiresAt: new Date(Date.now() + OPEN_WINDOW_MS),
            },
        })

        try {
            const session = await zarecashClient().createCheckoutSession(
                { playerRef: userId, amount, returnUrl },
                row.id,
            )
            const expiresAt = new Date(session.expiresAt)
            await prisma.zareCashCheckoutSession.update({
                where: { id: row.id },
                data: { sessionId: session.id, status: session.status, expiresAt },
            })
            return { url: session.url, expiresAt, localId: row.id }
        } catch (err) {
            // invalid_return_url is a misconfiguration, not a player problem: it
            // fails every attempt until an operator fixes the console's Custom URL.
            // Alarm on it rather than letting it read as a transient blip.
            if (err instanceof ZareCashError && err.code === 'invalid_return_url') {
                console.error('[ZareCashCheckout] returnUrl %s rejected by ZareCash', returnUrl)
                reportError(err, { phase: 'zarecash-checkout-return-url', returnUrl })
                throw httpError(503, 'Deposits are temporarily unavailable')
            }
            if (err instanceof ZareCashError && err.code === 'rate_limited') {
                throw httpError(429, 'Too many attempts — please try again shortly')
            }
            throw err
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test zarecash-checkout-create`
Expected: PASS (5 tests)

- [ ] **Step 5: Add the request schema**

In `packages/shared-types/src/api/index.ts`, after `DepositSchema`:

```ts
export const CheckoutSessionSchema = z.object({
    amount: z.number().positive(),
    methodCode: z.string().min(1),
})

export const ClaimCheckoutSchema = z.object({
    depositId: z.string().min(3),
})
```

Build it so the API sees the new export: `pnpm --filter @world-bingo/shared-types build`

- [ ] **Step 6: Add the controller handler**

In `apps/api/src/controllers/wallet.controller.ts`, import the service and add:

```ts
    static async createCheckoutSession(request: FastifyRequest, reply: FastifyReply) {
        // @ts-ignore — populated by the authenticate preValidation hook
        const userId = request.user.id
        const { amount, methodCode } = request.body as { amount: number; methodCode: string }
        try {
            const session = await ZareCashCheckoutService.createSession(userId, amount, methodCode)
            return { url: session.url, expiresAt: session.expiresAt }
        } catch (err: any) {
            return reply.status(err?.statusCode ?? 500).send({ error: err?.message ?? 'Deposit failed' })
        }
    }
```

- [ ] **Step 7: Register the route**

In `apps/api/src/routes/wallet/index.ts`, extend the shared-types import with `CheckoutSessionSchema` and add after the `/deposit` route:

```ts
    fastify.post('/deposit/checkout', {
        schema: {
            body: zodToJsonSchema(CheckoutSessionSchema),
        },
        handler: WalletController.createCheckoutSession,
    })
```

- [ ] **Step 8: Verify the whole API suite still passes**

Run: `pnpm --filter @world-bingo/api test`
Expected: PASS, no regressions.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src packages/shared-types/src
git commit -m "feat(zarecash): create hosted checkout sessions"
```

---

### Task 4: Claim the deposit on return

**Files:**
- Modify: `apps/api/src/services/zarecash-checkout.service.ts`
- Modify: `apps/api/src/controllers/wallet.controller.ts`
- Modify: `apps/api/src/routes/wallet/index.ts`
- Test: `apps/api/src/test/zarecash-checkout-claim.test.ts`

**Interfaces:**
- Consumes: `ZareCashCheckoutService.createSession` (Task 3), `zarecashClient().getCheckoutSession` (Task 2).
- Produces:
  - `ZareCashCheckoutService.claimDeposit(userId: string, depositId: string): Promise<{ transactionId: string }>`
  - `ZareCashCheckoutService.materialise(session, depositId: string, amount?: number): Promise<string>` (exported as a static; used again in Tasks 5 and 6)
  - `ZareCashCheckoutService.resolveSessionForDeposit(userId: string, depositId: string)` (static; used again in Task 5)
  - Route `POST /wallet/deposit/checkout/claim`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/zarecash-checkout-claim.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
    default: {
        zareCashCheckoutSession: {
            findUnique: vi.fn(),
            findMany: vi.fn().mockResolvedValue([]),
            update: vi.fn().mockResolvedValue({}),
        },
        transaction: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    },
}))
const { getCheckoutSession } = vi.hoisted(() => ({ getCheckoutSession: vi.fn() }))
vi.mock('../gateways/payment/zarecash/client', () => ({
    zarecashClient: () => ({ getCheckoutSession }),
}))
vi.mock('../gateways/payment/zarecash/config', () => ({ isZareCashEnabled: () => true }))

import prisma from '../lib/prisma'
import { ZareCashCheckoutService } from '../services/zarecash-checkout.service'

const SESSION = {
    id: 'local1',
    sessionId: 'cs_1',
    userId: 'u1',
    amount: '500',
    methodCode: 'zarecash',
    status: 'open',
    depositId: null,
    transactionId: null,
}

beforeEach(() => {
    vi.clearAllMocks()
    ;(prisma as any).transaction.findUnique.mockResolvedValue(null)
    ;(prisma as any).transaction.create.mockResolvedValue({ id: 'tx1' })
    ;(prisma as any).zareCashCheckoutSession.findMany.mockResolvedValue([])
})

describe('ZareCashCheckoutService.claimDeposit', () => {
    it('creates a PENDING_REVIEW row carrying the routing marker, and credits nothing', async () => {
        ;(prisma as any).zareCashCheckoutSession.findUnique.mockResolvedValue({
            ...SESSION,
            depositId: 'dp_1',
        })

        const res = await ZareCashCheckoutService.claimDeposit('u1', 'dp_1')

        expect(res.transactionId).toBe('tx1')
        const created = (prisma as any).transaction.create.mock.calls[0][0].data
        expect(created).toMatchObject({
            userId: 'u1',
            type: 'DEPOSIT',
            status: 'PENDING_REVIEW',
            gateway: 'zarecash',
            gatewayRef: 'dp_1',
            note: 'zarecash',
        })
        expect(Number(created.amount)).toBe(500)
    })

    it('is idempotent — a second claim returns the existing row', async () => {
        ;(prisma as any).zareCashCheckoutSession.findUnique.mockResolvedValue({
            ...SESSION,
            depositId: 'dp_1',
            transactionId: 'tx1',
        })

        const res = await ZareCashCheckoutService.claimDeposit('u1', 'dp_1')

        expect(res.transactionId).toBe('tx1')
        expect((prisma as any).transaction.create).not.toHaveBeenCalled()
    })

    it('matches an unlinked session by polling ZareCash, not by picking the newest', async () => {
        ;(prisma as any).zareCashCheckoutSession.findUnique.mockResolvedValue(null)
        ;(prisma as any).zareCashCheckoutSession.findMany.mockResolvedValue([
            { ...SESSION, id: 'newer', sessionId: 'cs_newer' },
            { ...SESSION, id: 'older', sessionId: 'cs_older' },
        ])
        getCheckoutSession.mockImplementation(async (id: string) =>
            id === 'cs_older'
                ? { id, status: 'submitted', depositId: 'dp_1', url: '', amount: 500, playerRef: 'u1', expiresAt: '' }
                : { id, status: 'open', depositId: null, url: '', amount: 500, playerRef: 'u1', expiresAt: '' },
        )

        await ZareCashCheckoutService.claimDeposit('u1', 'dp_1')

        // The newest session is NOT the one the deposit belongs to.
        expect((prisma as any).zareCashCheckoutSession.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'older' } }),
        )
    })

    it('404s on a depositId that belongs to another player', async () => {
        ;(prisma as any).zareCashCheckoutSession.findUnique.mockResolvedValue({
            ...SESSION,
            userId: 'someone-else',
            depositId: 'dp_1',
        })

        const err = await ZareCashCheckoutService.claimDeposit('u1', 'dp_1').catch((e) => e)

        expect(err.statusCode).toBe(404)
        expect((prisma as any).transaction.create).not.toHaveBeenCalled()
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test zarecash-checkout-claim`
Expected: FAIL — `claimDeposit is not a function`.

- [ ] **Step 3: Implement resolution and materialisation**

Add to `ZareCashCheckoutService` in `apps/api/src/services/zarecash-checkout.service.ts` (extend the imports with `PaymentStatus, TransactionType` from `@world-bingo/shared-types`):

```ts
    /**
     * Find the session a depositId belongs to.
     *
     * Deliberately NOT "the caller's most recent session". A player can have more
     * than one session in flight — they can open the modal twice — and picking the
     * newest would eventually attach a deposit to the wrong one, which is a wrong
     * amount credited to a real wallet. Ask ZareCash which session produced this
     * deposit instead. Bounded to the five newest so a pathological account cannot
     * turn one claim into an unbounded fan-out of HTTP calls.
     */
    static async resolveSessionForDeposit(userId: string, depositId: string) {
        const direct = await prisma.zareCashCheckoutSession.findUnique({ where: { depositId } })
        if (direct) return direct.userId === userId ? direct : null

        const candidates = await prisma.zareCashCheckoutSession.findMany({
            where: {
                userId,
                transactionId: null,
                sessionId: { not: null },
                status: { in: ['open', 'submitted'] },
            },
            orderBy: { createdAt: 'desc' },
            take: 5,
        })

        for (const candidate of candidates) {
            let remote
            try {
                remote = await zarecashClient().getCheckoutSession(candidate.sessionId as string)
            } catch {
                // A session we cannot read tells us nothing. Try the next one; the
                // sweep will revisit this session later.
                continue
            }
            if (remote.depositId !== depositId) continue
            await prisma.zareCashCheckoutSession.update({
                where: { id: candidate.id },
                data: { depositId, status: remote.status },
            })
            return { ...candidate, depositId, status: remote.status }
        }
        return null
    }

    /**
     * Create the local Transaction for a deposit ZareCash has accepted a receipt
     * for. PENDING_REVIEW and nothing more — the credit is the webhook's job.
     */
    static async materialise(
        session: { id: string; userId: string; amount: unknown; methodCode: string; transactionId?: string | null },
        depositId: string,
        amount?: number,
    ): Promise<string> {
        if (session.transactionId) return session.transactionId

        const existing = await prisma.transaction.findUnique({ where: { gatewayRef: depositId } })
        if (existing) {
            await prisma.zareCashCheckoutSession.update({
                where: { id: session.id },
                data: { transactionId: existing.id, depositId, status: 'submitted' },
            })
            return existing.id
        }

        try {
            const tx = await prisma.transaction.create({
                data: {
                    userId: session.userId,
                    type: TransactionType.DEPOSIT,
                    amount: amount ?? Number(session.amount),
                    status: PaymentStatus.PENDING_REVIEW,
                    // The routing marker. The admin double-pay guard keys on it, so
                    // without this a clerk could hand-approve a deposit ZareCash is
                    // also about to approve.
                    gateway: 'zarecash',
                    gatewayRef: depositId,
                    note: session.methodCode,
                },
            })
            await prisma.zareCashCheckoutSession.update({
                where: { id: session.id },
                data: { transactionId: tx.id, depositId, status: 'submitted' },
            })
            return tx.id
        } catch (err: any) {
            // Unique violation on gatewayRef: the claim and the webhook raced and
            // the other one won. Its row is the right answer.
            if (err?.code === 'P2002') {
                const winner = await prisma.transaction.findUnique({ where: { gatewayRef: depositId } })
                if (winner) {
                    await prisma.zareCashCheckoutSession.update({
                        where: { id: session.id },
                        data: { transactionId: winner.id, depositId, status: 'submitted' },
                    })
                    return winner.id
                }
            }
            throw err
        }
    }

    /**
     * Called when the player lands back on /wallet with ?deposit=dp_…
     *
     * NEVER credits. `status=pending` on that redirect means a receipt was
     * accepted, not that money arrived — the contract says so twice.
     */
    static async claimDeposit(userId: string, depositId: string): Promise<{ transactionId: string }> {
        const ref = String(depositId ?? '').trim()
        if (!ref) throw httpError(400, 'Missing deposit reference')

        const session = await ZareCashCheckoutService.resolveSessionForDeposit(userId, ref)
        // A query parameter is not proof. If it names no session of this player's,
        // it is not theirs to claim.
        if (!session) throw httpError(404, 'Deposit not found')

        const transactionId = await ZareCashCheckoutService.materialise(session, ref)
        return { transactionId }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test zarecash-checkout-claim`
Expected: PASS (4 tests)

- [ ] **Step 5: Add the controller handler**

In `apps/api/src/controllers/wallet.controller.ts`:

```ts
    static async claimCheckoutDeposit(request: FastifyRequest, reply: FastifyReply) {
        // @ts-ignore — populated by the authenticate preValidation hook
        const userId = request.user.id
        const { depositId } = request.body as { depositId: string }
        try {
            return await ZareCashCheckoutService.claimDeposit(userId, depositId)
        } catch (err: any) {
            return reply.status(err?.statusCode ?? 500).send({ error: err?.message ?? 'Claim failed' })
        }
    }
```

- [ ] **Step 6: Register the route**

In `apps/api/src/routes/wallet/index.ts`, extend the shared-types import with `ClaimCheckoutSchema` and add:

```ts
    fastify.post('/deposit/checkout/claim', {
        schema: {
            body: zodToJsonSchema(ClaimCheckoutSchema),
        },
        handler: WalletController.claimCheckoutDeposit,
    })
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src
git commit -m "feat(zarecash): claim a hosted-checkout deposit on return"
```

---

### Task 5: Credit the player who never came back

**Files:**
- Modify: `apps/api/src/services/zarecash-checkout.service.ts`
- Modify: `apps/api/src/services/zarecash.service.ts:605-639`
- Test: `apps/api/src/test/zarecash-checkout-webhook.test.ts`

**Interfaces:**
- Consumes: `ZareCashCheckoutService.resolveSessionForDeposit`, `ZareCashCheckoutService.materialise` (Task 4); `UnknownGatewayRefError`, `ZareCashService.findByGatewayRef`.
- Produces: `ZareCashCheckoutService.adoptFromWebhook(data: Record<string, any>): Promise<string | null>` — the local transaction id, or null when this deposit belongs to no checkout session.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/zarecash-checkout-webhook.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
    default: {
        zareCashEvent: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
        zareCashCheckoutSession: {
            findUnique: vi.fn(),
            findMany: vi.fn().mockResolvedValue([]),
            update: vi.fn().mockResolvedValue({}),
        },
        transaction: {
            findUnique: vi.fn(),
            create: vi.fn(),
            update: vi.fn().mockResolvedValue({}),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        auditLog: { create: vi.fn().mockResolvedValue({}) },
    },
}))
const { approveDeposit } = vi.hoisted(() => ({ approveDeposit: vi.fn().mockResolvedValue({}) }))
vi.mock('../services/wallet.service', () => ({ WalletService: { approveDeposit } }))
vi.mock('../gateways/payment/zarecash/client', () => ({
    zarecashClient: () => ({ getCheckoutSession: vi.fn() }),
}))

import prisma from '../lib/prisma'
import { ZareCashService } from '../services/zarecash.service'

const EVENT = {
    id: 'evt_1',
    type: 'deposit.approved',
    receivedAt: new Date(),
    processedAt: null,
    payload: {
        id: 'evt_1',
        type: 'deposit.approved',
        data: { id: 'dp_1', playerRef: 'u1', status: 'APPROVED', statedAmount: 500, approvedAmount: 480 },
    },
}

beforeEach(() => {
    vi.clearAllMocks()
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue(EVENT)
    ;(prisma as any).zareCashCheckoutSession.findMany.mockResolvedValue([])
})

describe('deposit.approved for a hosted-checkout deposit', () => {
    it('adopts an unclaimed session and credits approvedAmount', async () => {
        // No local row yet: the player paid on ZareCash's page and closed the tab.
        ;(prisma as any).transaction.findUnique.mockResolvedValue(null)
        ;(prisma as any).zareCashCheckoutSession.findUnique.mockResolvedValue({
            id: 'local1',
            userId: 'u1',
            amount: '500',
            methodCode: 'zarecash',
            depositId: 'dp_1',
            transactionId: null,
        })
        ;(prisma as any).transaction.create.mockResolvedValue({ id: 'tx1' })

        await ZareCashService.processEvent('evt_1')

        expect((prisma as any).transaction.create).toHaveBeenCalled()
        expect(approveDeposit).toHaveBeenCalledWith('tx1', 480)
        expect((prisma as any).zareCashEvent.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ error: null }) }),
        )
    })

    it('still quarantines a ref that belongs to no session', async () => {
        ;(prisma as any).transaction.findUnique.mockResolvedValue(null)
        ;(prisma as any).zareCashCheckoutSession.findUnique.mockResolvedValue(null)

        await expect(ZareCashService.processEvent('evt_1')).rejects.toThrow(/matches no local transaction/)
        expect(approveDeposit).not.toHaveBeenCalled()
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test zarecash-checkout-webhook`
Expected: FAIL — the first test throws `UnknownGatewayRefError`; no row is created.

- [ ] **Step 3: Add the adoption path**

Add to `ZareCashCheckoutService`:

```ts
    /**
     * Last resort before a deposit event is quarantined: the player paid on the
     * hosted page and never came back, so `claim` never ran and no local row
     * exists. This will be routine, not exotic — a redirect back to our site is a
     * courtesy, not a guarantee.
     *
     * Returns the local transaction id, or null when this deposit belongs to no
     * session of ours (a genuinely unknown ref, which must still quarantine).
     */
    static async adoptFromWebhook(data: Record<string, any>): Promise<string | null> {
        const depositId = String(data?.id ?? '').trim()
        const playerRef = String(data?.playerRef ?? '').trim()
        if (!depositId || !playerRef) return null

        const session = await ZareCashCheckoutService.resolveSessionForDeposit(playerRef, depositId)
        if (!session) return null

        // statedAmount is what the player told the page they sent. It is only the
        // row's placeholder amount — approveDeposit credits approvedAmount.
        const stated = Number(data?.statedAmount)
        return ZareCashCheckoutService.materialise(
            session,
            depositId,
            Number.isFinite(stated) && stated > 0 ? stated : undefined,
        )
    }
```

- [ ] **Step 4: Route deposit events through it**

In `apps/api/src/services/zarecash.service.ts`, import the new service and add a resolver beside `requireByGatewayRef`:

```ts
    /**
     * Resolve the local row a deposit event refers to.
     *
     * Two legitimate ways a deposit row can be missing, and only one of them is a
     * problem: a hosted-checkout deposit whose player never returned has no row
     * yet and we can build one; anything else is genuinely unknown and must not
     * consume the event.
     */
    private static async requireDepositRow(eventType: string, data: Record<string, any>) {
        const direct = await ZareCashService.findByGatewayRef(data.id)
        if (direct) return direct

        const adoptedId = await ZareCashCheckoutService.adoptFromWebhook(data)
        if (adoptedId) {
            const adopted = await prisma.transaction.findUnique({ where: { id: adoptedId } })
            if (adopted) return adopted
        }
        throw new UnknownGatewayRefError(eventType, data.id)
    }
```

Then change the first line of `onDepositApproved` and `onDepositRejected` to use it:

```ts
        const tx = await ZareCashService.requireDepositRow('deposit.approved', data)
```

```ts
        const tx = await ZareCashService.requireDepositRow('deposit.rejected', data)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test zarecash-checkout-webhook`
Expected: PASS (2 tests)

- [ ] **Step 6: Verify no regression in the existing event suite**

Run: `pnpm --filter @world-bingo/api test zarecash`
Expected: PASS — in particular `zarecash-event-processing` and `zarecash-sweep`, which cover the quarantine path this change touches.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src
git commit -m "feat(zarecash): adopt checkout deposits whose player never returned"
```

---

### Task 6: Sweep stale and unlinked sessions

**Files:**
- Modify: `apps/api/src/services/zarecash-checkout.service.ts`
- Modify: `apps/api/src/workers/zarecash-sweep.worker.ts`
- Test: `apps/api/src/test/zarecash-checkout-sweep.test.ts`

**Interfaces:**
- Consumes: `ZareCashCheckoutService.materialise` (Task 4), `zarecashClient().getCheckoutSession` (Task 2), `QUEUE_NAMES.ZARECASH_SWEEP`.
- Produces: `ZareCashCheckoutService.sweepSessions(): Promise<{ dead: number; linked: number }>`, and the exported job name `CHECKOUT_SWEEP_JOB = 'sweep-checkout-sessions'`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/zarecash-checkout-sweep.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
    default: {
        zareCashCheckoutSession: {
            updateMany: vi.fn().mockResolvedValue({ count: 3 }),
            findMany: vi.fn().mockResolvedValue([]),
            findUnique: vi.fn().mockResolvedValue(null),
            update: vi.fn().mockResolvedValue({}),
        },
        transaction: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    },
}))
const { getCheckoutSession } = vi.hoisted(() => ({ getCheckoutSession: vi.fn() }))
vi.mock('../gateways/payment/zarecash/client', () => ({
    zarecashClient: () => ({ getCheckoutSession }),
}))
vi.mock('../gateways/payment/zarecash/config', () => ({ isZareCashEnabled: () => true }))

import prisma from '../lib/prisma'
import { ZareCashCheckoutService } from '../services/zarecash-checkout.service'

beforeEach(() => {
    vi.clearAllMocks()
    ;(prisma as any).transaction.create.mockResolvedValue({ id: 'tx1' })
})

describe('ZareCashCheckoutService.sweepSessions', () => {
    it('retires sessions past the 24h receipt window', async () => {
        const res = await ZareCashCheckoutService.sweepSessions()

        const where = (prisma as any).zareCashCheckoutSession.updateMany.mock.calls[0][0].where
        expect(where.depositId).toBeNull()
        expect(where.expiresAt.lt.getTime()).toBeLessThan(Date.now() - 23 * 60 * 60 * 1000)
        expect(res.dead).toBe(3)
    })

    it('materialises a session ZareCash now reports a depositId for', async () => {
        ;(prisma as any).zareCashCheckoutSession.findMany.mockResolvedValue([
            { id: 'local1', sessionId: 'cs_1', userId: 'u1', amount: '500', methodCode: 'zarecash', transactionId: null },
        ])
        getCheckoutSession.mockResolvedValue({
            id: 'cs_1', status: 'submitted', depositId: 'dp_1',
            url: '', amount: 500, playerRef: 'u1', expiresAt: '',
        })

        const res = await ZareCashCheckoutService.sweepSessions()

        expect(res.linked).toBe(1)
        expect((prisma as any).transaction.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ gatewayRef: 'dp_1' }) }),
        )
    })

    it('leaves a session ZareCash cannot be read for alone', async () => {
        ;(prisma as any).zareCashCheckoutSession.findMany.mockResolvedValue([
            { id: 'local1', sessionId: 'cs_1', userId: 'u1', amount: '500', methodCode: 'zarecash', transactionId: null },
        ])
        getCheckoutSession.mockRejectedValue(new Error('boom'))

        const res = await ZareCashCheckoutService.sweepSessions()

        expect(res.linked).toBe(0)
        expect((prisma as any).transaction.create).not.toHaveBeenCalled()
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test zarecash-checkout-sweep`
Expected: FAIL — `sweepSessions is not a function`.

- [ ] **Step 3: Implement the sweep**

Add to `apps/api/src/services/zarecash-checkout.service.ts`, near the top:

```ts
/**
 * How long past `expiresAt` the hosted page still accepts a receipt. The session
 * is `open` for 20 minutes, then keeps taking a receipt for a further 24 hours
 * from a player who already sent money — only past that is it truly finished.
 */
const RECEIPT_WINDOW_MS = 24 * 60 * 60 * 1000

/** Bound on one sweep run, so a backlog cannot pin the worker. */
const SWEEP_BATCH = 200
```

And the method:

```ts
    /**
     * Two passes, both about sessions rather than events — the existing
     * GET /v1/events sweep already covers a missed webhook.
     */
    static async sweepSessions(): Promise<{ dead: number; linked: number }> {
        if (!isZareCashEnabled()) return { dead: 0, linked: 0 }

        const dead = await prisma.zareCashCheckoutSession.updateMany({
            where: {
                transactionId: null,
                depositId: null,
                status: { in: ['open', 'submitted'] },
                expiresAt: { lt: new Date(Date.now() - RECEIPT_WINDOW_MS) },
            },
            data: { status: 'dead' },
        })

        const pending = await prisma.zareCashCheckoutSession.findMany({
            where: {
                transactionId: null,
                sessionId: { not: null },
                status: { in: ['open', 'submitted'] },
            },
            orderBy: { createdAt: 'asc' },
            take: SWEEP_BATCH,
        })

        let linked = 0
        for (const session of pending) {
            let remote
            try {
                remote = await zarecashClient().getCheckoutSession(session.sessionId as string)
            } catch (err) {
                // Unreadable now, readable next run. Never let one bad session end
                // the pass for the ones behind it.
                console.warn(
                    '[ZareCashCheckout] could not read session %s: %s',
                    session.sessionId,
                    (err as Error)?.message,
                )
                continue
            }
            if (remote.depositId) {
                await ZareCashCheckoutService.materialise(session, remote.depositId)
                linked += 1
            } else if (remote.status !== session.status) {
                await prisma.zareCashCheckoutSession.update({
                    where: { id: session.id },
                    data: { status: remote.status },
                })
            }
        }

        return { dead: dead.count, linked }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test zarecash-checkout-sweep`
Expected: PASS (3 tests)

- [ ] **Step 5: Schedule it on the existing worker**

In `apps/api/src/workers/zarecash-sweep.worker.ts`, import `ZareCashCheckoutService`, export the job name, dispatch it, and schedule it:

```ts
/** Job name for the checkout-session pass. */
export const CHECKOUT_SWEEP_JOB = 'sweep-checkout-sessions'
```

In `processSweepJob`, before the final `sweepEvents()` call:

```ts
    if (job.name === CHECKOUT_SWEEP_JOB) {
        const result = await ZareCashCheckoutService.sweepSessions()
        console.log('[ZareCashSweep] checkout dead=%d linked=%d', result.dead, result.linked)
        return result
    }
```

In `scheduleZareCashSweep`, after the stranded pass:

```ts
    // Hourly, not nightly: a linked-but-unclaimed session is a player waiting on a
    // deposit they have already paid for.
    await queue.add(
        CHECKOUT_SWEEP_JOB,
        {},
        { repeat: { pattern: '7 * * * *' }, jobId: 'zarecash-checkout-sweep' },
    )
```

- [ ] **Step 6: Run the worker's own suite**

Run: `pnpm --filter @world-bingo/api test zarecash-sweep-worker`
Expected: PASS — the existing dispatch tests still pass with the new branch in place.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src
git commit -m "feat(zarecash): sweep stale and unlinked checkout sessions"
```

---

### Task 7: The two-card deposit UI

**Files:**
- Create: `apps/web/components/deposit/MethodCard.vue`
- Create: `apps/web/components/deposit/ManualDepositForm.vue`
- Modify: `apps/web/components/DepositModal.vue`
- Modify: `apps/web/i18n/locales/en.json`, `apps/web/i18n/locales/am.json`
- Modify: `apps/web/e2e/wallet-deposit-withdrawal.spec.ts:60-100`

**Interfaces:**
- Consumes: `GET /payment-methods?type=DEPOSIT` (Task 1 fields), `POST /wallet/deposit/checkout` (Task 3).
- Produces: `MethodCard` props `{ method: DepositMethod, expanded: boolean }`, emit `toggle`; `ManualDepositForm` props `{ method: DepositMethod }`, emits `submitted`.
- `DepositMethod` gains `gateway: string`, `hostedCheckout: boolean`, `logoUrl: string | null`.

- [ ] **Step 1: Extend the method type and fetch**

In `apps/web/components/DepositModal.vue`, add to the `DepositMethod` type:

```ts
  gateway: string
  hostedCheckout: boolean
  logoUrl: string | null
```

Replace `selectedMethod` single-select state with accordion state:

```ts
const openMethod = ref<string | null>(null)

function toggleMethod(m: DepositMethod) {
  openMethod.value = openMethod.value === m.code ? null : m.code
  if (openMethod.value) track('deposit_method_selected', { paymentMethod: m.code })
}
```

In `fetchMethods`, replace `selectedMethod.value = depositMethods.value[0]` with `openMethod.value = depositMethods.value[0]?.code ?? null`, and in `resetForm` with `openMethod.value = depositMethods.value[0]?.code ?? null`.

- [ ] **Step 2: Write the card component**

Create `apps/web/components/deposit/MethodCard.vue`:

```vue
<template>
  <section class="method-card" :class="{ 'method-card--open': expanded }">
    <header class="method-card__logo">
      <img v-if="method.logoUrl" :src="method.logoUrl" :alt="method.name" />
      <span v-else class="method-card__fallback">{{ method.icon || '💳' }} {{ method.name }}</span>
    </header>

    <div class="method-card__body">
      <h4 class="method-card__name">{{ method.name }}</h4>
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  method: { code: string; name: string; icon: string | null; logoUrl: string | null }
  expanded: boolean
}>()
</script>

<style scoped>
.method-card {
  border-radius: var(--radius-md, 12px);
  overflow: hidden;
  background: color-mix(in srgb, var(--brand-primary) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--brand-primary) 22%, transparent);
}
.method-card--open {
  border-color: color-mix(in srgb, var(--brand-primary) 48%, transparent);
}
.method-card__logo {
  background: #fff;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  min-height: 56px;
}
.method-card__logo img { max-height: 32px; width: auto; }
.method-card__fallback { font-weight: 700; color: #111; }
.method-card__body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 12px; }
.method-card__name {
  margin: 0;
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-primary);
}
</style>
```

- [ ] **Step 3: Move the manual form into its own component**

Create `apps/web/components/deposit/ManualDepositForm.vue` and move into it, verbatim from `DepositModal.vue`, the merchant banner (`.method-banner`, template lines 38-53), the amount field with chips (lines 55-73), the bonus hints (lines 75-83), the transaction-ID field (lines 85-98), the sender-name field (lines 100-104), the sender-account field (lines 106-110), the receipt drop-zone (lines 112-136), the notices (lines 138-163), and every script member they need (`form`, `fileInputRef`, `previewUrl`, `selectedFile`, `onFileChange`, `onFileDrop`, `setFile`, `canSubmit`, `submit`, `resetForm`, `errorTitle`, `errorHint`, plus the `.method-banner`, `.chips`, `.file-drop`, `.preview-img`, `.drop-hint`, `.hidden-input`, and `.deposit-bonus-hint*` styles). It takes `defineProps<{ method: DepositMethod }>()` and emits `submitted`. The modal keeps only the card list, the checkout call, and the footer.

- [ ] **Step 4: Rebuild the modal body**

Replace the `<template v-else>` block in `apps/web/components/DepositModal.vue`:

```vue
          <template v-else>
            <div class="method-stack">
              <DepositMethodCard
                v-for="m in depositMethods"
                :key="m.code"
                :method="m"
                :expanded="openMethod === m.code"
              >
                <template v-if="m.hostedCheckout">
                  <label class="wb-label">{{ t('wallet.amount') }}</label>
                  <input
                    v-model.number="checkoutAmount"
                    type="number"
                    :min="minDeposit"
                    class="wb-input"
                    @focus="openMethod = m.code"
                  />
                  <p v-if="checkoutError" class="wb-hint wb-hint--error">{{ checkoutError }}</p>
                  <button
                    class="wb-btn wb-btn--primary"
                    :disabled="redirecting || !(checkoutAmount >= minDeposit)"
                    @click="startCheckout(m)"
                  >
                    {{ redirecting ? t('wallet.redirecting') : t('wallet.continue') }}
                  </button>
                </template>

                <template v-else>
                  <button
                    v-if="openMethod !== m.code"
                    class="wb-btn wb-btn--primary"
                    @click="toggleMethod(m)"
                  >
                    {{ t('wallet.continue') }}
                  </button>
                  <DepositManualDepositForm v-else :method="m" @submitted="onManualSubmitted" />
                </template>
              </DepositMethodCard>
            </div>
          </template>
```

Add the checkout state and handler to the script:

```ts
const checkoutAmount = ref(0)
const checkoutError = ref('')
const redirecting = ref(false)
const minDeposit = 200

async function startCheckout(m: DepositMethod) {
  if (redirecting.value) return
  redirecting.value = true
  checkoutError.value = ''
  const amountBucket = checkoutAmount.value < 500 ? '<500' : checkoutAmount.value < 1000 ? '500-1000' : checkoutAmount.value < 5000 ? '1000-5000' : '5000+'
  track('deposit_amount_entered', { paymentMethod: m.code, amountBucket })
  try {
    const res = await auth.apiFetch<{ url: string }>('/wallet/deposit/checkout', {
      method: 'POST',
      body: { amount: checkoutAmount.value, methodCode: m.code },
    })
    // Always the URL from THIS response — a repeated idempotency key mints a
    // fresh link and kills the previous one.
    window.location.assign(res.url)
  } catch (e: any) {
    checkoutError.value = e?.data?.error ?? t('wallet.checkoutFailed')
    redirecting.value = false
  }
}

function onManualSubmitted() {
  emit('deposited')
  setTimeout(() => emit('update:modelValue', false), 2000)
}
```

Add the stack style:

```css
.method-stack { display: flex; flex-direction: column; gap: 14px; }
```

The footer's Submit button moves into `ManualDepositForm`; the modal footer keeps only Cancel.

- [ ] **Step 5: Add the strings**

`apps/web/i18n/locales/en.json`, under `wallet`:

```json
    "amount": "Amount",
    "continue": "Continue",
    "redirecting": "Redirecting…",
    "checkoutFailed": "Could not start the deposit. Please try again.",
    "confirmingDeposit": "We're confirming your deposit — your balance updates as soon as it clears.",
```

`apps/web/i18n/locales/am.json`, same keys:

```json
    "amount": "መጠን",
    "continue": "ቀጥል",
    "redirecting": "በማዛወር ላይ…",
    "checkoutFailed": "ክፍያውን መጀመር አልተቻለም። እባክዎ እንደገና ይሞክሩ።",
    "confirmingDeposit": "ተቀማጭዎን በማረጋገጥ ላይ ነን — እንደተጠናቀቀ ቀሪ ሂሳብዎ ይዘምናል።",
```

- [ ] **Step 6: Update the E2E expectations**

In `apps/web/e2e/wallet-deposit-withdrawal.spec.ts:60-100`, the deposit tests assert a flat TeleBirr form. Change them to open the manual card first:

```ts
        await page.getByRole('button', { name: /continue/i }).first().click()
        await expect(page.getByText(/TeleBirr/i)).toBeVisible()
```

Add a case covering the hosted-checkout card:

```ts
    test('hosted checkout card redirects to the ZareCash page', async ({ page }) => {
        await page.route('**/api/wallet/deposit/checkout', (route) =>
            route.fulfill({ json: { url: 'https://api.zarecash.com/pay/tok' } }),
        )
        await page.getByRole('button', { name: /deposit/i }).first().click()
        await page.getByLabel(/amount/i).first().fill('500')
        await page.getByRole('button', { name: /continue/i }).first().click()
        await expect(page).toHaveURL(/api\.zarecash\.com\/pay/)
    })
```

- [ ] **Step 7: Verify**

Run: `pnpm --filter @world-bingo/web build`
Expected: builds clean. Per the project's known-red gates, do not trust a bare `pnpm test` exit code here — check this suite's own output.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(web): stack deposit methods as cards with a hosted-checkout option"
```

---

### Task 8: The return-from-ZareCash state

**Files:**
- Modify: `apps/web/pages/wallet.vue:1-20,360-370`

**Interfaces:**
- Consumes: `POST /wallet/deposit/checkout/claim` (Task 4), `wallet.confirmingDeposit` (Task 7).
- Produces: nothing downstream.

- [ ] **Step 1: Handle the return query**

In `apps/web/pages/wallet.vue`, add to the script:

```ts
const route = useRoute()
const confirmingDeposit = ref(false)

/**
 * ZareCash sends the player back with ?deposit=dp_…&status=pending.
 *
 * `pending` means a receipt was accepted, NOT that money arrived — the balance
 * moves only when the deposit.approved webhook lands. So this claims the deposit
 * (which creates the local pending row) and shows a waiting state. It must never
 * credit anything.
 */
async function claimReturnedDeposit() {
  const depositId = route.query.deposit
  if (typeof depositId !== 'string' || !depositId) return
  // Strip the query first so a refresh does not re-run this.
  router.replace({ path: '/wallet' })
  confirmingDeposit.value = true
  try {
    await auth.apiFetch('/wallet/deposit/checkout/claim', {
      method: 'POST',
      body: { depositId },
    })
  } catch {
    // The webhook is the source of truth and will create the row without us.
    // A failed claim is not worth alarming the player over.
  }
  await Promise.all([refreshBalance(), fetchRecentTx()])
}
```

Call it from the existing `onMounted`, after the authentication guard:

```ts
  await claimReturnedDeposit()
```

- [ ] **Step 2: Show the waiting state**

Above the deposit/withdraw action buttons in the template:

```vue
      <div v-if="confirmingDeposit" class="wb-notice wb-notice--info">
        <span class="wb-notice__title">{{ t('wallet.confirmingDeposit') }}</span>
      </div>
```

- [ ] **Step 3: Verify**

Run: `pnpm --filter @world-bingo/web build`
Expected: builds clean.

Then start the dev server and load `/wallet?deposit=dp_test&status=pending` with the API stubbed to 404 the claim — the banner must appear and the URL must lose its query string.

- [ ] **Step 4: Commit**

```bash
git add apps/web/pages/wallet.vue
git commit -m "feat(web): confirm-in-progress state when returning from ZareCash"
```

---

### Task 9: Configuration notes and runbook

**Files:**
- Modify: `apps/api/.env.example:62`, `.env.example:142-152`
- Modify: `apps/api/scripts/zarecash-sandbox.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Document the returnUrl coupling**

Above `WEB_BASE_URL` in `apps/api/.env.example`, add:

```
# Also the origin ZareCash hosted checkout returns players to. It MUST match the
# Custom URL configured for this tenant in the ZareCash console, or every
# POST /v1/checkout/sessions fails with invalid_return_url.
```

In the ZareCash block of both `.env.example` files, add:

```
# Hosted checkout has no env switch of its own: it is enabled by the
# PaymentMethod row with hostedCheckout = true and enabled = true.
```

- [ ] **Step 2: Extend the sandbox runbook**

Append a hosted-checkout section to `apps/api/scripts/zarecash-sandbox.md` covering: enabling the seeded `zarecash` method, setting the console Custom URL to `WEB_BASE_URL`, walking the redirect with a `pk_test_` key, using `TEST-REVIEW-*` on the hosted page to exercise the waiting state and `TEST-REJECT-*` for the rejection path, and confirming `GET /v1/float` reports `"mode": "test"`.

- [ ] **Step 3: Note the new queue job**

In `CLAUDE.md`, the BullMQ workers line lists the queue set. Add the checkout pass to the ZareCash sweep description so the next reader knows an hourly job exists.

- [ ] **Step 4: Commit**

```bash
git add apps/api/.env.example .env.example apps/api/scripts/zarecash-sandbox.md CLAUDE.md
git commit -m "docs(zarecash): document hosted checkout configuration and sandbox walk"
```
