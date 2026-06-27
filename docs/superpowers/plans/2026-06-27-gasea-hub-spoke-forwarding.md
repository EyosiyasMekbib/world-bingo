# GASea hub/spoke wallet-callback forwarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GASea wallet callbacks settle for both hub-local (`h00`) and spoke (`btb`) users by de-namespacing the username locally and forwarding spoke-prefixed callbacks, mirroring the existing Palace pattern.

**Architecture:** A shared `dispatchGaseaWallet(command, body)` carries the 7-command→service mapping. The public aggregator route funnels every callback through `handleGaseaCallback`, which on a **hub** uses the generic `decideCallbackRoute` to either settle locally (prefix stripped) or HMAC-forward to the owning spoke's new `/v1/hub/gasea-callback` receiver. The spoke receiver verifies the hub HMAC and calls the same dispatcher. All generic hub primitives (`decideCallbackRoute`, `namespace`, `hub-auth`, `deployment-config`) are reused unchanged.

**Tech Stack:** Fastify v5, TypeScript (ESM, `.js` import suffixes), Vitest, Prisma. Spec: `docs/superpowers/specs/2026-06-27-gasea-hub-spoke-forwarding-design.md`.

## Global Constraints

- ESM imports MUST use `.js` suffix (e.g. `from '../services/x.js'`), even for `.ts` source.
- GASea callbacks ALWAYS return HTTP 200 with a `{ traceId, status, data? }` body; non-200 means "retry" to GASea. The hub→spoke receiver returns 401 only on bad signature.
- Hub→spoke auth: HMAC-SHA256 over the exact raw body, header `x-signature`, signed with the per-spoke `secret` (hub side) and verified with `cfg.hubSecret` (spoke side). Deployment code header: `x-deployment`.
- Deployment code is exactly 3 lowercase-alphanumeric chars; GASea username ≤ 40 chars; bare username = 32-hex UUID.
- Run all commands from `apps/api/`. Test runner: `pnpm vitest run <file>`.
- Do NOT modify `ThirdPartyWalletService` or the Palace flow. `resolveUser` stays a pure bare-username resolver; prefix stripping lives only in the routing layer.

---

### Task 1: Shared GASea wallet dispatcher

Extract the 7-command→service mapping (currently inlined in `routes/aggregator/wallet.ts`) into one reusable function. Behaviour for a bare username is identical to today.

**Files:**
- Create: `apps/api/src/services/gasea-wallet-dispatch.ts`
- Test: `apps/api/src/test/gasea-wallet-dispatch.test.ts`

