# Provider Gateway Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let multiple independent World Bingo deployments share one upstream game-provider account (Palace first) by routing all provider traffic through one elected "hub" deployment that namespaces player identities and routes callbacks back to the owning deployment.

**Architecture:** One existing deployment is elected the **hub**; it owns the provider API token + the single callback URL. Other deployments (**spokes**) call the hub's internal provider API instead of the provider directly. The hub injects a deployment-code prefix into the player identity (the Palace `account` field) on every outbound call, and on every inbound callback it parses that prefix, strips it, and forwards the de-namespaced callback to the owning deployment's existing handler. A `DEPLOYMENT_ROLE` env switch (`standalone` | `hub` | `spoke`) selects behaviour; `standalone` (default) preserves today's single-deployment behaviour exactly.

**Tech Stack:** Fastify v5, TypeScript (ESM, `.js` import specifiers), Node `crypto` (HMAC), Redis, Vitest. No new runtime dependencies.

---

## Background facts (verified against current code)

- The player identity sent to the provider is the **`account`** field. At launch it is `user.id` with dashes stripped → 32 lowercase-hex chars (`routes/game-provider/index.ts:117`, sent as `username` at line 123).
- On callback, Palace echoes that value back as `d.account`. `resolveUser(account)` (`services/palace-wallet.service.ts:57-73`) parses a 32-hex string back into a UUID and looks up the local user; otherwise it treats `account` as a plain username.
- The callback route (`routes/palace/callback.ts`) dispatches by `command` and passes `d.account` into `PalaceWalletService`. It is mounted at `/v1/palace/callback` (`index.ts:237`).
- Provider gateways are resolved from a registry (`gateways/game-provider/index.ts`) keyed by `providerCode`, all implementing `GameProviderGateway` (`gateways/game-provider/game-provider.interface.ts`).
- Existing env vars: `PALACE_API_BASE_URL`, `PALACE_API_TOKEN`, `PALACE_CALLBACK_TOKEN`, `PALACE_CURRENCY` (`.env.example:59-62`).

## Namespacing scheme (the load-bearing decision)