**Interfaces:**
- Consumes: `ThirdPartyWalletService` (existing), `WalletCallbackResponse` (exported from `services/third-party-wallet.service.ts`).
- Produces: `dispatchGaseaWallet(command: string, body: any): Promise<WalletCallbackResponse>` — maps a GASea command + callback body to the matching `ThirdPartyWalletService` method. Unknown command → `{ traceId, status: 'SC_INTERNAL_ERROR' }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/gasea-wallet-dispatch.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const svc = {
  getBalance: vi.fn(async () => ({ traceId: 't', status: 'SC_OK', data: { username: 'u', currency: 'ETB', balance: 1, timestamp: 0 } })),
  processBet: vi.fn(async () => ({ traceId: 't', status: 'SC_OK' })),
  processBetResult: vi.fn(async () => ({ traceId: 't', status: 'SC_OK' })),
  processRollback: vi.fn(async () => ({ traceId: 't', status: 'SC_OK' })),
  processAdjustment: vi.fn(async () => ({ traceId: 't', status: 'SC_OK' })),
  processBetDebit: vi.fn(async () => ({ traceId: 't', status: 'SC_OK' })),
  processBetCredit: vi.fn(async () => ({ traceId: 't', status: 'SC_OK' })),
}
vi.mock('../services/third-party-wallet.service.js', () => ({ ThirdPartyWalletService: svc }))

let dispatchGaseaWallet: typeof import('../services/gasea-wallet-dispatch.js')['dispatchGaseaWallet']
beforeEach(async () => {
  vi.clearAllMocks()
  ;({ dispatchGaseaWallet } = await import('../services/gasea-wallet-dispatch.js'))
})

describe('dispatchGaseaWallet', () => {
  it('routes balance with mapped params', async () => {
    await dispatchGaseaWallet('balance', { traceId: 't', username: 'u', currency: 'ETB', token: 'tok' })
    expect(svc.getBalance).toHaveBeenCalledWith({ traceId: 't', username: 'u', currency: 'ETB', token: 'tok' })
  })

  it('routes bet with mapped params', async () => {
    const body = { traceId: 't', username: 'u', transactionId: 'x1', betId: 'b1', amount: 5, currency: 'ETB', gameCode: 'g', roundId: 'r', timestamp: 1 }
    await dispatchGaseaWallet('bet', body)
    expect(svc.processBet).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 'x1', amount: 5, username: 'u' }))
  })

  it('defaults jackpotAmount/settledTime to 0 on bet_result', async () => {
    await dispatchGaseaWallet('bet_result', { traceId: 't', username: 'u', transactionId: 'x', betId: 'b', roundId: 'r', betAmount: 1, winAmount: 2, effectiveTurnover: 1, winLoss: 1, resultType: 'WIN', isFreespin: 0, isEndRound: 1, currency: 'ETB', gameCode: 'g', betTime: 1 })
    expect(svc.processBetResult).toHaveBeenCalledWith(expect.objectContaining({ jackpotAmount: 0, settledTime: 0 }))
  })

  it('routes the remaining commands', async () => {
    await dispatchGaseaWallet('rollback', { traceId: 't', username: 'u', transactionId: 'x', betId: 'b', roundId: 'r', gameCode: 'g', currency: 'ETB', timestamp: 1 })
    await dispatchGaseaWallet('adjustment', { traceId: 't', username: 'u', transactionId: 'x', roundId: 'r', amount: 1, currency: 'ETB', gameCode: 'g', timestamp: 1 })
    await dispatchGaseaWallet('bet_debit', { traceId: 't', username: 'u', transactionId: 'x', roundId: 'r', takeAll: 0, amount: 1, currency: 'ETB', gameCode: 'g', timestamp: 1 })
    await dispatchGaseaWallet('bet_credit', { traceId: 't', username: 'u', transactionId: 'x', roundId: 'r', isRefund: 0, amount: 1, betAmount: 1, winAmount: 0, effectiveTurnover: 1, winLoss: -1, currency: 'ETB', gameCode: 'g', betTime: 1, timestamp: 1 })
    expect(svc.processRollback).toHaveBeenCalled()
    expect(svc.processAdjustment).toHaveBeenCalled()
    expect(svc.processBetDebit).toHaveBeenCalled()
    expect(svc.processBetCredit).toHaveBeenCalled()
  })

  it('returns SC_INTERNAL_ERROR for an unknown command', async () => {
    const res = await dispatchGaseaWallet('nope', { traceId: 't' })
    expect(res).toEqual({ traceId: 't', status: 'SC_INTERNAL_ERROR' })
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm vitest run src/test/gasea-wallet-dispatch.test.ts`
Expected: FAIL — cannot find module `../services/gasea-wallet-dispatch.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/gasea-wallet-dispatch.ts`:

```ts
import { ThirdPartyWalletService } from './third-party-wallet.service.js'
import type { WalletCallbackResponse } from './third-party-wallet.service.js'

/**
 * Maps a GASea wallet command + callback body to the matching settlement method.
 * The username in `body` MUST already be bare (de-namespaced) — the routing layer
 * strips the deployment-code prefix before calling this. Shared by the hub-local
 * path (routes/aggregator/wallet.ts) and the spoke receiver (routes/hub/gasea-callback.ts).
 */
export async function dispatchGaseaWallet(command: string, body: any): Promise<WalletCallbackResponse> {
  switch (command) {
    case 'balance':
      return ThirdPartyWalletService.getBalance({
        traceId: body.traceId, username: body.username, currency: body.currency, token: body.token,
      })
    case 'bet':
      return ThirdPartyWalletService.processBet({
        traceId: body.traceId, username: body.username, transactionId: body.transactionId,
        betId: body.betId, externalTransactionId: body.externalTransactionId, amount: body.amount,
        currency: body.currency, token: body.token, gameCode: body.gameCode, roundId: body.roundId,
        timestamp: body.timestamp,
      })
    case 'bet_result':
      return ThirdPartyWalletService.processBetResult({
        traceId: body.traceId, username: body.username, transactionId: body.transactionId,
        betId: body.betId, externalTransactionId: body.externalTransactionId, roundId: body.roundId,
        betAmount: body.betAmount, winAmount: body.winAmount, effectiveTurnover: body.effectiveTurnover,
        winLoss: body.winLoss, jackpotAmount: body.jackpotAmount ?? 0, resultType: body.resultType,
        isFreespin: body.isFreespin, isEndRound: body.isEndRound, currency: body.currency,
        token: body.token, gameCode: body.gameCode, betTime: body.betTime, settledTime: body.settledTime ?? 0,
      })
    case 'rollback':
      return ThirdPartyWalletService.processRollback({
        traceId: body.traceId, transactionId: body.transactionId, betId: body.betId,
        externalTransactionId: body.externalTransactionId, roundId: body.roundId, gameCode: body.gameCode,
        username: body.username, currency: body.currency, timestamp: body.timestamp,
      })
    case 'adjustment':
      return ThirdPartyWalletService.processAdjustment({
        traceId: body.traceId, username: body.username, transactionId: body.transactionId,
        externalTransactionId: body.externalTransactionId, roundId: body.roundId, amount: body.amount,
        currency: body.currency, gameCode: body.gameCode, timestamp: body.timestamp,
      })
    case 'bet_debit':
      return ThirdPartyWalletService.processBetDebit({
        traceId: body.traceId, username: body.username, transactionId: body.transactionId,
        roundId: body.roundId, takeAll: body.takeAll, amount: body.amount, currency: body.currency,
        gameCode: body.gameCode, timestamp: body.timestamp,
      })
    case 'bet_credit':
      return ThirdPartyWalletService.processBetCredit({
        traceId: body.traceId, username: body.username, transactionId: body.transactionId,
        betId: body.betId, roundId: body.roundId, isRefund: body.isRefund, amount: body.amount,
        betAmount: body.betAmount, winAmount: body.winAmount, effectiveTurnover: body.effectiveTurnover,
        winLoss: body.winLoss, jackpotAmount: body.jackpotAmount ?? 0, currency: body.currency,
        token: body.token, gameCode: body.gameCode, betTime: body.betTime, settledTime: body.settledTime ?? 0,
        timestamp: body.timestamp,
      })
    default:
      return { traceId: body?.traceId ?? '', status: 'SC_INTERNAL_ERROR' }
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm vitest run src/test/gasea-wallet-dispatch.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/gasea-wallet-dispatch.ts apps/api/src/test/gasea-wallet-dispatch.test.ts
git commit -m "feat(gasea): shared dispatchGaseaWallet command->service mapping"
```

---

### Task 2: Hub routing + forward helpers

The hub-side orchestration: de-namespace for local, HMAC-forward for spokes, re-namespace the echoed username.

**Files:**
- Create: `apps/api/src/gateways/hub/gasea-forward.ts`
- Test: `apps/api/src/test/gasea-hub-routing.test.ts`