- **Deployment code:** fixed-width **3 chars**, charset `[a-z0-9]` (e.g. `h00` for the hub's own players, `s01`, `s02` for spokes). Lives in env var `DEPLOYMENT_CODE`.
- **Namespaced account** = `DEPLOYMENT_CODE + account`, concatenated with **no separator** (underscores are rejected by GASea's 3–40 alphanumeric rule; a fixed-width prefix needs no separator to parse).
- `h00` + 32-hex = 35 chars, alphanumeric — within the 40-char limit. Plain usernames must be ≤ 37 chars after prefixing; validated at namespacing time.
- **Parse:** `depCode = first 3 chars`, `account = remainder`.
- The hub injects the prefix from the **authenticated** caller's deployment code, never from caller-supplied data.

## File structure

```
apps/api/src/gateways/hub/                  ← NEW (all hub/spoke machinery)
  deployment-config.ts    role + code + registry resolution from env
  hub-auth.ts             HMAC sign/verify (both directions)
  namespace.ts            namespaceAccount() / parseNamespacedAccount()
  remote-game-provider.gateway.ts   spoke-side GameProviderGateway → forwards to hub
apps/api/src/routes/hub/                     ← NEW (hub-only internal API + spoke callback sink)
  internal-provider.ts    hub: spoke→hub outbound proxy (HMAC-authed)
  spoke-callback.ts       spoke: hub→spoke de-namespaced callback sink (HMAC-authed)
apps/api/src/gateways/game-provider/index.ts   MODIFY: bind remote gateway when role=spoke
apps/api/src/routes/palace/callback.ts          MODIFY: hub routes by account prefix
apps/api/src/index.ts                            MODIFY: register hub routes
apps/api/.env.example                            MODIFY: document new env vars
apps/api/src/test/hub-*.test.ts                  ← NEW tests
```

---

### Task 1: Namespacing helpers

**Files:**
- Create: `apps/api/src/gateways/hub/namespace.ts`
- Test: `apps/api/src/test/hub-namespace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/test/hub-namespace.test.ts
import { describe, it, expect } from 'vitest'
import { namespaceAccount, parseNamespacedAccount, isValidDeploymentCode } from '../gateways/hub/namespace.js'

describe('namespace', () => {
  const code = 's01'
  const acct = 'a'.repeat(32) // 32-hex style

  it('round-trips an account through namespace + parse', () => {
    const ns = namespaceAccount(code, acct)
    expect(ns).toBe('s01' + acct)
    expect(parseNamespacedAccount(ns)).toEqual({ depCode: 's01', account: acct })
  })

  it('rejects an invalid deployment code', () => {
    expect(isValidDeploymentCode('s01')).toBe(true)
    expect(isValidDeploymentCode('S1')).toBe(false)   // wrong length + uppercase
    expect(isValidDeploymentCode('s_1')).toBe(false)  // non-alphanumeric
    expect(() => namespaceAccount('S1', acct)).toThrow(/deployment code/i)
  })

  it('rejects a namespaced account that would exceed 40 chars', () => {
    expect(() => namespaceAccount(code, 'x'.repeat(38))).toThrow(/40/)
  })

  it('throws when parsing a string shorter than the prefix', () => {
    expect(() => parseNamespacedAccount('s0')).toThrow(/too short/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- hub-namespace`
Expected: FAIL — `Cannot find module '../gateways/hub/namespace.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/gateways/hub/namespace.ts
/** Fixed-width deployment code: exactly 3 lowercase-alphanumeric chars. */
export const DEPLOYMENT_CODE_LENGTH = 3
const MAX_ACCOUNT_LENGTH = 40 // GASea: 3–40 alphanumeric username

const CODE_RE = /^[a-z0-9]{3}$/

export function isValidDeploymentCode(code: string): boolean {
  return CODE_RE.test(code)
}

/** Prepend the deployment code to an account. Throws if the result is invalid. */
export function namespaceAccount(depCode: string, account: string): string {
  if (!isValidDeploymentCode(depCode)) {
    throw new Error(`Invalid deployment code: "${depCode}" (must be 3 lowercase alphanumeric chars)`)
  }
  const ns = depCode + account
  if (ns.length > MAX_ACCOUNT_LENGTH) {
    throw new Error(`Namespaced account "${ns}" exceeds ${MAX_ACCOUNT_LENGTH} chars`)
  }
  return ns
}

/** Split a namespaced account into its deployment code and bare account. */
export function parseNamespacedAccount(namespaced: string): { depCode: string; account: string } {
  if (namespaced.length <= DEPLOYMENT_CODE_LENGTH) {
    throw new Error(`Namespaced account "${namespaced}" is too short to contain a deployment code`)
  }
  return {
    depCode: namespaced.slice(0, DEPLOYMENT_CODE_LENGTH),
    account: namespaced.slice(DEPLOYMENT_CODE_LENGTH),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- hub-namespace`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/gateways/hub/namespace.ts apps/api/src/test/hub-namespace.test.ts
git commit -m "feat(hub): account namespacing helpers"
```

---

### Task 2: HMAC request auth (both directions)

**Files:**
- Create: `apps/api/src/gateways/hub/hub-auth.ts`
- Test: `apps/api/src/test/hub-auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/test/hub-auth.test.ts
import { describe, it, expect } from 'vitest'
import { signBody, verifySignature } from '../gateways/hub/hub-auth.js'

describe('hub-auth', () => {
  const secret = 'shared-secret-123'
  const body = JSON.stringify({ providerCode: 'palace', method: 'launch' })

  it('verifies a signature it produced', () => {
    const sig = signBody(secret, body)
    expect(verifySignature(secret, body, sig)).toBe(true)
  })

  it('rejects a tampered body', () => {
    const sig = signBody(secret, body)
    expect(verifySignature(secret, body + 'x', sig)).toBe(false)
  })

  it('rejects a wrong secret', () => {
    const sig = signBody(secret, body)
    expect(verifySignature('other-secret', body, sig)).toBe(false)
  })

  it('rejects a malformed signature without throwing', () => {
    expect(verifySignature(secret, body, 'not-hex')).toBe(false)
    expect(verifySignature(secret, body, '')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- hub-auth`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/gateways/hub/hub-auth.ts
import crypto from 'node:crypto'

/** HMAC-SHA256 hex digest of the raw request body. */
export function signBody(secret: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
}

/** Timing-safe verification. Never throws — returns false on any malformed input. */
export function verifySignature(secret: string, rawBody: string, received: string): boolean {
  const expected = signBody(secret, rawBody)
  // Compare fixed-length hex digests via HMAC-of-input to avoid length leaks / parse errors.
  const key = Buffer.alloc(32)
  const a = crypto.createHmac('sha256', key).update(expected).digest()
  const b = crypto.createHmac('sha256', key).update(received ?? '').digest()
  return crypto.timingSafeEqual(a, b)
}

export const DEPLOYMENT_HEADER = 'x-deployment'
export const SIGNATURE_HEADER = 'x-signature'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- hub-auth`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/gateways/hub/hub-auth.ts apps/api/src/test/hub-auth.test.ts
git commit -m "feat(hub): HMAC body signing + verification"
```

---

### Task 3: Deployment config & registry (env-backed)

**Files:**
- Create: `apps/api/src/gateways/hub/deployment-config.ts`
- Test: `apps/api/src/test/hub-config.test.ts`

Config model:
- `DEPLOYMENT_ROLE` = `standalone` (default) | `hub` | `spoke`
- `DEPLOYMENT_CODE` = this deployment's 3-char code (required unless `standalone`)
- Hub reads `HUB_DEPLOYMENTS` = JSON array `[{ "code":"s01","baseUrl":"https://s01.example","secret":"..." }]` — spokes it serves. The hub's own code is `DEPLOYMENT_CODE`.
- Spoke reads `HUB_URL` and `HUB_SHARED_SECRET`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/test/hub-config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadDeploymentConfig } from '../gateways/hub/deployment-config.js'

const KEYS = ['DEPLOYMENT_ROLE', 'DEPLOYMENT_CODE', 'HUB_DEPLOYMENTS', 'HUB_URL', 'HUB_SHARED_SECRET']
let saved: Record<string, string | undefined>

beforeEach(() => { saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]])); for (const k of KEYS) delete process.env[k] })
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

describe('deployment-config', () => {
  it('defaults to standalone with no env', () => {
    expect(loadDeploymentConfig().role).toBe('standalone')
  })

  it('parses a hub config with a spoke registry', () => {
    process.env.DEPLOYMENT_ROLE = 'hub'
    process.env.DEPLOYMENT_CODE = 'h00'
    process.env.HUB_DEPLOYMENTS = JSON.stringify([{ code: 's01', baseUrl: 'https://s01', secret: 'sec1' }])
    const cfg = loadDeploymentConfig()
    expect(cfg.role).toBe('hub')
    expect(cfg.code).toBe('h00')
    expect(cfg.spokes.get('s01')).toEqual({ code: 's01', baseUrl: 'https://s01', secret: 'sec1' })
  })

  it('parses a spoke config', () => {
    process.env.DEPLOYMENT_ROLE = 'spoke'
    process.env.DEPLOYMENT_CODE = 's01'
    process.env.HUB_URL = 'https://hub'
    process.env.HUB_SHARED_SECRET = 'sec1'
    const cfg = loadDeploymentConfig()
    expect(cfg.role).toBe('spoke')
    expect(cfg.hubUrl).toBe('https://hub')
    expect(cfg.hubSecret).toBe('sec1')
  })

  it('throws when a non-standalone role has an invalid code', () => {
    process.env.DEPLOYMENT_ROLE = 'spoke'
    process.env.DEPLOYMENT_CODE = 'BAD'
    expect(() => loadDeploymentConfig()).toThrow(/DEPLOYMENT_CODE/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- hub-config`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/gateways/hub/deployment-config.ts
import { isValidDeploymentCode } from './namespace.js'

export type DeploymentRole = 'standalone' | 'hub' | 'spoke'

export interface SpokeEntry { code: string; baseUrl: string; secret: string }

export interface DeploymentConfig {
  role: DeploymentRole
  code: string                 // '' when standalone
  spokes: Map<string, SpokeEntry> // hub only
  hubUrl: string               // spoke only
  hubSecret: string            // spoke only
}

export function loadDeploymentConfig(): DeploymentConfig {
  const role = (process.env.DEPLOYMENT_ROLE ?? 'standalone') as DeploymentRole
  if (role === 'standalone') {
    return { role, code: '', spokes: new Map(), hubUrl: '', hubSecret: '' }
  }

  const code = (process.env.DEPLOYMENT_CODE ?? '').trim()
  if (!isValidDeploymentCode(code)) {
    throw new Error(`DEPLOYMENT_CODE "${code}" is invalid (need 3 lowercase alphanumeric chars) for role=${role}`)
  }

  const spokes = new Map<string, SpokeEntry>()
  if (role === 'hub') {
    const raw = process.env.HUB_DEPLOYMENTS ?? '[]'
    let arr: SpokeEntry[]
    try { arr = JSON.parse(raw) } catch { throw new Error('HUB_DEPLOYMENTS is not valid JSON') }
    for (const s of arr) {
      if (!isValidDeploymentCode(s.code) || !s.baseUrl || !s.secret) {
        throw new Error(`HUB_DEPLOYMENTS entry invalid: ${JSON.stringify(s)}`)
      }
      spokes.set(s.code, { code: s.code, baseUrl: s.baseUrl.replace(/\/$/, ''), secret: s.secret })
    }
  }

  const hubUrl = (process.env.HUB_URL ?? '').replace(/\/$/, '')
  const hubSecret = process.env.HUB_SHARED_SECRET ?? ''
  if (role === 'spoke' && (!hubUrl || !hubSecret)) {
    throw new Error('role=spoke requires HUB_URL and HUB_SHARED_SECRET')
  }

  return { role, code, spokes, hubUrl, hubSecret }
}

/** Memoized singleton for app runtime. */
let _cfg: DeploymentConfig | null = null
export function deploymentConfig(): DeploymentConfig {
  if (!_cfg) _cfg = loadDeploymentConfig()
  return _cfg
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- hub-config`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/gateways/hub/deployment-config.ts apps/api/src/test/hub-config.test.ts
git commit -m "feat(hub): env-backed deployment role + spoke registry"
```

---

### Task 4: Hub inbound callback routing (provider → hub → spoke)

Make the existing Palace callback route role-aware. When `role=hub`, parse the deployment prefix from `d.account`: if it is the hub's own code, strip it and handle locally as today; if it belongs to a spoke, strip it and POST the de-namespaced body to that spoke's callback sink (HMAC-signed), then relay the spoke's response verbatim. When `role=standalone`, behaviour is unchanged.

**Files:**
- Create: `apps/api/src/gateways/hub/route-callback.ts` (pure routing decision — easy to test)
- Modify: `apps/api/src/routes/palace/callback.ts`
- Test: `apps/api/src/test/hub-route-callback.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/test/hub-route-callback.test.ts
import { describe, it, expect } from 'vitest'
import { decideCallbackRoute } from '../gateways/hub/route-callback.js'
import type { DeploymentConfig } from '../gateways/hub/deployment-config.js'

const hubCfg: DeploymentConfig = {
  role: 'hub', code: 'h00',
  spokes: new Map([['s01', { code: 's01', baseUrl: 'https://s01', secret: 'sec1' }]]),
  hubUrl: '', hubSecret: '',
}

describe('decideCallbackRoute', () => {
  it('routes the hub\'s own account locally with the prefix stripped', () => {
    const r = decideCallbackRoute(hubCfg, 'h00' + 'a'.repeat(32))
    expect(r).toEqual({ kind: 'local', account: 'a'.repeat(32) })
  })

  it('routes a spoke account to that spoke with the prefix stripped', () => {
    const r = decideCallbackRoute(hubCfg, 's01' + 'b'.repeat(32))
    expect(r).toEqual({ kind: 'forward', account: 'b'.repeat(32), spoke: hubCfg.spokes.get('s01') })
  })

  it('returns unknown for an unregistered deployment code', () => {
    const r = decideCallbackRoute(hubCfg, 'zzz' + 'c'.repeat(32))
    expect(r.kind).toBe('unknown')
  })

  it('standalone always routes locally without stripping', () => {
    const std: DeploymentConfig = { role: 'standalone', code: '', spokes: new Map(), hubUrl: '', hubSecret: '' }
    const r = decideCallbackRoute(std, 'a'.repeat(32))
    expect(r).toEqual({ kind: 'local', account: 'a'.repeat(32) })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- hub-route-callback`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/gateways/hub/route-callback.ts
import type { DeploymentConfig, SpokeEntry } from './deployment-config.js'
import { parseNamespacedAccount } from './namespace.js'

export type CallbackRoute =
  | { kind: 'local'; account: string }
  | { kind: 'forward'; account: string; spoke: SpokeEntry }
  | { kind: 'unknown'; account: string }

/** Pure decision: given the raw provider account, where does this callback go? */
export function decideCallbackRoute(cfg: DeploymentConfig, rawAccount: string): CallbackRoute {
  if (cfg.role !== 'hub') return { kind: 'local', account: rawAccount }

  let depCode: string, account: string
  try { ({ depCode, account } = parseNamespacedAccount(rawAccount)) }
  catch { return { kind: 'unknown', account: rawAccount } }

  if (depCode === cfg.code) return { kind: 'local', account }
  const spoke = cfg.spokes.get(depCode)
  if (spoke) return { kind: 'forward', account, spoke }
  return { kind: 'unknown', account }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- hub-route-callback`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire it into the callback route**

In `apps/api/src/routes/palace/callback.ts`, before `dispatch()` runs, rewrite `d.account` according to the route. Add near the top:

```ts
import { deploymentConfig } from '../../gateways/hub/deployment-config.js'
import { decideCallbackRoute } from '../../gateways/hub/route-callback.js'
import { signBody, DEPLOYMENT_HEADER, SIGNATURE_HEADER } from '../../gateways/hub/hub-auth.js'
```

Inside the handler, immediately after `const { command, data: d = {} } = body`:

```ts
        // Hub routing: an account may belong to another deployment.
        const cfg = deploymentConfig()
        if (cfg.role === 'hub' && typeof d.account === 'string') {
          const route = decideCallbackRoute(cfg, d.account)
          if (route.kind === 'unknown') {
            return respond({ result: 1002, status: 'USER_NOT_FOUND', data: null })
          }
          if (route.kind === 'forward') {
            // Strip the prefix and relay the spoke's verbatim response.
            const forwardBody = JSON.stringify({ command, data: { ...d, account: route.account } })
            const sig = signBody(route.spoke.secret, forwardBody)
            const res = await withTimeout(
              fetch(`${route.spoke.baseUrl}/v1/hub/spoke-callback`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  [DEPLOYMENT_HEADER]: cfg.code,
                  [SIGNATURE_HEADER]: sig,
                },
                body: forwardBody,
              }),
              HANDLER_TIMEOUT_MS,
            )
            if (!res.ok) {
              // Non-200 to the provider → it retries. Never fabricate success.
              return reply.status(200).send({ result: 1001, status: 'INTERNAL_SERVER_ERROR', data: null })
            }
            return respond(await res.json() as { result: number; status: string; data: object | null })
          }
          // route.kind === 'local' → continue with the stripped account.
          d.account = route.account
        }
```

(Standalone deployments skip this block entirely; their behaviour is unchanged.)

- [ ] **Step 6: Run the existing Palace tests to confirm no regression**

Run: `pnpm --filter @world-bingo/api test -- palace`
Expected: PASS — existing `palace-gateway`/`palace-wallet` suites still green (standalone default).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/gateways/hub/route-callback.ts apps/api/src/routes/palace/callback.ts apps/api/src/test/hub-route-callback.test.ts
git commit -m "feat(hub): route provider callbacks to the owning deployment"
```

---

### Task 5: Spoke callback sink (hub → spoke)

The spoke exposes `/v1/hub/spoke-callback`. It verifies the hub's HMAC, then hands the de-namespaced `{ command, data }` to the **same** `PalaceWalletService` dispatch the public callback uses, returning the provider-format response.

**Files:**
- Create: `apps/api/src/routes/hub/spoke-callback.ts`
- Modify: `apps/api/src/index.ts` (register, spoke only)
- Test: `apps/api/src/test/hub-spoke-callback.test.ts` (integration via `fastify.inject`)

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/test/hub-spoke-callback.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { signBody } from '../gateways/hub/hub-auth.js'

vi.mock('../services/palace-wallet.service.js', () => ({
  PalaceWalletService: {
    getBalance: vi.fn(async (account: string) => ({ result: 1, status: 'OK', data: { account, balance: 12.5 } })),
  },
}))

const SECRET = 'sec1'
beforeEach(() => {
  process.env.DEPLOYMENT_ROLE = 'spoke'
  process.env.DEPLOYMENT_CODE = 's01'
  process.env.HUB_URL = 'https://hub'
  process.env.HUB_SHARED_SECRET = SECRET
})

async function buildApp() {
  const app = Fastify()
  const { spokeCallbackRoute } = await import('../routes/hub/spoke-callback.js')
  await app.register(spokeCallbackRoute, { prefix: '/v1/hub/spoke-callback' })
  return app
}

describe('spoke-callback sink', () => {
  it('accepts a correctly signed balance callback', async () => {
    const app = await buildApp()
    const body = JSON.stringify({ command: 'balance', data: { account: 'a'.repeat(32) } })
    const res = await app.inject({
      method: 'POST', url: '/v1/hub/spoke-callback',
      headers: { 'content-type': 'application/json', 'x-deployment': 'h00', 'x-signature': signBody(SECRET, body) },
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ result: 1, status: 'OK' })
  })

  it('rejects a bad signature with 401', async () => {
    const app = await buildApp()
    const body = JSON.stringify({ command: 'balance', data: { account: 'a'.repeat(32) } })
    const res = await app.inject({
      method: 'POST', url: '/v1/hub/spoke-callback',
      headers: { 'content-type': 'application/json', 'x-deployment': 'h00', 'x-signature': 'deadbeef' },
      payload: body,
    })
    expect(res.statusCode).toBe(401)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- hub-spoke-callback`
Expected: FAIL — `Cannot find module '../routes/hub/spoke-callback.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/routes/hub/spoke-callback.ts
import type { FastifyPluginAsync } from 'fastify'
import { PalaceWalletService } from '../../services/palace-wallet.service.js'
import { deploymentConfig } from '../../gateways/hub/deployment-config.js'
import { verifySignature, DEPLOYMENT_HEADER, SIGNATURE_HEADER } from '../../gateways/hub/hub-auth.js'

type PalaceResponse = { result: number; status: string; data: object | null }

/**
 * Spoke-side sink for hub-forwarded provider callbacks. The account is already
 * de-namespaced by the hub. Authenticated by the hub's HMAC over the raw body.
 */
export const spokeCallbackRoute: FastifyPluginAsync = async (fastify) => {
  // Capture the raw body so the HMAC matches byte-for-byte what the hub signed.
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, { __raw: body as string, ...JSON.parse(body as string) }) }
    catch (e) { done(e as Error, undefined) }
  })

  fastify.post('/', async (req, reply) => {
    const cfg = deploymentConfig()
    const raw = (req.body as any)?.__raw ?? ''
    const sig = req.headers[SIGNATURE_HEADER] as string | undefined
    const dep = req.headers[DEPLOYMENT_HEADER] as string | undefined

    if (!sig || !dep || !verifySignature(cfg.hubSecret, raw, sig)) {
      return reply.status(401).send({ result: 1009, status: 'TOKEN_INVALID', data: null })
    }

    const { command, data: d = {} } = req.body as { command?: string; data?: Record<string, any> }
    const dispatch = (): Promise<PalaceResponse> => {
      switch (command) {
        case 'authenticate': return PalaceWalletService.authenticate(d.account)
        case 'balance': return PalaceWalletService.getBalance(d.account)
        case 'bet': return PalaceWalletService.processBet({ trans_guid: d.trans_guid, account: d.account, gplay_id: d.gplay_id, round_id: d.round_id, game_code: d.game_code, amount: d.amount })
        case 'win': return PalaceWalletService.processWin({ trans_guid: d.trans_guid, account: d.account, gplay_id: d.gplay_id, round_id: d.round_id, game_code: d.game_code, amount: d.amount, type: d.type ?? 2 })
        case 'cancel': return PalaceWalletService.processCancel({ trans_guid: d.trans_guid, account: d.account, gplay_id: d.gplay_id, round_id: d.round_id, game_code: d.game_code, amount: d.amount ?? 0, cancle_trans_guid: d.cancel_trans_guid ?? d.cancle_trans_guid })
        case 'status': return PalaceWalletService.getStatus(d.account, d.trans_guid ?? d.trans_id ?? '')
        default: return Promise.resolve({ result: 1006, status: 'COMMAND_NOT_FOUND', data: null })
      }
    }
    return reply.status(200).send(await dispatch())
  })
}
```

> **NOTE (DRY follow-up):** the `dispatch` switch is now duplicated between `routes/palace/callback.ts` and this file. After Task 5 is green, extract it into `services/palace-wallet.service.ts` as `PalaceWalletService.dispatch(command, data)` and call it from both. Do this as Step 6 below so the refactor is covered by both suites.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- hub-spoke-callback`
Expected: PASS (2 tests).

- [ ] **Step 5: Register the route (spoke only)**

In `apps/api/src/index.ts`, near the other `server.register(...)` calls (after line 237), add:

```ts
// Hub/spoke wiring
import { deploymentConfig } from './gateways/hub/deployment-config.js'
import { spokeCallbackRoute } from './routes/hub/spoke-callback.js'
import { internalProviderRoute } from './routes/hub/internal-provider.js' // added in Task 6
// ...
const _dep = deploymentConfig()
if (_dep.role === 'spoke') {
  await server.register(spokeCallbackRoute, { prefix: '/v1/hub/spoke-callback' })
}
if (_dep.role === 'hub') {
  await server.register(internalProviderRoute, { prefix: '/v1/hub/provider' })
}
```

(Imports go to the top with the other imports; the `if` blocks go beside the existing registrations.)

- [ ] **Step 6: Extract the shared dispatch (DRY) and re-run both suites**

Add `static dispatch(command, data)` to `PalaceWalletService` containing the switch, replace both call sites with `PalaceWalletService.dispatch(command, d)`, then:

Run: `pnpm --filter @world-bingo/api test -- palace hub-spoke-callback`
Expected: PASS — both suites still green.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/hub/spoke-callback.ts apps/api/src/index.ts apps/api/src/services/palace-wallet.service.ts apps/api/src/routes/palace/callback.ts apps/api/src/test/hub-spoke-callback.test.ts
git commit -m "feat(hub): spoke callback sink + shared dispatch"
```

---

### Task 6: Hub internal provider API (spoke outbound → hub → provider)

The hub exposes `/v1/hub/provider` for spokes. It verifies the spoke's HMAC, derives the **authenticated** deployment code from the verified `X-Deployment` header, namespaces the account for user-scoped methods (`getGameUrl`, `terminateSession`), proxies all `GameProviderGateway` methods to the real gateway, and returns the result.

**Files:**
- Create: `apps/api/src/routes/hub/internal-provider.ts`
- Test: `apps/api/src/test/hub-internal-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/test/hub-internal-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { signBody } from '../gateways/hub/hub-auth.js'

const getGameUrl = vi.fn(async (p: any) => ({ gameUrl: 'https://play/' + p.username, token: 'tok' }))
vi.mock('../gateways/game-provider/index.js', () => ({
  getGameProviderGateway: () => ({ providerCode: 'palace', getGameUrl, terminateSession: vi.fn() }),
}))

const SECRET = 'sec1'
beforeEach(() => {
  process.env.DEPLOYMENT_ROLE = 'hub'
  process.env.DEPLOYMENT_CODE = 'h00'
  process.env.HUB_DEPLOYMENTS = JSON.stringify([{ code: 's01', baseUrl: 'https://s01', secret: SECRET }])
  getGameUrl.mockClear()
})

async function buildApp() {
  const app = Fastify()
  const { internalProviderRoute } = await import('../routes/hub/internal-provider.js')
  await app.register(internalProviderRoute, { prefix: '/v1/hub/provider' })
  return app
}

describe('internal provider API', () => {
  it('namespaces the account for a launch from s01', async () => {
    const app = await buildApp()
    const body = JSON.stringify({ providerCode: 'palace', method: 'getGameUrl', params: { username: 'a'.repeat(32), gameCode: 'g', language: 'en', platform: 'WEB', currency: 'ETB', lobbyUrl: 'https://l/', ipAddress: '1.1.1.1' } })
    const res = await app.inject({
      method: 'POST', url: '/v1/hub/provider',
      headers: { 'content-type': 'application/json', 'x-deployment': 's01', 'x-signature': signBody(SECRET, body) },
      payload: body,
    })
    expect(res.statusCode).toBe(200)
    // Hub prepended s01 to the username before calling the real gateway.
    expect(getGameUrl).toHaveBeenCalledWith(expect.objectContaining({ username: 's01' + 'a'.repeat(32) }))
  })

  it('rejects an unknown / unsigned deployment with 401', async () => {
    const app = await buildApp()
    const body = JSON.stringify({ providerCode: 'palace', method: 'getGameUrl', params: {} })
    const res = await app.inject({
      method: 'POST', url: '/v1/hub/provider',
      headers: { 'content-type': 'application/json', 'x-deployment': 's01', 'x-signature': 'bad' },
      payload: body,
    })
    expect(res.statusCode).toBe(401)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- hub-internal-provider`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/routes/hub/internal-provider.ts
import type { FastifyPluginAsync } from 'fastify'
import { getGameProviderGateway } from '../../gateways/game-provider/index.js'
import { deploymentConfig } from '../../gateways/hub/deployment-config.js'
import { verifySignature, DEPLOYMENT_HEADER, SIGNATURE_HEADER } from '../../gateways/hub/hub-auth.js'
import { namespaceAccount } from '../../gateways/hub/namespace.js'

/** Methods whose first user identity must be namespaced with the caller's code. */
const USER_SCOPED: Record<string, true> = { getGameUrl: true, terminateSession: true }

export const internalProviderRoute: FastifyPluginAsync = async (fastify) => {
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, { __raw: body as string, ...JSON.parse(body as string) }) }
    catch (e) { done(e as Error, undefined) }
  })

  fastify.post('/', async (req, reply) => {
    const cfg = deploymentConfig()
    const raw = (req.body as any)?.__raw ?? ''
    const dep = req.headers[DEPLOYMENT_HEADER] as string | undefined
    const sig = req.headers[SIGNATURE_HEADER] as string | undefined
    const spoke = dep ? cfg.spokes.get(dep) : undefined

    if (!spoke || !sig || !verifySignature(spoke.secret, raw, sig)) {
      return reply.status(401).send({ error: 'unauthorized' })
    }

    const { providerCode, method, params } = req.body as { providerCode: string; method: string; params: any }
    const gateway = getGameProviderGateway(providerCode) as any
    if (typeof gateway[method] !== 'function') {
      return reply.status(400).send({ error: `unknown method ${method}` })
    }

    // Namespace the user identity using the AUTHENTICATED deployment code.
    const p = { ...params }
    if (USER_SCOPED[method]) {
      if (method === 'getGameUrl') p.username = namespaceAccount(dep!, params.username)
      if (method === 'terminateSession') p.username = namespaceAccount(dep!, params.username)
    }

    const args = method === 'getGameUrl' || method === 'terminateSession' ? [p] : (params?.args ?? [])
    try {
      const result = await gateway[method](...(method === 'getGameUrl' || method === 'terminateSession' ? [p] : args))
      return reply.status(200).send({ ok: true, result })
    } catch (err: any) {
      return reply.status(200).send({ ok: false, error: { message: err?.message, code: err?.code, palaceCode: err?.palaceCode } })
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- hub-internal-provider`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/hub/internal-provider.ts apps/api/src/test/hub-internal-provider.test.ts
git commit -m "feat(hub): internal provider API with authenticated namespacing"
```

---

### Task 7: Spoke remote gateway + role-based binding

A spoke binds a `RemoteGameProviderGateway` that implements `GameProviderGateway` by forwarding each method to the hub's internal API. Catalog methods proxy straight through; user-scoped methods send the bare username (the hub namespaces it). The registry binds it only when `role=spoke`.

**Files:**
- Create: `apps/api/src/gateways/hub/remote-game-provider.gateway.ts`
- Modify: `apps/api/src/gateways/game-provider/index.ts`
- Test: `apps/api/src/test/hub-remote-gateway.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/test/hub-remote-gateway.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, result: { gameUrl: 'https://play', token: 't' } }) }))
vi.stubGlobal('fetch', fetchMock)

beforeEach(() => {
  process.env.DEPLOYMENT_ROLE = 'spoke'
  process.env.DEPLOYMENT_CODE = 's01'
  process.env.HUB_URL = 'https://hub'
  process.env.HUB_SHARED_SECRET = 'sec1'
  fetchMock.mockClear()
})

describe('RemoteGameProviderGateway', () => {
  it('forwards getGameUrl to the hub with an HMAC header', async () => {
    const { RemoteGameProviderGateway } = await import('../gateways/hub/remote-game-provider.gateway.js')
    const gw = new RemoteGameProviderGateway('palace')
    const out = await gw.getGameUrl({ username: 'a'.repeat(32), gameCode: 'g', language: 'en', platform: 'WEB', currency: 'ETB', lobbyUrl: 'https://l/', ipAddress: '1.1.1.1' })
    expect(out).toEqual({ gameUrl: 'https://play', token: 't' })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://hub/v1/hub/provider')
    expect((opts as any).headers['x-deployment']).toBe('s01')
    expect((opts as any).headers['x-signature']).toMatch(/^[0-9a-f]{64}$/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- hub-remote-gateway`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/gateways/hub/remote-game-provider.gateway.ts
import type {
  GameProviderGateway, GameListResult, LaunchGameParams,
  TransactionDetail, TransactionListResult, Vendor,
} from '../game-provider/game-provider.interface.js'
import { deploymentConfig } from './deployment-config.js'
import { signBody, DEPLOYMENT_HEADER, SIGNATURE_HEADER } from './hub-auth.js'

/** Spoke-side gateway: forwards every call to the hub's internal provider API. */
export class RemoteGameProviderGateway implements GameProviderGateway {
  constructor(readonly providerCode: string) {}

  private async call<T>(method: string, params: unknown): Promise<T> {
    const cfg = deploymentConfig()
    const body = JSON.stringify({ providerCode: this.providerCode, method, params })
    const res = await fetch(`${cfg.hubUrl}/v1/hub/provider`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [DEPLOYMENT_HEADER]: cfg.code,
        [SIGNATURE_HEADER]: signBody(cfg.hubSecret, body),
      },
      body,
    })
    if (!res.ok) throw new Error(`hub provider call failed: HTTP ${res.status}`)
    const json = await res.json() as { ok: boolean; result?: T; error?: { message: string; code?: string; palaceCode?: number } }
    if (!json.ok) { const e: any = new Error(json.error?.message ?? 'hub provider error'); e.code = json.error?.code; e.palaceCode = json.error?.palaceCode; throw e }
    return json.result as T
  }

  getVendors(currency: string, language: string) { return this.call<Vendor[]>('getVendors', { args: [currency, language] }) }
  getGames(vendorCode: string, page: number, pageSize: number, currency: string, language: string) { return this.call<GameListResult>('getGames', { args: [vendorCode, page, pageSize, currency, language] }) }
  getGameUrl(params: LaunchGameParams) { return this.call<{ gameUrl: string; token: string }>('getGameUrl', params) }
  terminateSession(username: string) { return this.call<void>('terminateSession', { username }) }
  getTransactions(fromTime: number, toTime: number, page: number) { return this.call<TransactionListResult>('getTransactions', { args: [fromTime, toTime, page] }) }
  getTransactionDetail(betId: string, fromTime: number, toTime: number) { return this.call<TransactionDetail>('getTransactionDetail', { args: [betId, fromTime, toTime] }) }
}
```

> The hub's `internal-provider.ts` already handles two shapes: user-scoped methods receive `params` as the param object; catalog methods receive `params.args` as a positional array. Confirm `getGames`/`getVendors` paths in Task 6's handler spread `params.args` (they do via the `args` branch).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- hub-remote-gateway`
Expected: PASS (1 test).

- [ ] **Step 5: Bind by role in the registry**

In `apps/api/src/gateways/game-provider/index.ts`, replace the built-in registration block at the bottom with:

```ts
import { deploymentConfig } from '../hub/deployment-config.js'
import { RemoteGameProviderGateway } from '../hub/remote-game-provider.gateway.js'

// Register providers based on deployment role.
if (deploymentConfig().role === 'spoke') {
  // Spokes have no provider credentials — every call is forwarded to the hub.
  registerGameProviderGateway(new RemoteGameProviderGateway('palace'))
  registerGameProviderGateway(new RemoteGameProviderGateway('gasea'))
} else {
  // standalone + hub talk to providers directly.
  registerGameProviderGateway(new GaseaGateway())
  registerGameProviderGateway(new PalaceGateway())
}
```

- [ ] **Step 6: Run the full provider + hub suites**

Run: `pnpm --filter @world-bingo/api test -- palace gasea hub`
Expected: PASS — no regressions across provider and hub suites.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/gateways/hub/remote-game-provider.gateway.ts apps/api/src/gateways/game-provider/index.ts apps/api/src/test/hub-remote-gateway.test.ts
git commit -m "feat(hub): spoke remote game-provider gateway + role binding"
```

---

### Task 8: Outbound launch namespacing parity for the hub's own players

When `role=hub`, the hub's own launches must also be namespaced (so its callbacks carry `h00…` and route locally). The cleanest place is the launch handler: namespace the username with the hub's own code before calling the gateway. Spokes already get namespaced at the hub; standalone stays bare.

**Files:**
- Modify: `apps/api/src/routes/game-provider/index.ts` (around line 117-123)
- Test: `apps/api/src/test/hub-launch-namespacing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/test/hub-launch-namespacing.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { accountForLaunch } from '../routes/game-provider/account-for-launch.js'

describe('accountForLaunch', () => {
  const uuidHex = 'a'.repeat(32)

  it('standalone returns the bare hex account', () => {
    process.env.DEPLOYMENT_ROLE = 'standalone'
    expect(accountForLaunch(uuidHex)).toBe(uuidHex)
  })

  it('hub prepends its own deployment code', () => {
    process.env.DEPLOYMENT_ROLE = 'hub'; process.env.DEPLOYMENT_CODE = 'h00'
    expect(accountForLaunch(uuidHex)).toBe('h00' + uuidHex)
  })

  it('spoke leaves it bare — the hub namespaces it', () => {
    process.env.DEPLOYMENT_ROLE = 'spoke'; process.env.DEPLOYMENT_CODE = 's01'
    process.env.HUB_URL = 'https://hub'; process.env.HUB_SHARED_SECRET = 'x'
    expect(accountForLaunch(uuidHex)).toBe(uuidHex)
  })
})
```

(Reset the memoized config between cases by importing a `__resetDeploymentConfig` test helper — add one to `deployment-config.ts` that sets `_cfg = null`, exported under an `if (process.env.NODE_ENV === 'test')`-free named export `resetDeploymentConfigForTests`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @world-bingo/api test -- hub-launch-namespacing`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/routes/game-provider/account-for-launch.ts
import { loadDeploymentConfig } from '../../gateways/hub/deployment-config.js'
import { namespaceAccount } from '../../gateways/hub/namespace.js'

/**
 * The account string sent upstream at launch.
 * - hub: prefixed with the hub's own code so its callbacks route locally.
 * - spoke: bare — the hub injects the spoke's code from the authenticated header.
 * - standalone: bare (unchanged behaviour).
 */
export function accountForLaunch(bareAccount: string): string {
  const cfg = loadDeploymentConfig() // read fresh: role is process-stable in prod
  return cfg.role === 'hub' ? namespaceAccount(cfg.code, bareAccount) : bareAccount
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @world-bingo/api test -- hub-launch-namespacing`
Expected: PASS (3 tests).

- [ ] **Step 5: Use it in the launch handler**

In `apps/api/src/routes/game-provider/index.ts`, replace line 117:

```ts
            const gaseaUsername = user.id.replace(/-/g, '')
```

with:

```ts
            const bareAccount = user.id.replace(/-/g, '')
            const gaseaUsername = accountForLaunch(bareAccount)
```

and add the import at the top:

```ts
import { accountForLaunch } from './account-for-launch.js'
```

- [ ] **Step 6: Run the provider route + hub suites**

Run: `pnpm --filter @world-bingo/api test -- game-provider hub`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/game-provider/account-for-launch.ts apps/api/src/routes/game-provider/index.ts apps/api/src/test/hub-launch-namespacing.test.ts
git commit -m "feat(hub): namespace the hub's own launches for local callback routing"
```

---

### Task 9: Docs + env example + full typecheck

**Files:**
- Modify: `apps/api/.env.example`
- Modify: `CLAUDE.md` (Environment Setup section — note the hub/spoke vars)

- [ ] **Step 1: Document the new env vars**

Append to `apps/api/.env.example` after line 62:

```bash
# ── Provider gateway hub ─────────────────────────────────────────────
# Role of this deployment in the shared-provider topology.
DEPLOYMENT_ROLE=standalone          # standalone | hub | spoke
DEPLOYMENT_CODE=                     # 3 lowercase-alphanumeric chars (required unless standalone)
# Hub only: JSON array of the spokes this hub serves.
HUB_DEPLOYMENTS=                     # [{"code":"s01","baseUrl":"https://s01.example","secret":"<shared>"}]
# Spoke only: where the hub lives + the shared secret it authenticates with.
HUB_URL=
HUB_SHARED_SECRET=
```

- [ ] **Step 2: Note it in CLAUDE.md**

Add to the "Environment Setup" section a sentence: "For shared-provider multi-deployment setups, set `DEPLOYMENT_ROLE`/`DEPLOYMENT_CODE` and the hub/spoke vars — see `apps/api/.env.example`. The hub owns the provider token + callback URL; spokes forward through it."

- [ ] **Step 3: Full typecheck + test**

Run: `pnpm --filter @world-bingo/api typecheck && pnpm --filter @world-bingo/api test`
Expected: PASS — no type errors, all suites green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/.env.example CLAUDE.md
git commit -m "docs(hub): document deployment-role env vars"
```

---

## Self-review notes

- **Spec coverage:** §"routing key" → Tasks 1,4,8; §"namespacing rules" → Tasks 1,6,8; §"outbound path" → Tasks 6,7; §"inbound path" → Tasks 4,5; §"registry & auth" → Tasks 2,3,6; §"failure modes" → Task 4 (non-200 on spoke-down / forward fail) + Task 6 (errors returned, not thrown); §"code structure" → matches file layout; §"testing" → each task is TDD, plus regression runs in Tasks 4,7,8.
- **Deferred from spec (intentional, YAGNI for v1):** the generic provider-agnostic `router.ts`/`payment.router.ts` abstraction. This plan ships the Palace vertical slice with the namespacing concentrated in `account-for-launch.ts` + `route-callback.ts` + `internal-provider.ts`. The payment-provider adapter and the generic router are a **follow-up plan** once this slice is proven in production. Flagged here so it is not silently dropped.
- **SPOF/idempotency:** retries are safe because `thirdPartyTransaction` has a unique key (existing); the hub returns non-200 on any forward failure so the provider retries.
- **Type consistency:** `namespaceAccount`/`parseNamespacedAccount`, `signBody`/`verifySignature`, `deploymentConfig()`/`loadDeploymentConfig()`, `decideCallbackRoute`, `DEPLOYMENT_HEADER`/`SIGNATURE_HEADER`, `accountForLaunch`, `RemoteGameProviderGateway` are referenced consistently across tasks.