**Interfaces:**
- Consumes: `deploymentConfig` (`gateways/hub/deployment-config.js`), `decideCallbackRoute` (`gateways/hub/route-callback.js`), `signBody`, `DEPLOYMENT_HEADER`, `SIGNATURE_HEADER` (`gateways/hub/hub-auth.js`), `dispatchGaseaWallet` (Task 1), `SpokeEntry` type, `WalletCallbackResponse` type.
- Produces:
  - `handleGaseaCallback(command: string, body: any): Promise<WalletCallbackResponse>` — entrypoint the aggregator route calls for every command.
  - `forwardToSpoke(spoke: SpokeEntry, command: string, body: any): Promise<WalletCallbackResponse>`
  - `reNamespaceUsername(res: WalletCallbackResponse, original: string): WalletCallbackResponse`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/gasea-hub-routing.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetDeploymentConfigForTests } from '../gateways/hub/deployment-config.js'

const dispatch = vi.fn(async (_command: string, body: any) => ({
  traceId: body.traceId, status: 'SC_OK',
  data: { username: body.username, currency: 'ETB', balance: 9, timestamp: 0 },
}))
vi.mock('../services/gasea-wallet-dispatch.js', () => ({ dispatchGaseaWallet: dispatch }))

const SPOKE_SECRET = 'spoke-sec'
let mod: typeof import('../gateways/hub/gasea-forward.js')

beforeEach(async () => {
  vi.clearAllMocks()
  process.env.DEPLOYMENT_ROLE = 'hub'
  process.env.DEPLOYMENT_CODE = 'h00'
  process.env.HUB_DEPLOYMENTS = JSON.stringify([{ code: 'btb', baseUrl: 'https://spoke.test', secret: SPOKE_SECRET }])
  process.env.HUB_URL = ''
  process.env.HUB_SHARED_SECRET = ''
  resetDeploymentConfigForTests()
  mod = await import('../gateways/hub/gasea-forward.js')
})

describe('handleGaseaCallback (hub)', () => {
  it('strips the hub prefix and settles locally, echoing the original username', async () => {
    const ns = 'h00' + 'a'.repeat(32)
    const res = await mod.handleGaseaCallback('balance', { traceId: 't', username: ns, currency: 'ETB' })
    expect(dispatch).toHaveBeenCalledWith('balance', expect.objectContaining({ username: 'a'.repeat(32) }))
    expect(res.data?.username).toBe(ns) // re-namespaced echo
  })

  it('forwards a spoke-prefixed callback with a per-spoke HMAC and bare username', async () => {
    const { signBody } = await import('../gateways/hub/hub-auth.js')
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ traceId: 't', status: 'SC_OK', data: { username: 'b'.repeat(32), currency: 'ETB', balance: 3, timestamp: 0 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const ns = 'btb' + 'b'.repeat(32)
    const res = await mod.handleGaseaCallback('bet', { traceId: 't', username: ns, amount: 5 })

    expect(dispatch).not.toHaveBeenCalled()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://spoke.test/v1/hub/gasea-callback')
    const sentRaw = opts!.body as string
    expect(JSON.parse(sentRaw)).toEqual({ command: 'bet', body: { traceId: 't', username: 'b'.repeat(32), amount: 5 } })
    expect((opts!.headers as any)['x-signature']).toBe(signBody(SPOKE_SECRET, sentRaw))
    expect((opts!.headers as any)['x-deployment']).toBe('h00')
    expect(res.data?.username).toBe(ns) // re-namespaced echo
    vi.unstubAllGlobals()
  })

  it('returns SC_INTERNAL_ERROR when the spoke forward throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const ns = 'btb' + 'c'.repeat(32)
    const res = await mod.handleGaseaCallback('balance', { traceId: 't', username: ns })
    expect(res).toEqual({ traceId: 't', status: 'SC_INTERNAL_ERROR' })
    vi.unstubAllGlobals()
  })

  it('falls back to local dispatch for an unknown prefix (raw username)', async () => {
    const res = await mod.handleGaseaCallback('balance', { traceId: 't', username: 'plainuser' })
    expect(dispatch).toHaveBeenCalledWith('balance', expect.objectContaining({ username: 'plainuser' }))
    expect(res.status).toBe('SC_OK')
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm vitest run src/test/gasea-hub-routing.test.ts`
Expected: FAIL — cannot find module `../gateways/hub/gasea-forward.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/gateways/hub/gasea-forward.ts`:

```ts
import { deploymentConfig } from './deployment-config.js'
import type { SpokeEntry } from './deployment-config.js'
import { decideCallbackRoute } from './route-callback.js'
import { signBody, DEPLOYMENT_HEADER, SIGNATURE_HEADER } from './hub-auth.js'
import { dispatchGaseaWallet } from '../../services/gasea-wallet-dispatch.js'
import type { WalletCallbackResponse } from '../../services/third-party-wallet.service.js'

// Reuse the generic spoke-leg budget (already set in prod env as PALACE_SPOKE_TIMEOUT_MS).
const SPOKE_FORWARD_TIMEOUT_MS = Number(process.env.PALACE_SPOKE_TIMEOUT_MS ?? 5000)

/** Echo back the exact (namespaced) username GASea sent, regardless of what the
 *  settling node resolved with. GASea may validate the echoed username. */
export function reNamespaceUsername(res: WalletCallbackResponse, original: string): WalletCallbackResponse {
  if (res?.data && typeof res.data === 'object') res.data.username = original
  return res
}

/** Hub → spoke: re-sign with the per-spoke secret and POST to the spoke's receiver. */
export async function forwardToSpoke(spoke: SpokeEntry, command: string, body: any): Promise<WalletCallbackResponse> {
  const cfg = deploymentConfig()
  const raw = JSON.stringify({ command, body })
  const sig = signBody(spoke.secret, raw)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SPOKE_FORWARD_TIMEOUT_MS)
  try {
    const res = await fetch(`${spoke.baseUrl}/v1/hub/gasea-callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [DEPLOYMENT_HEADER]: cfg.code,
        [SIGNATURE_HEADER]: sig,
      },
      body: raw,
      signal: controller.signal,
    })
    if (!res.ok) return { traceId: body?.traceId ?? '', status: 'SC_INTERNAL_ERROR' }
    return (await res.json()) as WalletCallbackResponse
  } catch {
    return { traceId: body?.traceId ?? '', status: 'SC_INTERNAL_ERROR' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Entry point for every GASea wallet callback. On a hub, route by the username's
 * deployment-code prefix: local (strip + settle here) or forward (to the owning
 * spoke). On standalone/spoke, settle locally exactly as before.
 */
export async function handleGaseaCallback(command: string, body: any): Promise<WalletCallbackResponse> {
  const cfg = deploymentConfig()
  if (cfg.role !== 'hub') return dispatchGaseaWallet(command, body)

  const original = String(body?.username ?? '')
  const route = decideCallbackRoute(cfg, original)

  if (route.kind === 'forward') {
    const res = await forwardToSpoke(route.spoke, command, { ...body, username: route.account })
    return reNamespaceUsername(res, original)
  }
  // 'local' (own prefix stripped) or 'unknown' (raw username) → settle locally.
  const res = await dispatchGaseaWallet(command, { ...body, username: route.account })
  return reNamespaceUsername(res, original)
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm vitest run src/test/gasea-hub-routing.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/gateways/hub/gasea-forward.ts apps/api/src/test/gasea-hub-routing.test.ts
git commit -m "feat(gasea): hub routing + spoke-forward helpers"
```

---

### Task 3: Spoke receiver route

The spoke-side sink for hub-forwarded GASea callbacks. Verifies the hub HMAC, then dispatches with the already-bare username.

**Files:**
- Create: `apps/api/src/routes/hub/gasea-callback.ts`
- Test: `apps/api/src/test/gasea-spoke-callback.test.ts`

**Interfaces:**
- Consumes: `deploymentConfig`, `verifySignature`, `DEPLOYMENT_HEADER`, `SIGNATURE_HEADER`, `dispatchGaseaWallet` (Task 1), `signBody` (test only).
- Produces: `gaseaSpokeCallbackRoute: FastifyPluginAsync` (default-less named export), mounted at `/v1/hub/gasea-callback` for `role==='spoke'`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/gasea-spoke-callback.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { signBody } from '../gateways/hub/hub-auth.js'
import { resetDeploymentConfigForTests } from '../gateways/hub/deployment-config.js'

const dispatch = vi.fn(async (_c: string, body: any) => ({
  traceId: body.traceId, status: 'SC_OK', data: { username: body.username, currency: 'ETB', balance: 7, timestamp: 0 },
}))
vi.mock('../services/gasea-wallet-dispatch.js', () => ({ dispatchGaseaWallet: dispatch }))

const SECRET = 'hub-shared'
beforeEach(() => {
  vi.clearAllMocks()
  process.env.DEPLOYMENT_ROLE = 'spoke'
  process.env.DEPLOYMENT_CODE = 'btb'
  process.env.HUB_URL = 'https://hub'
  process.env.HUB_SHARED_SECRET = SECRET
  resetDeploymentConfigForTests()
})

async function buildApp() {
  const app = Fastify()
  const { gaseaSpokeCallbackRoute } = await import('../routes/hub/gasea-callback.js')
  await app.register(gaseaSpokeCallbackRoute, { prefix: '/v1/hub/gasea-callback' })
  return app
}

describe('gasea spoke-callback sink', () => {
  it('dispatches a correctly signed callback with the bare username', async () => {
    const app = await buildApp()
    const body = JSON.stringify({ command: 'balance', body: { traceId: 't', username: 'a'.repeat(32), currency: 'ETB' } })
    const res = await app.inject({
      method: 'POST', url: '/v1/hub/gasea-callback',
      headers: { 'content-type': 'application/json', 'x-deployment': 'h00', 'x-signature': signBody(SECRET, body) },
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'SC_OK' })
    expect(dispatch).toHaveBeenCalledWith('balance', expect.objectContaining({ username: 'a'.repeat(32) }))
  })

  it('rejects a bad signature with 401', async () => {
    const app = await buildApp()
    const body = JSON.stringify({ command: 'balance', body: { traceId: 't', username: 'a'.repeat(32) } })
    const res = await app.inject({
      method: 'POST', url: '/v1/hub/gasea-callback',
      headers: { 'content-type': 'application/json', 'x-deployment': 'h00', 'x-signature': 'deadbeef' },
      payload: body,
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ status: 'SC_INVALID_SIGNATURE' })
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm vitest run src/test/gasea-spoke-callback.test.ts`
Expected: FAIL — cannot find module `../routes/hub/gasea-callback.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/routes/hub/gasea-callback.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify'
import { deploymentConfig } from '../../gateways/hub/deployment-config.js'
import { verifySignature, DEPLOYMENT_HEADER, SIGNATURE_HEADER } from '../../gateways/hub/hub-auth.js'
import { dispatchGaseaWallet } from '../../services/gasea-wallet-dispatch.js'

/**
 * Spoke-side sink for hub-forwarded GASea wallet callbacks. The username is already
 * de-namespaced by the hub. Authenticated by the hub's HMAC over the raw body
 * (not by GASea's signature — the spoke holds no GASea credentials).
 * Forwarded envelope: { command, body }.
 */
export const gaseaSpokeCallbackRoute: FastifyPluginAsync = async (fastify) => {
  // Capture the raw body so the HMAC matches byte-for-byte what the hub signed.
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, { __rawBody: body as string, ...JSON.parse(body as string) })
    } catch (e) {
      done(e as Error, undefined)
    }
  })

  fastify.post('/', async (req, reply) => {
    const cfg = deploymentConfig()
    const raw = (req.body as any)?.__rawBody ?? ''
    const sig = req.headers[SIGNATURE_HEADER] as string | undefined
    const dep = req.headers[DEPLOYMENT_HEADER] as string | undefined

    if (!sig || !dep || !verifySignature(cfg.hubSecret, raw, sig)) {
      return reply.status(401).send({ traceId: '', status: 'SC_INVALID_SIGNATURE' })
    }

    const { command, body: d = {} } = req.body as { command?: string; body?: Record<string, any> }
    req.log.info({ callingHub: dep, command }, '[Hub] gasea spoke-callback received')
    try {
      return reply.status(200).send(await dispatchGaseaWallet(command ?? '', d))
    } catch (err) {
      req.log.error({ err, command, callingHub: dep }, '[Hub] gasea spoke-callback dispatch failed')
      return reply.status(200).send({ traceId: (d as any)?.traceId ?? '', status: 'SC_INTERNAL_ERROR' })
    }
  })
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm vitest run src/test/gasea-spoke-callback.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/hub/gasea-callback.ts apps/api/src/test/gasea-spoke-callback.test.ts
git commit -m "feat(gasea): spoke-side hub-forwarded callback receiver"
```

---

### Task 4: Wire the aggregator route + register the spoke receiver + rate-limit allowlist

Route the 7 public endpoints through `handleGaseaCallback`, mount the spoke receiver, and exempt `/v1/hub/` from rate limiting.

**Files:**
- Modify: `apps/api/src/routes/aggregator/wallet.ts` (all 7 handlers)
- Modify: `apps/api/src/index.ts` (import + register `gaseaSpokeCallbackRoute` under `if role==='spoke'`; add `/v1/hub/` to `allowList`)

**Interfaces:**
- Consumes: `handleGaseaCallback` (Task 2), `gaseaSpokeCallbackRoute` (Task 3).

- [ ] **Step 1: Rewrite the aggregator wallet handlers**

Replace the body of `apps/api/src/routes/aggregator/wallet.ts` with the thin version (raw-body hook unchanged; each handler delegates to `handleGaseaCallback`):

```ts
import { Readable } from 'node:stream'
import type { FastifyPluginAsync } from 'fastify'
import { verifyGaseaSignature } from '../../gateways/game-provider/signature.middleware.js'
import { handleGaseaCallback } from '../../gateways/hub/gasea-forward.js'

/**
 * GASea wallet callback routes. Mounted under /v1/aggregator/wallet (index.ts).
 * All return HTTP 200 — GASea interprets non-200 as a network failure.
 * Auth: HMAC-SHA256 X-Signature (verifyGaseaSignature). Hub/spoke routing is
 * applied inside handleGaseaCallback: a hub forwards spoke-prefixed callbacks;
 * a standalone/spoke settles locally.
 */
const COMMANDS = ['balance', 'bet', 'bet_result', 'rollback', 'adjustment', 'bet_debit', 'bet_credit'] as const

const aggregatorWalletRoutes: FastifyPluginAsync = async (fastify) => {
  // Raw body capture for HMAC verification (preParsing runs before any parser).
  fastify.addHook('preParsing', async (request, _reply, payload) => {
    const chunks: Buffer[] = []
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any))
    }
    const rawBuffer = Buffer.concat(chunks)
    ;(request as any).rawBody = rawBuffer.toString('utf8')
    return Readable.from(rawBuffer)
  })

  for (const command of COMMANDS) {
    fastify.post(`/${command}`, {
      preHandler: [verifyGaseaSignature],
      handler: async (req) => handleGaseaCallback(command, req.body as any),
    })
  }
}

export default aggregatorWalletRoutes
```

- [ ] **Step 2: Register the spoke receiver and fix the rate-limit allowlist in `index.ts`**

Add the import beside the existing hub-route imports (near `apps/api/src/index.ts:40`):

```ts
import { gaseaSpokeCallbackRoute } from './routes/hub/gasea-callback.js'
```

In the rate-limit `allowList` (around `apps/api/src/index.ts:124`), add a `/v1/hub/` exemption so server-to-server hub→spoke forwards are never throttled. The block becomes:

```ts
    allowList: (req) => {
        if (req.url.startsWith('/v1/aggregator/')) return true
        if (req.url.startsWith('/v1/palace/')) return true
        if (req.url.startsWith('/v1/hub/')) return true
        const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip
        return rateLimitWhitelist.has(ip)
    },
```

In the spoke registration block (around `apps/api/src/index.ts:264-266`), add the GASea receiver next to the Palace one:

```ts
if (deploymentConfig().role === 'spoke') {
    await server.register(spokeCallbackRoute, { prefix: '/v1/hub/spoke-callback' })
    await server.register(gaseaSpokeCallbackRoute, { prefix: '/v1/hub/gasea-callback' })
}
```

- [ ] **Step 3: Verify no regression on the existing GASea wallet test + typecheck**

Run: `pnpm vitest run src/test/gasea-wallet.test.ts`
Expected: PASS — standalone settlement behaviour is unchanged (role unset → `handleGaseaCallback` calls `dispatchGaseaWallet` directly with the bare username).

Run: `pnpm --filter @world-bingo/api typecheck`
Expected: no type errors.

> Note (per project memory): the apps/api Vitest suite is non-isolated and DB-dependent tests can be flaky; trust `typecheck` + the targeted new specs over the full-suite pass/fail count. If `gasea-wallet.test.ts` needs the test DB, run `pnpm prisma db push` against the test DB first.

- [ ] **Step 4: Run all four new/affected specs together**

Run: `pnpm vitest run src/test/gasea-wallet-dispatch.test.ts src/test/gasea-hub-routing.test.ts src/test/gasea-spoke-callback.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/aggregator/wallet.ts apps/api/src/index.ts
git commit -m "feat(gasea): route wallet callbacks through hub/spoke forwarding; exempt /v1/hub from rate limit"
```

---

## Post-implementation (operational — outside this plan's code)

These are deploy-time actions, tracked here so they aren't lost:

1. **GASea dashboard callback URL → hub:** ensure it is `https://api.aradabingo.bet/v1/aggregator/wallet` (single shared GASea merchant account = one URL). If currently betbawa's, move it to arada.
2. **Redeploy both brands** (arada hub, betbawa spoke) so the new code + the spoke route mount take effect (`deploymentConfig()` is read once at boot).
3. **Verify:** launch a GASea game from a betbawa account, place a small bet → arada logs the forward, betbawa logs `[Hub] gasea spoke-callback received`, balance moves. Then verify the same on an arada account (the local de-namespace fix).
4. **Optional hygiene:** remove now-unused `GASEA_API_KEY`/`GASEA_API_SECRET` from betbawa's env (spoke forwards launches via the hub; never instantiates `GaseaGateway`).

## Self-Review

**Spec coverage:**
- Component 1 (shared dispatcher) → Task 1. ✓
- Component 2 (hub routing layer) → Task 2 (`handleGaseaCallback`). ✓
- Component 3 (`forwardToSpoke`) → Task 2. ✓
- Component 4 (spoke receiver) → Task 3. ✓
- Component 5 (local de-namespace) → Task 2 via `route.account` into the dispatcher; regression covered by the `h00`-strip test. ✓
- Username echo → Task 2 (`reNamespaceUsername`) + tests in Tasks 2/3. ✓
- Error/HTTP semantics (200 + SC_INTERNAL_ERROR on forward failure) → Task 2 test "spoke forward throws". ✓
- Security (hub HMAC, spoke shielded from GASea sig) → Task 3 (verify `cfg.hubSecret`). ✓
- Operational reqs (callback URL, rate-limit `/v1/hub/`, optional cred removal) → Task 4 Step 2 (allowlist) + Post-implementation. ✓
- Testing plan items 1–7 → Tasks 1–3 tests. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `dispatchGaseaWallet(command, body)`, `handleGaseaCallback(command, body)`, `forwardToSpoke(spoke, command, body)`, `reNamespaceUsername(res, original)`, `gaseaSpokeCallbackRoute` — names/signatures consistent across tasks and tests. Forward envelope `{ command, body }` consistent between `forwardToSpoke` (Task 2) and the spoke receiver's `{ command, body: d }` (Task 3). Response shape `{ traceId, status, data? }` consistent throughout.
