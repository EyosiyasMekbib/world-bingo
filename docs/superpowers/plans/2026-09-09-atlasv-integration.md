# Atlas-V Provider Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Atlas-V as a new third-party game provider (game code `penalty`) — outbound launch, inbound wallet callbacks (account/bet/betwin/result/rollback/freespin/jackpot), admin freespin-granting — reusing the existing `GameProviderGateway` + wallet-callback pattern already proven by Palace and GASea.

**Architecture:** One outbound gateway (`AtlasVGateway`) calls Atlas-V's `/init` (launch) and `/freespin` (grant) endpoints. Six inbound Fastify routes under `/v1/atlasv/callback/*` (one URL per action, per Atlas-V's spec — unlike Palace's single dispatch-by-command endpoint) verify a per-request `sha1(body+key+timestamp)` signature and delegate to `AtlasVWalletService`, which does the actual `SELECT FOR UPDATE` wallet debit/credit + `ThirdPartyTransaction`/`Transaction` ledger writes, mirroring `PalaceWalletService` closely. Hub/spoke forwarding reuses the existing `decideCallbackRoute` mechanism with a new Atlas-V-specific spoke sink, since the callback body shape (`{action, data}`, keyed on `player_id`) differs from Palace's (`{command, data}`, keyed on `account`).

**Tech Stack:** Fastify v5, Prisma 5 + PostgreSQL, Vitest, TypeScript (ESM, `.js` import extensions).

**Full design context:** [docs/superpowers/specs/2026-09-09-atlasv-integration-design.md](../specs/2026-09-09-atlasv-integration-design.md)

## Global Constraints

- All Atlas-V HTTP requests (in and out) use `Content-Type: text/javascript`, per the Atlas-V API doc header.
- Every request body (both directions) carries `timestamp` (string, ms epoch) and `hash` = `sha1(JSON_body_without_hash + PRIVATE_KEY + timestamp)`.
- Every inbound callback response is HTTP 200, even on failure — Atlas-V is assumed to retry on non-200, same as Palace/GASea. Failure body shape is `{ success: false }` (inferred; not documented — see design doc Risk #3).
- No frontend changes — confirmed the `/providers/*` lobby/search/launch UI is 100% generic on `providerCode`/`gameCode`.
- No new DB migration — reuses `GameProvider`, `GameVendor`, `ProviderGame`, `ProviderUserAccount`, `ThirdPartyTransaction` as-is.
- All new/modified source files use `.js` import extensions (ESM), matching every existing file in `apps/api/src`.
- Reuses the existing UUID-hex `player_id` convention (`user.id.replace(/-/g,'')`, `accountForLaunch()`) already used by Palace/GASea — no new account-mapping table.
- Env vars are added only to `apps/api/.env.example` (root `.env.example` doesn't carry Palace's vars either — matching existing precedent, not introducing a new inconsistency).

---

### Task 1: DB seed + env vars

**Files:**
- Modify: `apps/api/prisma/seed.ts:191` (insert after the Palace provider block, before `// 7. Seed default payment methods`)
- Modify: `apps/api/.env.example:71` (insert after the `PALACE_CURRENCY=ETB` line, before the `# ── Provider gateway hub` section)

**Interfaces:**
- Produces: a `GameProvider` row (`code: 'atlasv'`) with `config: { catalogSync: false }` — this flag is read by `GameCatalogService.syncAll` in Task 3. A `GameVendor` row (`code: 'atlasv-default'`) and one `ProviderGame` row (`gameCode: 'penalty'`) that the existing generic `/providers/*` lobby/search endpoints will serve unchanged.

- [ ] **Step 1: Add the Atlas-V env vars**

Insert into `apps/api/.env.example` right after line 71 (`PALACE_CURRENCY=ETB`):

```
# --- Atlas-V (mini-games provider, e.g. "penalty") ---
ATLASV_SERVER_URL=          # base URL for /init (casino -> game server)
ATLASV_GAME_SERVER_URL=     # base URL for /freespin creation (may be the same host)
ATLASV_PRIVATE_KEY=
ATLASV_CASINO_ID=
ATLASV_PARTNER_ID=1
ATLASV_DEFAULT_CURRENCY=ETB
ATLASV_DEFAULT_LANGUAGE=en
ATLASV_CALLBACK_DEBUG=false
ATLASV_MAX_WIN_AMOUNT=1000000
ATLASV_MAX_WIN_MULTIPLE=20000
ATLASV_SPOKE_TIMEOUT_MS=5000
```

- [ ] **Step 2: Add the seed rows**

Insert into `apps/api/prisma/seed.ts` right after line 191 (`console.log('Palace Casino provider seeded')`), before the `// 7. Seed default payment methods` comment:

```ts
    // 6c. Seed Atlas-V game provider (static catalog — no listing API in their
    // spec, see docs/superpowers/specs/2026-09-09-atlasv-integration-design.md)
    console.log('Seeding Atlas-V provider...')
    const atlasv = await prisma.gameProvider.upsert({
        where: { code: 'atlasv' },
        update: {},  // don't overwrite status if admin changed it
        create: {
            code: 'atlasv',
            name: 'Atlas-V',
            status: 'ACTIVE',
            isPrimary: false,
            apiBaseUrl: process.env.ATLASV_SERVER_URL ?? '',
            currency: process.env.ATLASV_DEFAULT_CURRENCY ?? 'ETB',
            config: { catalogSync: false },
        },
    })
    const atlasvVendor = await prisma.gameVendor.upsert({
        where: { providerId_code: { providerId: atlasv.id, code: 'atlasv-default' } },
        update: {},
        create: {
            providerId: atlasv.id,
            code: 'atlasv-default',
            name: 'Atlas-V',
            categoryCode: 'ARCADE',
            isActive: true,
        },
    })
    await prisma.providerGame.upsert({
        where: { providerId_gameCode: { providerId: atlasv.id, gameCode: 'penalty' } },
        update: {},
        create: {
            providerId: atlasv.id,
            vendorId: atlasvVendor.id,
            gameCode: 'penalty',
            gameName: 'Penalty Shootout',
            categoryCode: 'ARCADE',
            languageCodes: ['en', 'am'],
            platformCodes: ['WEB', 'H5'],
            currencyCodes: [process.env.ATLASV_DEFAULT_CURRENCY ?? 'ETB'],
            isActive: true,
        },
    })
    console.log('Atlas-V provider seeded')

```

- [ ] **Step 3: Typecheck and run the seed against the local dev DB**

Run: `pnpm infra:up` (if not already running), then from `apps/api/`: `pnpm exec tsc --noEmit && pnpm db:seed`
Expected: no type errors; seed output includes `Atlas-V provider seeded`; re-running is idempotent (no errors on a second run).

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/seed.ts apps/api/.env.example
git commit -m "feat(api): seed Atlas-V game provider"
```

---

### Task 2: Signature helper (sign outbound, verify inbound)

**Files:**
- Create: `apps/api/src/gateways/game-provider/atlasv-signature.ts`
- Test: `apps/api/src/test/atlasv-signature.test.ts`

**Interfaces:**
- Produces: `signAtlasVBody<T extends Record<string, unknown>>(body: T): T & { timestamp: string; hash: string }` and `verifyAtlasVBody(body: Record<string, unknown>): boolean` — consumed by `AtlasVGateway` (Task 3) for outbound requests and the callback route helper (Task 6) for inbound verification.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/test/atlasv-signature.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('Atlas-V signature', () => {
    beforeEach(() => {
        process.env.ATLASV_PRIVATE_KEY = 'test-private-key'
    })

    it('signs a body and verifies it round-trips', async () => {
        const { signAtlasVBody, verifyAtlasVBody } = await import('../gateways/game-provider/atlasv-signature.js')
        const signed = signAtlasVBody({ game: 'penalty', casino_id: 'c1', player_id: 'p1', amount: 100 })
        expect(signed.hash).toMatch(/^[0-9a-f]{40}$/)
        expect(verifyAtlasVBody(signed)).toBe(true)
    })

    it('rejects a tampered field', async () => {
        const { signAtlasVBody, verifyAtlasVBody } = await import('../gateways/game-provider/atlasv-signature.js')
        const signed = signAtlasVBody({ game: 'penalty', casino_id: 'c1', player_id: 'p1', amount: 100 })
        expect(verifyAtlasVBody({ ...signed, amount: 999 })).toBe(false)
    })

    it('rejects a body with no hash field', async () => {
        const { verifyAtlasVBody } = await import('../gateways/game-provider/atlasv-signature.js')
        expect(verifyAtlasVBody({ game: 'penalty', player_id: 'p1', timestamp: String(Date.now()) })).toBe(false)
    })

    it('rejects when ATLASV_PRIVATE_KEY is unset', async () => {
        vi.resetModules()
        const prevKey = process.env.ATLASV_PRIVATE_KEY
        delete process.env.ATLASV_PRIVATE_KEY
        const { signAtlasVBody, verifyAtlasVBody } = await import('../gateways/game-provider/atlasv-signature.js')
        const signed = signAtlasVBody({ game: 'penalty', player_id: 'p1' })
        expect(verifyAtlasVBody(signed)).toBe(false)
        process.env.ATLASV_PRIVATE_KEY = prevKey
        vi.resetModules()
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `apps/api/`): `pnpm vitest run src/test/atlasv-signature.test.ts`
Expected: FAIL — `Cannot find module '../gateways/game-provider/atlasv-signature.js'`

- [ ] **Step 3: Implement the signature helper**

Create `apps/api/src/gateways/game-provider/atlasv-signature.ts`:

```ts
import crypto from 'node:crypto'

let _key: string | null = null
function getPrivateKey(): string {
    if (!_key) {
        const k = (process.env.ATLASV_PRIVATE_KEY ?? '').trim()
        if (!k) console.warn('[Atlas-V] WARNING: ATLASV_PRIVATE_KEY is empty — all signature checks will fail')
        else _key = k
        return k
    }
    return _key
}

export function sha1Hex(input: string): string {
    return crypto.createHash('sha1').update(input).digest('hex')
}

/** Attaches `timestamp` and `hash` to an outbound Atlas-V request body. */
export function signAtlasVBody<T extends Record<string, unknown>>(
    body: T,
): T & { timestamp: string; hash: string } {
    const timestamp = String(Date.now())
    const withTimestamp = { ...body, timestamp }
    const hash = sha1Hex(JSON.stringify(withTimestamp) + getPrivateKey() + timestamp)
    return { ...withTimestamp, hash }
}

/**
 * Verifies an inbound Atlas-V callback body (the parsed JSON, still
 * containing `hash`). Per the Atlas-V API doc: hash = sha1(REQUEST_BODY +
 * PRIVATE_KEY + timestamp). REQUEST_BODY is assumed to be the JSON body with
 * `hash` itself removed, in the same key order Atlas-V sent it (preserved by
 * JSON.parse → destructure → JSON.stringify round-tripping). This is a
 * documented assumption, not a confirmed fact — see the design doc's
 * "Signature (inbound)" row and Risk #1.
 */
export function verifyAtlasVBody(body: Record<string, unknown>): boolean {
    const privateKey = getPrivateKey()
    if (!privateKey) return false
    const { hash, ...rest } = body
    const timestamp = rest.timestamp
    if (typeof hash !== 'string' || typeof timestamp !== 'string') return false
    const expected = sha1Hex(JSON.stringify(rest) + privateKey + timestamp)
    if (hash.length !== expected.length) return false
    return crypto.timingSafeEqual(Buffer.from(hash, 'utf8'), Buffer.from(expected, 'utf8'))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/test/atlasv-signature.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/gateways/game-provider/atlasv-signature.ts apps/api/src/test/atlasv-signature.test.ts
git commit -m "feat(api): Atlas-V request signing and callback verification"
```

---

### Task 3: `AtlasVGateway` (outbound) + registry wiring + catalog-sync skip

**Files:**
- Create: `apps/api/src/gateways/game-provider/atlasv.gateway.ts`
- Modify: `apps/api/src/gateways/game-provider/index.ts`
- Modify: `apps/api/src/services/game-catalog.service.ts` (the `syncAll` method)
- Test: `apps/api/src/test/atlasv-gateway.test.ts`
- Test: `apps/api/src/test/game-catalog-sync-skip.test.ts`

**Interfaces:**
- Consumes: `signAtlasVBody` from Task 2 (`../gateways/game-provider/atlasv-signature.js`).
- Produces: `AtlasVGateway implements GameProviderGateway`, `readonly providerCode = 'atlasv'`, plus an Atlas-V-only method `createFreeSpins(playerId: string, endDate: string, freespinsCount: number): Promise<void>` (not part of the shared interface — consumed directly by the admin route in Task 7). `AtlasVApiError` class (`message`, `statusCode`, `code`).

- [ ] **Step 1: Write the failing gateway tests**

Create `apps/api/src/test/atlasv-gateway.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)
vi.stubEnv('ATLASV_SERVER_URL', 'https://atlasv.test')
vi.stubEnv('ATLASV_GAME_SERVER_URL', 'https://atlasv.test')
vi.stubEnv('ATLASV_PRIVATE_KEY', 'test-key')
vi.stubEnv('ATLASV_CASINO_ID', 'casino1')
vi.stubEnv('ATLASV_PARTNER_ID', '1')

function jsonOk(data: unknown) {
    return { ok: true, status: 200, json: async () => data }
}

describe('AtlasVGateway', () => {
    beforeEach(() => { mockFetch.mockReset() })

    it('getGameUrl calls /init and maps the url', async () => {
        mockFetch.mockResolvedValue(jsonOk({ url: 'https://play.atlasv.test/session/abc' }))
        const { AtlasVGateway } = await import('../gateways/game-provider/atlasv.gateway.js')
        const gw = new AtlasVGateway()
        const res = await gw.getGameUrl({
            username: 'p1'.padEnd(32, '0'), gameCode: 'penalty', language: 'en',
            platform: 'WEB', currency: 'ETB', lobbyUrl: 'https://lobby/', ipAddress: '127.0.0.1',
        })
        expect(res).toEqual({ gameUrl: 'https://play.atlasv.test/session/abc', token: '' })
        expect(mockFetch).toHaveBeenCalledWith('https://atlasv.test/init', expect.objectContaining({ method: 'POST' }))
        const sentBody = JSON.parse((mockFetch.mock.calls[0][1] as any).body)
        expect(sentBody).toMatchObject({ game: 'penalty', casino_id: 'casino1', partner_id: '1', player_id: 'p1'.padEnd(32, '0') })
        expect(sentBody.hash).toMatch(/^[0-9a-f]{40}$/)
    })

    it('throws AtlasVApiError when /init returns no url', async () => {
        mockFetch.mockResolvedValue(jsonOk({}))
        const { AtlasVGateway, AtlasVApiError } = await import('../gateways/game-provider/atlasv.gateway.js')
        const gw = new AtlasVGateway()
        await expect(gw.getGameUrl({
            username: 'p1', gameCode: 'penalty', language: 'en', platform: 'WEB',
            currency: 'ETB', lobbyUrl: 'https://lobby/', ipAddress: '127.0.0.1',
        })).rejects.toMatchObject({ constructor: AtlasVApiError, code: 'ATLASV_EMPTY_RESPONSE' })
    })

    it('throws AtlasVApiError on non-ok HTTP status', async () => {
        mockFetch.mockResolvedValue({ ok: false, status: 503 })
        const { AtlasVGateway, AtlasVApiError } = await import('../gateways/game-provider/atlasv.gateway.js')
        const gw = new AtlasVGateway()
        await expect(gw.getGameUrl({
            username: 'p1', gameCode: 'penalty', language: 'en', platform: 'WEB',
            currency: 'ETB', lobbyUrl: 'https://lobby/', ipAddress: '127.0.0.1',
        })).rejects.toMatchObject({ constructor: AtlasVApiError, code: 'ATLASV_UPSTREAM_HTTP_ERROR', statusCode: 502 })
    })

    it('createFreeSpins posts to /freespin with a signed body', async () => {
        mockFetch.mockResolvedValue(jsonOk({ success: true }))
        const { AtlasVGateway } = await import('../gateways/game-provider/atlasv.gateway.js')
        const gw = new AtlasVGateway()
        await gw.createFreeSpins('p1'.padEnd(32, '0'), '2026-12-14T11:55:00+00:00', 5)
        expect(mockFetch).toHaveBeenCalledWith('https://atlasv.test/freespin', expect.objectContaining({ method: 'POST' }))
        const sentBody = JSON.parse((mockFetch.mock.calls[0][1] as any).body)
        expect(sentBody).toMatchObject({ casino_id: 'casino1', player_id: 'p1'.padEnd(32, '0'), freespins_count: 5 })
    })

    it('getVendors throws — Atlas-V has no listing API', async () => {
        const { AtlasVGateway, AtlasVApiError } = await import('../gateways/game-provider/atlasv.gateway.js')
        const gw = new AtlasVGateway()
        await expect(gw.getVendors('ETB', 'en')).rejects.toMatchObject({ constructor: AtlasVApiError, code: 'ATLASV_NOT_SUPPORTED' })
    })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/test/atlasv-gateway.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `AtlasVGateway`**

Create `apps/api/src/gateways/game-provider/atlasv.gateway.ts`:

```ts
import { signAtlasVBody } from './atlasv-signature.js'
import type {
    GameProviderGateway,
    GameListResult,
    LaunchGameParams,
    TransactionDetail,
    TransactionListResult,
    Vendor,
} from './game-provider.interface.js'

const SERVER_URL = (process.env.ATLASV_SERVER_URL ?? '').replace(/\/$/, '')
const GAME_SERVER_URL = (process.env.ATLASV_GAME_SERVER_URL || process.env.ATLASV_SERVER_URL || '').replace(/\/$/, '')
const CASINO_ID = process.env.ATLASV_CASINO_ID ?? ''
const PARTNER_ID = process.env.ATLASV_PARTNER_ID ?? '1'

export class AtlasVApiError extends Error {
    readonly statusCode: number
    readonly code: string

    constructor(opts: { message: string; statusCode: number; code: string }) {
        super(opts.message)
        this.name = 'AtlasVApiError'
        this.statusCode = opts.statusCode
        this.code = opts.code
    }
}

async function request<T>(baseUrl: string, path: string, body: Record<string, unknown>): Promise<T> {
    const signed = signAtlasVBody(body)
    let res: Response
    try {
        res = await fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/javascript' },
            body: JSON.stringify(signed),
        })
    } catch (err: any) {
        throw new AtlasVApiError({
            message: `Atlas-V is unreachable: ${err?.message ?? 'network error'}`,
            statusCode: 502,
            code: 'ATLASV_UNREACHABLE',
        })
    }
    if (!res.ok) {
        throw new AtlasVApiError({
            message: `Atlas-V upstream returned HTTP ${res.status}`,
            statusCode: 502,
            code: 'ATLASV_UPSTREAM_HTTP_ERROR',
        })
    }
    try {
        return (await res.json()) as T
    } catch {
        throw new AtlasVApiError({
            message: `Atlas-V ${path} returned a non-JSON response`,
            statusCode: 502,
            code: 'ATLASV_INVALID_RESPONSE',
        })
    }
}

export class AtlasVGateway implements GameProviderGateway {
    readonly providerCode = 'atlasv'

    async getVendors(_currency: string, _language: string): Promise<Vendor[]> {
        throw new AtlasVApiError({ message: 'Atlas-V has no vendor listing API', statusCode: 501, code: 'ATLASV_NOT_SUPPORTED' })
    }

    async getGames(
        _vendorCode: string,
        _page: number,
        _pageSize: number,
        _currency: string,
        _language: string,
    ): Promise<GameListResult> {
        throw new AtlasVApiError({ message: 'Atlas-V has no game listing API', statusCode: 501, code: 'ATLASV_NOT_SUPPORTED' })
    }

    async getGameUrl(params: LaunchGameParams): Promise<{ gameUrl: string; token: string }> {
        const data = await request<{ url?: string }>(SERVER_URL, '/init', {
            game: params.gameCode,
            partner_id: PARTNER_ID,
            casino_id: CASINO_ID,
            language: params.language,
            currency: params.currency,
            player_id: params.username,
        })
        if (!data?.url) {
            throw new AtlasVApiError({ message: 'Atlas-V /init returned no url', statusCode: 502, code: 'ATLASV_EMPTY_RESPONSE' })
        }
        return { gameUrl: data.url, token: '' }
    }

    async terminateSession(_username: string): Promise<void> {
        // No session-termination endpoint in the Atlas-V spec.
    }

    async getTransactions(_fromTime: number, _toTime: number, _page: number): Promise<TransactionListResult> {
        throw new AtlasVApiError({ message: 'Atlas-V has no transaction reporting API', statusCode: 501, code: 'ATLASV_NOT_SUPPORTED' })
    }

    async getTransactionDetail(_betId: string, _fromTime: number, _toTime: number): Promise<TransactionDetail> {
        throw new AtlasVApiError({ message: 'Atlas-V has no transaction reporting API', statusCode: 501, code: 'ATLASV_NOT_SUPPORTED' })
    }

    /** Atlas-V-specific: not part of the shared GameProviderGateway interface. */
    async createFreeSpins(playerId: string, endDate: string, freespinsCount: number): Promise<void> {
        await request(GAME_SERVER_URL, '/freespin', {
            casino_id: CASINO_ID,
            player_id: playerId,
            end_date: endDate,
            freespins_count: freespinsCount,
        })
    }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/test/atlasv-gateway.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Register the gateway**

In `apps/api/src/gateways/game-provider/index.ts`, replace this block:

```ts
import type { GameProviderGateway } from './game-provider.interface.js'
import { GaseaGateway } from './gasea.gateway.js'
import { PalaceGateway } from './palace.gateway.js'
import { deploymentConfig } from '../hub/deployment-config.js'
import { RemoteGameProviderGateway } from '../hub/remote-game-provider.gateway.js'
```

with:

```ts
import type { GameProviderGateway } from './game-provider.interface.js'
import { GaseaGateway } from './gasea.gateway.js'
import { PalaceGateway } from './palace.gateway.js'
import { AtlasVGateway } from './atlasv.gateway.js'
import { deploymentConfig } from '../hub/deployment-config.js'
import { RemoteGameProviderGateway } from '../hub/remote-game-provider.gateway.js'
```

And replace this block:

```ts
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

with:

```ts
// Register providers based on deployment role.
if (deploymentConfig().role === 'spoke') {
    // Spokes have no provider credentials — every call is forwarded to the hub.
    registerGameProviderGateway(new RemoteGameProviderGateway('palace'))
    registerGameProviderGateway(new RemoteGameProviderGateway('gasea'))
    registerGameProviderGateway(new RemoteGameProviderGateway('atlasv'))
} else {
    // standalone + hub talk to providers directly.
    registerGameProviderGateway(new GaseaGateway())
    registerGameProviderGateway(new PalaceGateway())
    registerGameProviderGateway(new AtlasVGateway())
}
```

- [ ] **Step 6: Write the failing catalog-sync-skip test**

Create `apps/api/src/test/game-catalog-sync-skip.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma.js', () => ({
    default: { gameProvider: { findUnique: vi.fn() }, gameVendor: { findMany: vi.fn() } },
}))
vi.mock('../lib/redis.js', () => ({ default: { keys: vi.fn().mockResolvedValue([]), del: vi.fn() } }))

import prisma from '../lib/prisma.js'
const p = prisma as any

describe('GameCatalogService.syncAll — static-catalog skip', () => {
    beforeEach(() => vi.clearAllMocks())

    it('skips providers with config.catalogSync === false without touching the gateway', async () => {
        p.gameProvider.findUnique.mockResolvedValue({ id: 'prov1', code: 'atlasv', config: { catalogSync: false } })
        const { GameCatalogService } = await import('../services/game-catalog.service.js')
        const result = await GameCatalogService.syncAll('atlasv')
        expect(result).toEqual({ total: 0, reenabled: 0, autoHidden: 0 })
        expect(p.gameVendor.findMany).not.toHaveBeenCalled()
    })
})
```

- [ ] **Step 7: Run to verify failure**

Run: `pnpm vitest run src/test/game-catalog-sync-skip.test.ts`
Expected: FAIL — `syncAll` calls `syncVendors` → `getGameProviderGateway('atlasv').getVendors()` (unmocked gateway registry), throwing an unrelated error instead of returning the zeroed summary.

- [ ] **Step 8: Add the skip check to `GameCatalogService.syncAll`**

In `apps/api/src/services/game-catalog.service.ts`, replace the existing `syncAll` method body:

```ts
    /**
     * Full sync: vendors + all games.
     */
    static async syncAll(
        providerCode: string,
    ): Promise<{ total: number; reenabled: number; autoHidden: number }> {
        await GameCatalogService.syncVendors(providerCode)

        const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } })
        if (!provider) throw new Error(`Provider not found: ${providerCode}`)

        const vendors = await prisma.gameVendor.findMany({
            where: { providerId: provider.id, isActive: true },
        })
```

with:

```ts
    /**
     * Full sync: vendors + all games.
     */
    static async syncAll(
        providerCode: string,
    ): Promise<{ total: number; reenabled: number; autoHidden: number }> {
        const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } })
        if (!provider) throw new Error(`Provider not found: ${providerCode}`)

        // Some providers (Atlas-V) have no vendor/game-listing API — their
        // catalog is maintained by hand in the seed script. Skip cleanly
        // instead of letting the 6-hourly sync worker log a "not supported"
        // error forever.
        if ((provider.config as { catalogSync?: boolean } | null)?.catalogSync === false) {
            console.log(`[GameCatalog] Skipping ${providerCode} — static catalog, no listing API`)
            return { total: 0, reenabled: 0, autoHidden: 0 }
        }

        await GameCatalogService.syncVendors(providerCode)

        const vendors = await prisma.gameVendor.findMany({
            where: { providerId: provider.id, isActive: true },
        })
```

(The rest of the method — the `for (const vendor of vendors)` loop and return — is unchanged.)

- [ ] **Step 9: Run both test files and the full suite to verify no regressions**

Run: `pnpm vitest run src/test/game-catalog-sync-skip.test.ts src/test/atlasv-gateway.test.ts src/test/game-catalog.search.test.ts`
Expected: PASS, all files

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/gateways/game-provider/atlasv.gateway.ts apps/api/src/gateways/game-provider/index.ts apps/api/src/services/game-catalog.service.ts apps/api/src/test/atlasv-gateway.test.ts apps/api/src/test/game-catalog-sync-skip.test.ts
git commit -m "feat(api): Atlas-V outbound gateway, registry wiring, catalog-sync skip"
```

---

### Task 4: `AtlasVWalletService` core — getAccount, processBet, processRollback

**Files:**
- Create: `apps/api/src/services/atlasv-wallet.service.ts`
- Test: `apps/api/src/test/atlasv-wallet.test.ts`

**Interfaces:**
- Consumes: `BonusService.spend(tx, userId, amount): Promise<{ bonusBalanceAfter: Decimal; soonestExpiryConsumed: Date | null }>`, `BonusService.restore(tx, userId, amount, expiresAt): Promise<{ bonusBalanceAfter: Decimal }>` (`../services/bonus.service.js`), `emitProviderBet`/`emitProviderWin` (`../lib/posthog-events.js`).
- Produces: `AtlasVWalletService.getAccount`, `.processBet`, `.processRollback` (this task); `.processBetWin`, `.processResult`, `.processFreespinResult`, `.processJackpot`, `.dispatch(action, data)` are added in Task 5 to the same class. Type `AtlasVAction = 'account'|'bet'|'betwin'|'result'|'rollback'|'freespin'|'jackpot'`, type `AtlasVResponse = { player_id: string; balance: number } | { success: boolean }` — consumed by the callback routes in Task 6.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/test/atlasv-wallet.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('../lib/prisma.js', () => ({
    default: {
        gameProvider: { findUnique: vi.fn() },
        wallet: { findUnique: vi.fn(), update: vi.fn() },
        thirdPartyTransaction: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
        transaction: { create: vi.fn(), findFirst: vi.fn() },
        user: { findUnique: vi.fn() },
        $transaction: vi.fn(),
        $queryRaw: vi.fn(),
    },
}))

vi.mock('../lib/redis.js', () => ({ default: { get: vi.fn().mockResolvedValue(null), setex: vi.fn() } }))

vi.mock('../services/bonus.service.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/bonus.service.js')>()
    return { ...actual, BonusService: { spend: vi.fn(), restore: vi.fn() } }
})

import prisma from '../lib/prisma.js'
import { BonusService } from '../services/bonus.service.js'
const p = prisma as any

const PLAYER_ID = 'a'.repeat(32)

describe('AtlasVWalletService', () => {
    beforeEach(() => vi.clearAllMocks())

    it('getAccount returns balance for an active user', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '100.00', bonusBalance: '0', spendAccount: 'REAL' })
        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.getAccount({ player_id: PLAYER_ID })
        expect(res).toEqual({ player_id: PLAYER_ID, balance: 100 })
    })

    it('getAccount fails for an unknown user', async () => {
        p.user.findUnique.mockResolvedValue(null)
        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.getAccount({ player_id: PLAYER_ID })
        expect(res).toEqual({ success: false })
    })

    it('processBet debits the wallet and records a BET ledger row', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '100.00', bonusBalance: '0', spendAccount: 'REAL' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: { create: vi.fn() },
            transaction: { create: vi.fn() },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processBet({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', transaction_id: 't1', amount: 10,
        })

        expect(res).toEqual({ player_id: PLAYER_ID, balance: 90 })
        expect(fakeTx.wallet.update).toHaveBeenCalledWith({ where: { userId: 'uid1' }, data: { realBalance: expect.anything() } })
        expect(fakeTx.thirdPartyTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ type: 'BET', transactionId: 't1' }),
        }))
    })

    it('processBet rejects when the real balance is insufficient', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        p.wallet.findUnique.mockResolvedValue({ realBalance: '5.00', bonusBalance: '0', spendAccount: 'REAL' })
        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '5.00', bonusBalance: '0', spendAccount: 'REAL' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: { create: vi.fn() },
            transaction: { create: vi.fn() },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processBet({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', transaction_id: 't1', amount: 10,
        })

        expect(res).toEqual({ success: false })
        expect(fakeTx.wallet.update).not.toHaveBeenCalled()
    })

    it('processBet replays idempotently — returns current balance without re-debiting', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue({ id: 'existing', status: 'COMPLETED' })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '90.00', bonusBalance: '0', spendAccount: 'REAL' })

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processBet({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', transaction_id: 't1', amount: 10,
        })

        expect(res).toEqual({ player_id: PLAYER_ID, balance: 90 })
        expect(p.$transaction).not.toHaveBeenCalled()
    })

    it('processRollback refunds exactly the recorded bet amount, once', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique
            .mockResolvedValueOnce(null) // findExisting(cancelTxId) — not a replay
        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '90.00', bonusBalance: '0', spendAccount: 'REAL' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: {
                findUnique: vi.fn().mockResolvedValue({ id: 'bet1', betAmount: '10.00', amount: '-10.00', type: 'BET', status: 'COMPLETED', transactionId: 't1' }),
                update: vi.fn(),
                create: vi.fn(),
            },
            transaction: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processRollback({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', bet_transaction_id: 't1',
        })

        expect(res).toEqual({ success: true })
        expect(fakeTx.wallet.update).toHaveBeenCalledWith({ where: { userId: 'uid1' }, data: { realBalance: expect.anything() } })
        expect(fakeTx.thirdPartyTransaction.update).toHaveBeenCalledWith({ where: { id: 'bet1' }, data: { status: 'ROLLED_BACK' } })
    })

    it('processRollback does not credit anything when no matching completed bet exists', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValueOnce(null)
        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '90.00', bonusBalance: '0', spendAccount: 'REAL' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn(), create: vi.fn() },
            transaction: { create: vi.fn(), findFirst: vi.fn() },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processRollback({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', bet_transaction_id: 'nonexistent',
        })

        expect(res).toEqual({ success: true })
        expect(fakeTx.wallet.update).not.toHaveBeenCalled()
        expect(fakeTx.thirdPartyTransaction.update).not.toHaveBeenCalled()
    })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/test/atlasv-wallet.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the service (core methods only)**

Create `apps/api/src/services/atlasv-wallet.service.ts`:

```ts
import { Decimal } from '@prisma/client/runtime/library'
import { emitProviderBet, emitProviderWin } from '../lib/posthog-events.js'
import type { AccountStatus as AccountStatusValue } from '@prisma/client'
import { AccountStatus, TransactionType, PaymentStatus, ThirdPartyTxType, ThirdPartyTxStatus } from '@world-bingo/shared-types'
import prisma from '../lib/prisma.js'
import redis from '../lib/redis.js'
import { getLogger } from '../lib/log-context.js'
import { maskAccount } from '../lib/logger.js'
import { BonusService } from './bonus.service'

// ─── Types ────────────────────────────────────────────────────────────────────

const PROVIDER_CODE = 'atlasv'
const USER_CACHE_TTL = 3600
const MAX_WIN_AMOUNT = Number(process.env.ATLASV_MAX_WIN_AMOUNT ?? 1_000_000)
const MAX_WIN_MULTIPLE = Number(process.env.ATLASV_MAX_WIN_MULTIPLE ?? 20_000)

export type AtlasVAction = 'account' | 'bet' | 'betwin' | 'result' | 'rollback' | 'freespin' | 'jackpot'
export type AtlasVResponse = { player_id: string; balance: number } | { success: boolean }

interface AccountParams { player_id: string }
interface BetParams { player_id: string; round_id?: string; game_code?: string; transaction_id: string; amount: number }
interface BetWinParams { player_id: string; round_id?: string; game_code?: string; transaction_id: string; betAmount: number; winAmount: number }
interface ResultParams { player_id: string; round_id?: string; game_code?: string; transaction_id: string; bet_transaction_id: string; amount: number }
interface RollbackParams { player_id: string; round_id?: string; game_code?: string; bet_transaction_id: string }
interface FreespinResultParams { player_id: string; round_id?: string; game_code?: string; transaction_id: string; amount: number }
interface JackpotParams { player_id: string; round_id?: string; game_code?: string; transaction_id: string; amount: number }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fail(): AtlasVResponse {
    return { success: false }
}

let _providerId: string | null = null
async function getAtlasVProviderId(): Promise<string> {
    if (_providerId) return _providerId
    const provider = await prisma.gameProvider.findUnique({ where: { code: PROVIDER_CODE } })
    if (!provider) throw new Error(`Provider '${PROVIDER_CODE}' not seeded in DB`)
    _providerId = provider.id
    return _providerId
}

async function resolveUser(playerId: string): Promise<{ id: string; accountStatus: AccountStatusValue } | null> {
    const cacheKey = `tp:user:${playerId}`
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    let user: { id: string; accountStatus: AccountStatusValue } | null = null
    if (/^[0-9a-f]{32}$/i.test(playerId)) {
        const id = `${playerId.slice(0, 8)}-${playerId.slice(8, 12)}-${playerId.slice(12, 16)}-${playerId.slice(16, 20)}-${playerId.slice(20)}`
        user = await prisma.user.findUnique({ where: { id }, select: { id: true, accountStatus: true } })
    } else {
        user = await prisma.user.findUnique({ where: { username: playerId }, select: { id: true, accountStatus: true } })
    }
    if (user) await redis.setex(cacheKey, USER_CACHE_TTL, JSON.stringify(user))
    getLogger().info(
        { component: 'atlasv-resolve-user', playerId: maskAccount(playerId), matched: !!user },
        '[atlasv-resolve-user] account resolution',
    )
    return user
}

type WalletRow = { id: string; realBalance: Decimal; bonusBalance: Decimal; spendAccount: 'REAL' | 'BONUS' }
async function lockWallet(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    userId: string,
): Promise<WalletRow> {
    const rows = await tx.$queryRaw<WalletRow[]>`
        SELECT id, "realBalance", "bonusBalance", "spendAccount" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
    `
    if (!rows[0]) throw { code: 'USER_NOT_FOUND' }
    return rows[0]
}

async function findExisting(transactionId: string | undefined | null) {
    if (!transactionId) return null
    const providerId = await getAtlasVProviderId()
    return prisma.thirdPartyTransaction.findUnique({
        where: { providerId_transactionId: { providerId, transactionId } },
    })
}

async function currentBalance(userId: string): Promise<Decimal> {
    const wallet = await prisma.wallet.findUnique({ where: { userId } })
    if (!wallet) return new Decimal(0)
    return wallet.spendAccount === 'BONUS' ? new Decimal(wallet.bonusBalance) : new Decimal(wallet.realBalance)
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class AtlasVWalletService {
    static async getAccount(params: AccountParams): Promise<AtlasVResponse> {
        const user = await resolveUser(params.player_id)
        if (!user || user.accountStatus !== AccountStatus.ACTIVE) return fail()
        const balance = await currentBalance(user.id)
        return { player_id: params.player_id, balance: Number(balance.toFixed(2)) }
    }

    static async processBet(params: BetParams): Promise<AtlasVResponse> {
        const user = await resolveUser(params.player_id)
        if (!user || user.accountStatus !== AccountStatus.ACTIVE) return fail()

        const existing = await findExisting(params.transaction_id)
        if (existing) {
            const balance = await currentBalance(user.id)
            return { player_id: params.player_id, balance: Number(balance.toFixed(2)) }
        }

        try {
            const balanceAfter = await prisma.$transaction(async (tx) => {
                const wallet = await lockWallet(tx, user.id)
                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                const totalBefore = realBefore.plus(bonusBefore)
                const betAmount = new Decimal(params.amount).abs()

                let newReal = realBefore
                let newBonus = bonusBefore
                let bonusExpiresAtSpend: Date | null = null

                if (wallet.spendAccount === 'BONUS') {
                    if (bonusBefore.lessThan(betAmount)) throw { code: 'BALANCE_NOT_ENOUGH' }
                    const spendResult = await BonusService.spend(tx, user.id, betAmount)
                    newBonus = spendResult.bonusBalanceAfter
                    bonusExpiresAtSpend = spendResult.soonestExpiryConsumed
                } else {
                    if (realBefore.lessThan(betAmount)) throw { code: 'BALANCE_NOT_ENOUGH' }
                    newReal = realBefore.minus(betAmount)
                    await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
                }
                const newTotal = newReal.plus(newBonus)

                const providerId = await getAtlasVProviderId()
                await tx.thirdPartyTransaction.create({
                    data: {
                        providerId, userId: user.id, transactionId: params.transaction_id,
                        roundId: params.round_id, gameCode: params.game_code,
                        type: ThirdPartyTxType.BET, status: ThirdPartyTxStatus.COMPLETED,
                        betAmount, amount: betAmount.negated(),
                        balanceBefore: totalBefore, balanceAfter: newTotal, rawRequest: params as any,
                    },
                })
                await tx.transaction.create({
                    data: {
                        userId: user.id, type: TransactionType.TP_BET, amount: betAmount,
                        status: PaymentStatus.APPROVED,
                        note: `Atlas-V bet: ${params.game_code ?? ''} round ${params.round_id ?? ''}`,
                        referenceId: params.transaction_id,
                        balanceBefore: totalBefore, balanceAfter: newTotal,
                        bonusBalanceBefore: bonusBefore, bonusBalanceAfter: newBonus, bonusExpiresAtSpend,
                    },
                })
                return wallet.spendAccount === 'BONUS' ? newBonus : newReal
            })

            emitProviderBet(user.id, {
                providerCode: PROVIDER_CODE, gameCode: params.game_code ?? null, roundId: params.round_id ?? null,
                betId: params.transaction_id, amount: Number(params.amount), spendAccount: 'REAL',
            })
            return { player_id: params.player_id, balance: Number(balanceAfter.toFixed(2)) }
        } catch (e: any) {
            if (e?.code === 'BALANCE_NOT_ENOUGH' || e?.name === 'InsufficientBonusBalanceError') {
                try {
                    const providerId = await getAtlasVProviderId()
                    const current = await currentBalance(user.id)
                    await prisma.thirdPartyTransaction.create({
                        data: {
                            providerId, userId: user.id, transactionId: params.transaction_id,
                            roundId: params.round_id, gameCode: params.game_code,
                            type: ThirdPartyTxType.BET, status: ThirdPartyTxStatus.FAILED,
                            betAmount: new Decimal(params.amount).abs(), amount: new Decimal(0),
                            balanceBefore: current, balanceAfter: current,
                        },
                    })
                } catch { /* ignore duplicate */ }
                return fail()
            }
            if (e?.code) return fail()
            throw e
        }
    }

    static async processRollback(params: RollbackParams): Promise<AtlasVResponse> {
        const user = await resolveUser(params.player_id)
        if (!user || user.accountStatus !== AccountStatus.ACTIVE) return fail()

        const cancelTxId = `rollback:${params.bet_transaction_id}`
        const existing = await findExisting(cancelTxId)
        if (existing) return { success: true }

        const providerId = await getAtlasVProviderId()

        const success = await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)

            const originalBet = await tx.thirdPartyTransaction.findUnique({
                where: { providerId_transactionId: { providerId, transactionId: params.bet_transaction_id } },
            })

            const refundable =
                !!originalBet &&
                originalBet.type === ThirdPartyTxType.BET &&
                originalBet.status === ThirdPartyTxStatus.COMPLETED

            if (!refundable) {
                getLogger().warn(
                    {
                        component: 'atlasv-fraud-flag', playerId: maskAccount(params.player_id),
                        round: params.round_id, betRef: params.bet_transaction_id,
                        found: !!originalBet, status: originalBet?.status,
                    },
                    '[atlasv-fraud-flag] rollback with no matching completed bet — not crediting',
                )
            }

            const delta = refundable ? new Decimal(originalBet!.betAmount ?? originalBet!.amount).abs() : new Decimal(0)

            let realDelta = delta
            let bonusDelta = new Decimal(0)
            let restoreExpiry: Date | null = null
            if (refundable && delta.greaterThan(0)) {
                const betTxn = await tx.transaction.findFirst({
                    where: { userId: user.id, type: TransactionType.TP_BET, referenceId: originalBet!.transactionId },
                    select: { bonusBalanceBefore: true, bonusBalanceAfter: true, bonusExpiresAtSpend: true },
                })
                if (betTxn) {
                    const bonusSpent = new Decimal(betTxn.bonusBalanceBefore ?? 0).minus(new Decimal(betTxn.bonusBalanceAfter ?? 0))
                    if (bonusSpent.greaterThan(0)) {
                        bonusDelta = Decimal.min(bonusSpent, delta)
                        realDelta = delta.minus(bonusDelta)
                        restoreExpiry = betTxn.bonusExpiresAtSpend ?? null
                    }
                }
            }

            const newReal = realBefore.plus(realDelta)
            let newBonus = bonusBefore

            if (delta.greaterThan(0)) {
                if (realDelta.greaterThan(0)) {
                    await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
                }
                if (bonusDelta.greaterThan(0)) {
                    const restoreResult = await BonusService.restore(tx, user.id, bonusDelta, restoreExpiry)
                    newBonus = restoreResult.bonusBalanceAfter
                }
                await tx.thirdPartyTransaction.update({
                    where: { id: originalBet!.id },
                    data: { status: ThirdPartyTxStatus.ROLLED_BACK },
                })
            }

            const newTotal = newReal.plus(newBonus)

            await tx.thirdPartyTransaction.create({
                data: {
                    providerId, userId: user.id, transactionId: cancelTxId,
                    roundId: params.round_id, gameCode: params.game_code,
                    type: ThirdPartyTxType.ROLLBACK, status: ThirdPartyTxStatus.COMPLETED,
                    amount: delta, balanceBefore: totalBefore, balanceAfter: newTotal, rawRequest: params as any,
                },
            })

            if (delta.greaterThan(0)) {
                await tx.transaction.create({
                    data: {
                        userId: user.id, type: TransactionType.TP_ROLLBACK, amount: delta,
                        status: PaymentStatus.APPROVED,
                        note: `Atlas-V rollback: ${params.game_code ?? ''} round ${params.round_id ?? ''}`,
                        referenceId: cancelTxId, balanceBefore: totalBefore, balanceAfter: newTotal,
                        bonusBalanceBefore: bonusBefore, bonusBalanceAfter: newBonus,
                    },
                })
            }

            return true
        })

        return { success }
    }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/test/atlasv-wallet.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/atlasv-wallet.service.ts apps/api/src/test/atlasv-wallet.test.ts
git commit -m "feat(api): Atlas-V wallet service — account, bet, rollback"
```

---

### Task 5: `AtlasVWalletService` remaining — betwin, result, freespin result, jackpot, dispatch

**Files:**
- Modify: `apps/api/src/services/atlasv-wallet.service.ts`
- Modify: `apps/api/src/test/atlasv-wallet.test.ts`

**Interfaces:**
- Produces: `AtlasVWalletService.processBetWin`, `.processResult`, `.processFreespinResult`, `.processJackpot`, `.dispatch(action: AtlasVAction | undefined, d: Record<string, any>): Promise<AtlasVResponse>` — `dispatch` is consumed directly by the callback route helper (Task 6) and the spoke sink (Task 6).

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/test/atlasv-wallet.test.ts` (inside the existing `describe('AtlasVWalletService', ...)` block, after the last `it(...)`):

```ts

    it('processBetWin nets bet and win in one ledger row and always credits REAL on the win leg', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '100.00', bonusBalance: '0', spendAccount: 'REAL' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: { create: vi.fn() },
            transaction: { create: vi.fn() },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processBetWin({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', transaction_id: 't2', betAmount: 10, winAmount: 25,
        })

        expect(res).toEqual({ player_id: PLAYER_ID, balance: 115 }) // 100 - 10 + 25
        expect(fakeTx.thirdPartyTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ type: 'BET_RESULT', betAmount: expect.anything(), winAmount: expect.anything() }),
        }))
    })

    it('processBetWin rejects a win over MAX_WIN_MULTIPLE without touching the wallet', async () => {
        vi.stubEnv('ATLASV_MAX_WIN_MULTIPLE', '10')
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processBetWin({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', transaction_id: 't3', betAmount: 10, winAmount: 200,
        })

        expect(res).toEqual({ success: false })
        expect(p.$transaction).not.toHaveBeenCalled()
        vi.unstubAllEnvs()
    })

    it('processResult credits only against a real prior completed bet', async () => {
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.thirdPartyTransaction.findUnique
            .mockResolvedValueOnce(null) // findExisting(transaction_id)
            .mockResolvedValueOnce({ id: 'bet1', type: 'BET', status: 'COMPLETED', betAmount: '10.00', amount: '-10.00' }) // prior bet lookup
        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '90.00', bonusBalance: '0', spendAccount: 'REAL' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: { create: vi.fn() },
            transaction: { create: vi.fn() },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processResult({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty',
            transaction_id: 'res1', bet_transaction_id: 't1', amount: 30,
        })

        expect(res).toEqual({ success: true })
        expect(fakeTx.wallet.update).toHaveBeenCalledWith({ where: { userId: 'uid1' }, data: { realBalance: expect.anything() } })
    })

    it('processResult refuses to credit when there is no matching prior bet', async () => {
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.thirdPartyTransaction.findUnique
            .mockResolvedValueOnce(null) // findExisting(transaction_id)
            .mockResolvedValueOnce(null) // prior bet lookup — not found

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processResult({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty',
            transaction_id: 'res2', bet_transaction_id: 'nonexistent', amount: 30,
        })

        expect(res).toEqual({ success: false })
        expect(p.$transaction).not.toHaveBeenCalled()
    })

    it('processFreespinResult credits a win with no prior bet required', async () => {
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '50.00', bonusBalance: '0', spendAccount: 'REAL' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: { create: vi.fn() },
            transaction: { create: vi.fn() },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processFreespinResult({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', transaction_id: 'fs1', amount: 15,
        })

        expect(res).toEqual({ success: true })
        expect(fakeTx.wallet.update).toHaveBeenCalledWith({ where: { userId: 'uid1' }, data: { realBalance: expect.anything() } })
    })

    it('processJackpot credits the wallet and records a ledger row', async () => {
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '50.00', bonusBalance: '0', spendAccount: 'REAL' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: { create: vi.fn() },
            transaction: { create: vi.fn() },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processJackpot({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', transaction_id: 'jp1', amount: 500,
        })

        expect(res).toEqual({ success: true })
        expect(fakeTx.wallet.update).toHaveBeenCalledWith({ where: { userId: 'uid1' }, data: { realBalance: expect.anything() } })
    })

    it('dispatch routes each action to the matching handler', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '10.00', bonusBalance: '0', spendAccount: 'REAL' })

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.dispatch('account', { player_id: PLAYER_ID })
        expect(res).toEqual({ player_id: PLAYER_ID, balance: 10 })
    })

    it('dispatch returns failure for an unknown action', async () => {
        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.dispatch('nonsense' as any, { player_id: PLAYER_ID })
        expect(res).toEqual({ success: false })
    })
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/test/atlasv-wallet.test.ts`
Expected: FAIL — `AtlasVWalletService.processBetWin is not a function` (and similarly for the other new methods/`dispatch`)

- [ ] **Step 3: Implement the remaining methods**

Add to the `AtlasVWalletService` class in `apps/api/src/services/atlasv-wallet.service.ts`, after `processRollback` and before the closing `}` of the class:

```ts

    static async processBetWin(params: BetWinParams): Promise<AtlasVResponse> {
        const user = await resolveUser(params.player_id)
        if (!user || user.accountStatus !== AccountStatus.ACTIVE) return fail()

        const existing = await findExisting(params.transaction_id)
        if (existing) {
            const balance = await currentBalance(user.id)
            return { player_id: params.player_id, balance: Number(balance.toFixed(2)) }
        }

        const betAmount = new Decimal(params.betAmount).abs()
        const winAmount = new Decimal(params.winAmount).abs()

        const overAbsolute = MAX_WIN_AMOUNT > 0 && winAmount.greaterThan(MAX_WIN_AMOUNT)
        const overMultiple = MAX_WIN_MULTIPLE > 0 && betAmount.greaterThan(0) && winAmount.greaterThan(betAmount.times(MAX_WIN_MULTIPLE))
        if (overAbsolute || overMultiple) {
            getLogger().warn(
                {
                    component: 'atlasv-fraud-flag', playerId: maskAccount(params.player_id),
                    round: params.round_id, betAmount: betAmount.toNumber(), winAmount: winAmount.toNumber(),
                },
                '[atlasv-fraud-flag] betwin failed validation guard',
            )
            return fail()
        }

        try {
            const balanceAfter = await prisma.$transaction(async (tx) => {
                const wallet = await lockWallet(tx, user.id)
                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                const totalBefore = realBefore.plus(bonusBefore)

                let newBonus = bonusBefore
                let bonusExpiresAtSpend: Date | null = null

                // A win always credits REAL balance — bonus wagers convert to
                // withdrawable real money on a win, they don't replenish the
                // bonus pot. Only the bet leg draws from BONUS when selected.
                if (wallet.spendAccount === 'BONUS') {
                    if (bonusBefore.lessThan(betAmount)) throw { code: 'BALANCE_NOT_ENOUGH' }
                    const spendResult = await BonusService.spend(tx, user.id, betAmount)
                    newBonus = spendResult.bonusBalanceAfter
                    bonusExpiresAtSpend = spendResult.soonestExpiryConsumed
                } else {
                    if (realBefore.lessThan(betAmount)) throw { code: 'BALANCE_NOT_ENOUGH' }
                }
                const newReal = (wallet.spendAccount === 'BONUS' ? realBefore : realBefore.minus(betAmount)).plus(winAmount)
                await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })

                const newTotal = newReal.plus(newBonus)
                const providerId = await getAtlasVProviderId()
                await tx.thirdPartyTransaction.create({
                    data: {
                        providerId, userId: user.id, transactionId: params.transaction_id,
                        roundId: params.round_id, gameCode: params.game_code,
                        type: ThirdPartyTxType.BET_RESULT, status: ThirdPartyTxStatus.COMPLETED,
                        betAmount, winAmount, amount: winAmount.minus(betAmount),
                        balanceBefore: totalBefore, balanceAfter: newTotal, rawRequest: params as any,
                    },
                })
                await tx.transaction.create({
                    data: {
                        userId: user.id, type: TransactionType.TP_WIN, amount: winAmount.minus(betAmount),
                        status: PaymentStatus.APPROVED,
                        note: `Atlas-V betwin: ${params.game_code ?? ''} round ${params.round_id ?? ''}`,
                        referenceId: params.transaction_id,
                        balanceBefore: totalBefore, balanceAfter: newTotal,
                        bonusBalanceBefore: bonusBefore, bonusBalanceAfter: newBonus, bonusExpiresAtSpend,
                    },
                })
                return wallet.spendAccount === 'BONUS' ? newBonus : newReal
            })

            emitProviderBet(user.id, { providerCode: PROVIDER_CODE, gameCode: params.game_code ?? null, roundId: params.round_id ?? null, betId: params.transaction_id, amount: betAmount.toNumber(), spendAccount: 'REAL' })
            emitProviderWin(user.id, { providerCode: PROVIDER_CODE, gameCode: params.game_code ?? null, roundId: params.round_id ?? null, betId: params.transaction_id, amount: winAmount.toNumber(), roundStake: betAmount.toNumber() })

            return { player_id: params.player_id, balance: Number(balanceAfter.toFixed(2)) }
        } catch (e: any) {
            if (e?.code === 'BALANCE_NOT_ENOUGH' || e?.name === 'InsufficientBonusBalanceError') return fail()
            if (e?.code) return fail()
            throw e
        }
    }

    static async processResult(params: ResultParams): Promise<AtlasVResponse> {
        const user = await resolveUser(params.player_id)
        if (!user || user.accountStatus !== AccountStatus.ACTIVE) return fail()

        const existing = await findExisting(params.transaction_id)
        if (existing) return { success: true }

        const providerId = await getAtlasVProviderId()
        const priorBet = await prisma.thirdPartyTransaction.findUnique({
            where: { providerId_transactionId: { providerId, transactionId: params.bet_transaction_id } },
        })
        if (!priorBet || priorBet.type !== ThirdPartyTxType.BET || priorBet.status !== ThirdPartyTxStatus.COMPLETED) {
            getLogger().warn(
                { component: 'atlasv-fraud-flag', playerId: maskAccount(params.player_id), round: params.round_id, betRef: params.bet_transaction_id },
                '[atlasv-fraud-flag] result with no matching completed bet — not crediting',
            )
            return fail()
        }

        const winAmount = new Decimal(params.amount).abs()
        const betAmount = new Decimal(priorBet.betAmount ?? priorBet.amount).abs()

        const overAbsolute = MAX_WIN_AMOUNT > 0 && winAmount.greaterThan(MAX_WIN_AMOUNT)
        const overMultiple = MAX_WIN_MULTIPLE > 0 && betAmount.greaterThan(0) && winAmount.greaterThan(betAmount.times(MAX_WIN_MULTIPLE))
        if (overAbsolute || overMultiple) {
            getLogger().warn(
                { component: 'atlasv-fraud-flag', playerId: maskAccount(params.player_id), round: params.round_id, winAmount: winAmount.toNumber(), betAmount: betAmount.toNumber() },
                '[atlasv-fraud-flag] result failed validation guard',
            )
            return fail()
        }

        await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)
            const newReal = realBefore.plus(winAmount)
            const newTotal = newReal.plus(bonusBefore)

            await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
            await tx.thirdPartyTransaction.create({
                data: {
                    providerId, userId: user.id, transactionId: params.transaction_id,
                    roundId: params.round_id, gameCode: params.game_code,
                    type: ThirdPartyTxType.BET_RESULT, status: ThirdPartyTxStatus.COMPLETED,
                    winAmount, amount: winAmount,
                    balanceBefore: totalBefore, balanceAfter: newTotal, rawRequest: params as any,
                },
            })
            await tx.transaction.create({
                data: {
                    userId: user.id, type: TransactionType.TP_WIN, amount: winAmount,
                    status: PaymentStatus.APPROVED,
                    note: `Atlas-V result: ${params.game_code ?? ''} round ${params.round_id ?? ''}`,
                    referenceId: params.transaction_id,
                    balanceBefore: totalBefore, balanceAfter: newTotal,
                    bonusBalanceBefore: bonusBefore, bonusBalanceAfter: bonusBefore,
                },
            })
        })

        emitProviderWin(user.id, { providerCode: PROVIDER_CODE, gameCode: params.game_code ?? null, roundId: params.round_id ?? null, betId: params.bet_transaction_id, amount: winAmount.toNumber(), roundStake: betAmount.toNumber() })
        return { success: true }
    }

    static async processFreespinResult(params: FreespinResultParams): Promise<AtlasVResponse> {
        const user = await resolveUser(params.player_id)
        if (!user || user.accountStatus !== AccountStatus.ACTIVE) return fail()

        const existing = await findExisting(params.transaction_id)
        if (existing) return { success: true }

        const winAmount = new Decimal(params.amount).abs()
        if (MAX_WIN_AMOUNT > 0 && winAmount.greaterThan(MAX_WIN_AMOUNT)) {
            getLogger().warn(
                { component: 'atlasv-fraud-flag', playerId: maskAccount(params.player_id), round: params.round_id, winAmount: winAmount.toNumber() },
                '[atlasv-fraud-flag] freespin result exceeds MAX_WIN_AMOUNT',
            )
            return fail()
        }

        const providerId = await getAtlasVProviderId()
        await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)
            const newReal = realBefore.plus(winAmount)
            const newTotal = newReal.plus(bonusBefore)

            await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
            await tx.thirdPartyTransaction.create({
                data: {
                    providerId, userId: user.id, transactionId: params.transaction_id,
                    roundId: params.round_id, gameCode: params.game_code,
                    type: ThirdPartyTxType.BET_RESULT, status: ThirdPartyTxStatus.COMPLETED,
                    winAmount, amount: winAmount,
                    balanceBefore: totalBefore, balanceAfter: newTotal, rawRequest: params as any,
                },
            })
            await tx.transaction.create({
                data: {
                    userId: user.id, type: TransactionType.TP_WIN, amount: winAmount,
                    status: PaymentStatus.APPROVED,
                    note: `Atlas-V freespin win: ${params.game_code ?? ''} round ${params.round_id ?? ''}`,
                    referenceId: params.transaction_id,
                    balanceBefore: totalBefore, balanceAfter: newTotal,
                    bonusBalanceBefore: bonusBefore, bonusBalanceAfter: bonusBefore,
                },
            })
        })

        emitProviderWin(user.id, { providerCode: PROVIDER_CODE, gameCode: params.game_code ?? null, roundId: params.round_id ?? null, betId: params.transaction_id, amount: winAmount.toNumber(), roundStake: 0 })
        return { success: true }
    }

    // No MAX_WIN_AMOUNT cap here, deliberately — jackpots are inherently large
    // by design; the cap exists to catch forged/absurd bet-tied wins, not to
    // second-guess a legitimate jackpot payout.
    static async processJackpot(params: JackpotParams): Promise<AtlasVResponse> {
        const user = await resolveUser(params.player_id)
        if (!user || user.accountStatus !== AccountStatus.ACTIVE) return fail()

        const existing = await findExisting(params.transaction_id)
        if (existing) return { success: true }

        const winAmount = new Decimal(params.amount).abs()
        const providerId = await getAtlasVProviderId()
        await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)
            const newReal = realBefore.plus(winAmount)
            const newTotal = newReal.plus(bonusBefore)

            await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })
            await tx.thirdPartyTransaction.create({
                data: {
                    providerId, userId: user.id, transactionId: params.transaction_id,
                    roundId: params.round_id, gameCode: params.game_code,
                    type: ThirdPartyTxType.BET_RESULT, status: ThirdPartyTxStatus.COMPLETED,
                    winAmount, amount: winAmount,
                    balanceBefore: totalBefore, balanceAfter: newTotal, rawRequest: params as any,
                },
            })
            await tx.transaction.create({
                data: {
                    userId: user.id, type: TransactionType.TP_WIN, amount: winAmount,
                    status: PaymentStatus.APPROVED,
                    note: `Atlas-V jackpot: ${params.game_code ?? ''} round ${params.round_id ?? ''}`,
                    referenceId: params.transaction_id,
                    balanceBefore: totalBefore, balanceAfter: newTotal,
                    bonusBalanceBefore: bonusBefore, bonusBalanceAfter: bonusBefore,
                },
            })
        })

        emitProviderWin(user.id, { providerCode: PROVIDER_CODE, gameCode: params.game_code ?? null, roundId: params.round_id ?? null, betId: params.transaction_id, amount: winAmount.toNumber(), roundStake: 0 })
        return { success: true }
    }

    /** Dispatch a callback action to the matching wallet handler. */
    static async dispatch(action: AtlasVAction | undefined, d: Record<string, any>): Promise<AtlasVResponse> {
        const startedAt = Date.now()
        const res = await AtlasVWalletService.route(action, d)
        getLogger().info(
            { component: 'atlasv-wallet', action, playerId: maskAccount(d?.player_id), result: res, latencyMs: Date.now() - startedAt },
            '[atlasv-wallet] action handled',
        )
        return res
    }

    private static async route(action: AtlasVAction | undefined, d: Record<string, any>): Promise<AtlasVResponse> {
        switch (action) {
            case 'account':
                return AtlasVWalletService.getAccount({ player_id: d.player_id })
            case 'bet':
                return AtlasVWalletService.processBet({
                    player_id: d.player_id, round_id: d.round_id, game_code: d.game,
                    transaction_id: d.transaction_id, amount: d.amount,
                })
            case 'betwin':
                return AtlasVWalletService.processBetWin({
                    player_id: d.player_id, round_id: d.round_id, game_code: d.game,
                    transaction_id: d.transaction_id, betAmount: d.betAmount, winAmount: d.winAmount,
                })
            case 'result':
                return AtlasVWalletService.processResult({
                    player_id: d.player_id, round_id: d.round_id, game_code: d.game,
                    transaction_id: d.transaction_id, bet_transaction_id: d.bet_transaction_id, amount: d.amount,
                })
            case 'rollback':
                return AtlasVWalletService.processRollback({
                    player_id: d.player_id, round_id: d.round_id, game_code: d.game,
                    bet_transaction_id: d.bet_transaction_id,
                })
            case 'freespin':
                return AtlasVWalletService.processFreespinResult({
                    player_id: d.player_id, round_id: d.round_id, game_code: d.game,
                    transaction_id: d.transaction_id, amount: d.amount,
                })
            case 'jackpot':
                return AtlasVWalletService.processJackpot({
                    player_id: d.player_id, round_id: d.round_id, game_code: d.game,
                    transaction_id: d.transaction_id, amount: d.amount,
                })
            default:
                return fail()
        }
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/test/atlasv-wallet.test.ts`
Expected: PASS (15 tests total)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/atlasv-wallet.service.ts apps/api/src/test/atlasv-wallet.test.ts
git commit -m "feat(api): Atlas-V wallet service — betwin, result, freespin, jackpot, dispatch"
```

---

### Task 6: Inbound callback routes + hub-forward helper + spoke sink

**Files:**
- Create: `apps/api/src/routes/atlasv/callback-helper.ts`
- Create: `apps/api/src/routes/atlasv/callback.ts`
- Create: `apps/api/src/routes/hub/atlasv-spoke-callback.ts`
- Modify: `apps/api/src/index.ts`
- Test: `apps/api/src/test/atlasv-callback.test.ts`
- Test: `apps/api/src/test/atlasv-spoke-callback.test.ts`

**Interfaces:**
- Consumes: `AtlasVWalletService.dispatch` (Task 5), `verifyAtlasVBody` (Task 2), `decideCallbackRoute` (`../../gateways/hub/route-callback.js`, existing), `signBody`/`verifySignature`/`DEPLOYMENT_HEADER`/`SIGNATURE_HEADER` (`../../gateways/hub/hub-auth.js`, existing), `deploymentConfig` (`../../gateways/hub/deployment-config.js`, existing).
- Produces: `atlasVCallbackHandler(action: AtlasVAction)` returning a Fastify route handler; `atlasVCallbackRoutes` (Fastify plugin, mounted at `/v1/atlasv/callback`); `atlasVSpokeCallbackRoute` (Fastify plugin, mounted at `/v1/hub/atlasv-spoke-callback`).

- [ ] **Step 1: Write the failing route tests**

Create `apps/api/src/test/atlasv-callback.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../services/atlasv-wallet.service.js', () => ({
    AtlasVWalletService: { dispatch: vi.fn(async (action: string, d: any) => ({ player_id: d.player_id, balance: 42 })) },
}))

vi.stubEnv('ATLASV_PRIVATE_KEY', 'test-key')

import { signAtlasVBody } from '../gateways/game-provider/atlasv-signature.js'
import { AtlasVWalletService } from '../services/atlasv-wallet.service.js'

beforeEach(() => {
    process.env.DEPLOYMENT_ROLE = 'standalone'
})

async function buildApp() {
    const app = Fastify()
    const { atlasVCallbackRoutes } = await import('../routes/atlasv/callback.js')
    await app.register(atlasVCallbackRoutes, { prefix: '/v1/atlasv/callback' })
    return app
}

describe('Atlas-V callback routes', () => {
    beforeEach(() => vi.clearAllMocks())

    it('accepts a correctly signed /bet callback and dispatches it', async () => {
        const app = await buildApp()
        const body = signAtlasVBody({
            game: 'penalty', casino_id: 'c1', player_id: 'p1'.padEnd(32, '0'),
            session_id: 's1', amount: 10, currency: 'ETB', round_id: 'r1',
            transaction_id: 't1', details: '',
        })

        const res = await app.inject({
            method: 'POST',
            url: '/v1/atlasv/callback/bet',
            headers: { 'content-type': 'text/javascript' },
            payload: body,
        })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ player_id: body.player_id, balance: 42 })
        expect(AtlasVWalletService.dispatch).toHaveBeenCalledWith('bet', expect.objectContaining({ player_id: body.player_id }))
    })

    it('rejects a tampered payload without dispatching', async () => {
        const app = await buildApp()
        const body = signAtlasVBody({ game: 'penalty', casino_id: 'c1', player_id: 'p1', session_id: 's1' })
        const tampered = { ...body, player_id: 'someone-else' }

        const res = await app.inject({
            method: 'POST',
            url: '/v1/atlasv/callback/account',
            headers: { 'content-type': 'text/javascript' },
            payload: tampered,
        })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ success: false })
        expect(AtlasVWalletService.dispatch).not.toHaveBeenCalled()
    })
})
```

Create `apps/api/src/test/atlasv-spoke-callback.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { signBody } from '../gateways/hub/hub-auth.js'
import { resetDeploymentConfigForTests } from '../gateways/hub/deployment-config.js'

vi.mock('../services/atlasv-wallet.service.js', () => ({
    AtlasVWalletService: {
        dispatch: vi.fn(async (action: string, d: any) => ({ player_id: d.player_id, balance: 12.5 })),
    },
}))

const SECRET = 'sec1'
beforeEach(() => {
    process.env.DEPLOYMENT_ROLE = 'spoke'
    process.env.DEPLOYMENT_CODE = 's01'
    process.env.HUB_URL = 'https://hub'
    process.env.HUB_SHARED_SECRET = SECRET
    resetDeploymentConfigForTests()
})

async function buildApp() {
    const app = Fastify()
    const { atlasVSpokeCallbackRoute } = await import('../routes/hub/atlasv-spoke-callback.js')
    await app.register(atlasVSpokeCallbackRoute, { prefix: '/v1/hub/atlasv-spoke-callback' })
    return app
}

describe('atlasv-spoke-callback sink', () => {
    it('accepts a correctly signed bet callback', async () => {
        const app = await buildApp()
        const body = JSON.stringify({ action: 'bet', data: { player_id: 'a'.repeat(32) } })
        const res = await app.inject({
            method: 'POST',
            url: '/v1/hub/atlasv-spoke-callback',
            headers: { 'content-type': 'application/json', 'x-deployment': 'h00', 'x-signature': signBody(SECRET, body) },
            payload: body,
        })
        expect(res.statusCode).toBe(200)
        expect(res.json()).toMatchObject({ player_id: 'a'.repeat(32), balance: 12.5 })
    })

    it('rejects a bad signature with 401', async () => {
        const app = await buildApp()
        const body = JSON.stringify({ action: 'bet', data: { player_id: 'a'.repeat(32) } })
        const res = await app.inject({
            method: 'POST',
            url: '/v1/hub/atlasv-spoke-callback',
            headers: { 'content-type': 'application/json', 'x-deployment': 'h00', 'x-signature': 'deadbeef' },
            payload: body,
        })
        expect(res.statusCode).toBe(401)
    })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/test/atlasv-callback.test.ts src/test/atlasv-spoke-callback.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement the callback helper**

Create `apps/api/src/routes/atlasv/callback-helper.ts`:

```ts
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AtlasVWalletService, type AtlasVAction, type AtlasVResponse } from '../../services/atlasv-wallet.service.js'
import { verifyAtlasVBody } from '../../gateways/game-provider/atlasv-signature.js'
import { deploymentConfig } from '../../gateways/hub/deployment-config.js'
import { decideCallbackRoute } from '../../gateways/hub/route-callback.js'
import { signBody, DEPLOYMENT_HEADER, SIGNATURE_HEADER } from '../../gateways/hub/hub-auth.js'

const SPOKE_FORWARD_TIMEOUT_MS = Number(process.env.ATLASV_SPOKE_TIMEOUT_MS ?? 5000)
const DEBUG = process.env.ATLASV_CALLBACK_DEBUG === 'true'

function fail(): AtlasVResponse {
    return { success: false }
}

/**
 * Builds a Fastify handler for one Atlas-V callback action. Verifies the
 * per-request signature, routes local-vs-forward-to-spoke on `player_id`
 * (same mechanism as routes/palace/callback.ts, keyed on Atlas-V's own field
 * name), and always answers HTTP 200 — Atlas-V is assumed to retry on
 * anything else, same as Palace/GASea.
 */
export function atlasVCallbackHandler(action: AtlasVAction) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
        const body = (req.body ?? {}) as Record<string, any>
        req.log.info({ action, body }, '[Atlas-V] callback received')

        if (!verifyAtlasVBody(body)) {
            if (DEBUG) req.log.warn({ action, body }, '[Atlas-V] signature verification failed')
            return reply.status(200).send(fail())
        }

        const d = { ...body }
        const cfg = deploymentConfig()
        if (cfg.role === 'hub' && typeof d.player_id === 'string') {
            const route = decideCallbackRoute(cfg, d.player_id)
            if (route.kind === 'forward') {
                const forwardBody = JSON.stringify({ action, data: { ...d, player_id: route.account } })
                const sig = signBody(route.spoke.secret, forwardBody)
                try {
                    const controller = new AbortController()
                    const timer = setTimeout(() => controller.abort(), SPOKE_FORWARD_TIMEOUT_MS)
                    let res: Response
                    try {
                        res = await fetch(`${route.spoke.baseUrl}/v1/hub/atlasv-spoke-callback`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'x-request-id': String(req.id),
                                [DEPLOYMENT_HEADER]: cfg.code,
                                [SIGNATURE_HEADER]: sig,
                            },
                            body: forwardBody,
                            signal: controller.signal,
                        })
                    } finally {
                        clearTimeout(timer)
                    }
                    if (!res.ok) {
                        req.log.error({ spoke: route.spoke.code, action, httpStatus: res.status }, '[Atlas-V] spoke forward returned non-200')
                        return reply.status(200).send(fail())
                    }
                    const relayed = await res.json()
                    return reply.status(200).send(relayed)
                } catch (err) {
                    req.log.error({ err, spoke: route.spoke.code, action }, '[Atlas-V] spoke forward failed')
                    return reply.status(200).send(fail())
                }
            }
            if (route.kind === 'local') {
                d.player_id = route.account
            }
            // 'unknown' — fall through with the raw player_id; the wallet
            // service's resolveUser returns its not-found shape.
        }

        try {
            const result = await AtlasVWalletService.dispatch(action, d)
            req.log.info({ action, result }, '[Atlas-V] callback handled')
            return reply.status(200).send(result)
        } catch (err) {
            req.log.error({ err, action }, '[Atlas-V] unhandled error in callback handler')
            return reply.status(200).send(fail())
        }
    }
}
```

- [ ] **Step 4: Implement the callback routes plugin**

Create `apps/api/src/routes/atlasv/callback.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify'
import { atlasVCallbackHandler } from './callback-helper.js'

/**
 * Atlas-V inbound wallet callbacks. Mounted under /v1/atlasv/callback
 * (configured in index.ts). One URL per action, unlike Palace's single
 * command-dispatch endpoint — see
 * docs/superpowers/specs/2026-09-09-atlasv-integration-design.md.
 */
export const atlasVCallbackRoutes: FastifyPluginAsync = async (fastify) => {
    // Atlas-V's doc mandates Content-Type: text/javascript on every request;
    // also accept application/json in case their staging client sends that.
    const parseJson = (_req: any, body: string, done: (err: Error | null, body?: any) => void) => {
        try {
            done(null, JSON.parse(body))
        } catch (e) {
            done(e as Error, undefined)
        }
    }
    fastify.addContentTypeParser('text/javascript', { parseAs: 'string' }, parseJson)
    fastify.addContentTypeParser('application/json', { parseAs: 'string' }, parseJson)

    fastify.post('/account', atlasVCallbackHandler('account'))
    fastify.post('/bet', atlasVCallbackHandler('bet'))
    fastify.post('/betwin', atlasVCallbackHandler('betwin'))
    fastify.post('/result', atlasVCallbackHandler('result'))
    fastify.post('/rollback', atlasVCallbackHandler('rollback'))
    fastify.post('/freespin', atlasVCallbackHandler('freespin'))
    fastify.post('/jackpot', atlasVCallbackHandler('jackpot'))
}
```

- [ ] **Step 5: Implement the spoke sink**

Create `apps/api/src/routes/hub/atlasv-spoke-callback.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify'
import { AtlasVWalletService } from '../../services/atlasv-wallet.service.js'
import { deploymentConfig } from '../../gateways/hub/deployment-config.js'
import { verifySignature, DEPLOYMENT_HEADER, SIGNATURE_HEADER } from '../../gateways/hub/hub-auth.js'

/**
 * Spoke-side sink for hub-forwarded Atlas-V callbacks. The player_id is
 * already de-namespaced by the hub. Authenticated by the hub's HMAC over the
 * raw body — same shape as routes/hub/spoke-callback.ts, kept as a separate
 * file because Atlas-V's callback envelope (`{ action, data }`, keyed on
 * `player_id`) differs from Palace's (`{ command, data }`, keyed on `account`).
 */
export const atlasVSpokeCallbackRoute: FastifyPluginAsync = async (fastify) => {
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
            return reply.status(401).send({ success: false })
        }

        const { action, data: d = {} } = req.body as { action?: string; data?: Record<string, any> }
        req.log.info({ callingHub: dep, action }, '[Hub] atlasv-spoke-callback received')
        try {
            return reply.status(200).send(await AtlasVWalletService.dispatch(action as any, d))
        } catch (err) {
            req.log.error({ err, action, callingHub: dep }, '[Hub] atlasv-spoke-callback dispatch failed')
            return reply.status(200).send({ success: false })
        }
    })
}
```

- [ ] **Step 6: Register the new routes in `index.ts`**

Add the imports near the existing Palace/hub imports:

```ts
import { atlasVCallbackRoutes } from './routes/atlasv/callback.js'
import { atlasVSpokeCallbackRoute } from './routes/hub/atlasv-spoke-callback.js'
```

Replace this block:

```ts
await server.register(aggregatorWalletRoutes, { prefix: '/v1/aggregator/wallet' })
await server.register(palaceCallbackRoute, { prefix: '/v1/palace/callback' })
await server.register(zarecashWebhookRoute, { prefix: '/v1/zarecash/webhook' })
if (deploymentConfig().role === 'spoke') {
    await server.register(spokeCallbackRoute, { prefix: '/v1/hub/spoke-callback' })
}
```

with:

```ts
await server.register(aggregatorWalletRoutes, { prefix: '/v1/aggregator/wallet' })
await server.register(palaceCallbackRoute, { prefix: '/v1/palace/callback' })
await server.register(atlasVCallbackRoutes, { prefix: '/v1/atlasv/callback' })
await server.register(zarecashWebhookRoute, { prefix: '/v1/zarecash/webhook' })
if (deploymentConfig().role === 'spoke') {
    await server.register(spokeCallbackRoute, { prefix: '/v1/hub/spoke-callback' })
    await server.register(atlasVSpokeCallbackRoute, { prefix: '/v1/hub/atlasv-spoke-callback' })
}
```

- [ ] **Step 7: Run to verify pass**

Run: `pnpm vitest run src/test/atlasv-callback.test.ts src/test/atlasv-spoke-callback.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 8: Typecheck and run the full suite**

Run (from `apps/api/`): `pnpm exec tsc --noEmit && pnpm test`
Expected: no type errors; no new test failures (pre-existing unrelated failures noted in memory are expected and not introduced by this change — see the "Quality gates" note in Task 8)

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/routes/atlasv apps/api/src/routes/hub/atlasv-spoke-callback.ts apps/api/src/index.ts apps/api/src/test/atlasv-callback.test.ts apps/api/src/test/atlasv-spoke-callback.test.ts
git commit -m "feat(api): Atlas-V inbound wallet callback routes + hub/spoke forwarding"
```

---

### Task 7: Admin freespin-grant route

**Files:**
- Create: `apps/api/src/routes/admin/atlasv.ts`
- Modify: `apps/api/src/routes/admin/index.ts`
- Test: `apps/api/src/test/atlasv-admin-freespins.test.ts`

**Interfaces:**
- Consumes: `AtlasVGateway.createFreeSpins` (Task 3, via `getGameProviderGateway('atlasv')`), `accountForLaunch` (`../game-provider/account-for-launch.js`, existing — same UUID-hex + hub-namespacing convention used at launch time).
- Produces: `POST /admin/game-providers/atlasv/freespins`, body `{ userId: string (uuid), endDate: string, freespinsCount: number }` → `{ success: true }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/test/atlasv-admin-freespins.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../lib/prisma.js', () => ({ default: { user: { findUnique: vi.fn() } } }))

const mockCreateFreeSpins = vi.fn()
vi.mock('../gateways/game-provider/index.js', () => ({
    getGameProviderGateway: vi.fn(() => ({ createFreeSpins: mockCreateFreeSpins })),
}))

import prisma from '../lib/prisma.js'
const p = prisma as any

async function buildApp() {
    const app = Fastify()
    const { default: atlasVAdminRoutes } = await import('../routes/admin/atlasv.js')
    await app.register(atlasVAdminRoutes, { prefix: '/admin/game-providers/atlasv' })
    return app
}

describe('POST /admin/game-providers/atlasv/freespins', () => {
    beforeEach(() => vi.clearAllMocks())

    it('grants freespins for an existing user', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
        mockCreateFreeSpins.mockResolvedValue(undefined)

        const app = await buildApp()
        const res = await app.inject({
            method: 'POST',
            url: '/admin/game-providers/atlasv/freespins',
            payload: { userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', endDate: '2026-12-14T11:55:00+00:00', freespinsCount: 5 },
        })

        expect(res.statusCode).toBe(200)
        expect(res.json()).toEqual({ success: true })
        expect(mockCreateFreeSpins).toHaveBeenCalledWith('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2026-12-14T11:55:00+00:00', 5)
    })

    it('404s for an unknown user', async () => {
        p.user.findUnique.mockResolvedValue(null)
        const app = await buildApp()
        const res = await app.inject({
            method: 'POST',
            url: '/admin/game-providers/atlasv/freespins',
            payload: { userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', endDate: '2026-12-14T11:55:00+00:00', freespinsCount: 5 },
        })
        expect(res.statusCode).toBe(404)
    })

    it('400s on an invalid body', async () => {
        const app = await buildApp()
        const res = await app.inject({
            method: 'POST',
            url: '/admin/game-providers/atlasv/freespins',
            payload: { userId: 'not-a-uuid', endDate: '2026-12-14T11:55:00+00:00', freespinsCount: 5 },
        })
        expect(res.statusCode).toBe(400)
    })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/test/atlasv-admin-freespins.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/admin/atlasv.ts`:

```ts
import { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import prisma from '../../lib/prisma.js'
import { getGameProviderGateway } from '../../gateways/game-provider/index.js'
import { accountForLaunch } from '../game-provider/account-for-launch.js'

const grantFreespinsSchema = z.object({
    userId: z.string().uuid(),
    endDate: z.string(), // ISO 8601, e.g. "2026-12-14T11:55:00+00:00"
    freespinsCount: z.number().int().positive(),
})

// Registered inside the requireAdmin sub-plugin in ./index.ts — no extra auth here.
const atlasVAdminRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.post('/freespins', async (req: any, reply) => {
        const parsed = grantFreespinsSchema.safeParse(req.body)
        if (!parsed.success) return reply.status(400).send({ error: 'Invalid body', details: parsed.error.issues })

        const { userId, endDate, freespinsCount } = parsed.data
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
        if (!user) return reply.status(404).send({ error: 'User not found' })

        const gateway = getGameProviderGateway('atlasv') as any
        const playerId = accountForLaunch(userId.replace(/-/g, ''))
        try {
            await gateway.createFreeSpins(playerId, endDate, freespinsCount)
        } catch (err: any) {
            req.log.error({ err, userId, freespinsCount }, '[Atlas-V] freespin grant failed')
            return reply.status(502).send({ error: 'Atlas-V freespin grant failed', message: err?.message })
        }
        return { success: true }
    })
}

export default atlasVAdminRoutes
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run src/test/atlasv-admin-freespins.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Register the route in `routes/admin/index.ts`**

In `apps/api/src/routes/admin/index.ts`, replace:

```ts
import analyticsRoutes from './analytics'
import crmRoutes, { isBadRules, ruleErrorMessage } from './crm'
```

with:

```ts
import analyticsRoutes from './analytics'
import crmRoutes, { isBadRules, ruleErrorMessage } from './crm'
import atlasVAdminRoutes from './atlasv'
```

And replace:

```ts
        // ── Player CRM (segments, metrics, CSV export) ────────────────────────
        await f.register(crmRoutes, { prefix: '/crm' })
```

with:

```ts
        // ── Player CRM (segments, metrics, CSV export) ────────────────────────
        await f.register(crmRoutes, { prefix: '/crm' })

        // ── Atlas-V game provider (freespin grants) ────────────────────────────
        await f.register(atlasVAdminRoutes, { prefix: '/game-providers/atlasv' })
```

- [ ] **Step 6: Typecheck**

Run (from `apps/api/`): `pnpm exec tsc --noEmit`
Expected: no type errors

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/admin/atlasv.ts apps/api/src/routes/admin/index.ts apps/api/src/test/atlasv-admin-freespins.test.ts
git commit -m "feat(api): admin route to grant Atlas-V freespins"
```

---

### Task 8: Full verification pass + design doc amendment

**Files:**
- Modify: `docs/superpowers/specs/2026-09-09-atlasv-integration-design.md` (one amendment note)

**Interfaces:** none new — this task only verifies and documents.

- [ ] **Step 1: Run the full API test suite and typecheck**

Run (from `apps/api/`): `pnpm exec tsc --noEmit && pnpm test`
Expected: all `atlasv*` test files pass; no NEW failures relative to the pre-existing baseline (per project memory, the api suite already carries ~21 environmental failures unrelated to this work — grep the output for `atlasv` and for the specific files touched, don't trust the raw exit code alone).

- [ ] **Step 2: Run lint on the touched files**

Run (from `apps/api/`): `pnpm exec eslint src/gateways/game-provider/atlasv.gateway.ts src/gateways/game-provider/atlasv-signature.ts src/services/atlasv-wallet.service.ts src/routes/atlasv/callback.ts src/routes/atlasv/callback-helper.ts src/routes/hub/atlasv-spoke-callback.ts src/routes/admin/atlasv.ts`
Expected: no errors (warnings acceptable if they match pre-existing patterns elsewhere in the codebase)

- [ ] **Step 3: Amend the design doc's catalog-sync decision to match the actual implementation**

In `docs/superpowers/specs/2026-09-09-atlasv-integration-design.md`, the "Catalog-sync worker" row of the Decisions table currently describes a `catalogSyncSupported` TypeScript interface property. The actual implementation (Task 3) uses `GameProvider.config.catalogSync === false` instead — simpler, and doesn't require touching `PalaceGateway`/`GaseaGateway`/`RemoteGameProviderGateway`. Update that row to:

```
| Catalog-sync worker | `GameProvider.config` JSON field carries `{ catalogSync: false }` for Atlas-V; `GameCatalogService.syncAll` checks it before calling the gateway | Simpler than a `GameProviderGateway` interface property — reuses the `config: Json?` column that already exists for exactly this kind of per-provider blob, and needs no change to `PalaceGateway`/`GaseaGateway`/`RemoteGameProviderGateway` |
```

- [ ] **Step 4: Commit the doc amendment**

```bash
git add docs/superpowers/specs/2026-09-09-atlasv-integration-design.md
git commit -m "docs(plan): amend Atlas-V catalog-sync-skip decision to match implementation"
```

- [ ] **Step 5: Manual staging verification checklist (once real Atlas-V staging credentials are available)**

Not automatable without live credentials — record results here or in a follow-up note when run:

1. Fill in `ATLASV_SERVER_URL`, `ATLASV_GAME_SERVER_URL`, `ATLASV_PRIVATE_KEY`, `ATLASV_CASINO_ID`, `ATLASV_PARTNER_ID` in `apps/api/.env`.
2. `pnpm db:seed` — confirm the Atlas-V provider/vendor/`penalty` game rows exist (`pnpm db:studio`).
3. `pnpm dev` — hit `GET /providers/atlasv/games` and confirm `penalty` appears (proves the generic catalog read path works with zero frontend changes).
4. As a logged-in test player in the web app, launch `penalty` from the lobby — confirm `POST /providers/atlasv/games/penalty/launch` returns a `gameUrl` and the iframe loads.
5. Watch the API logs for the first real inbound callback (`/v1/atlasv/callback/account` or `/bet`) — if `[Atlas-V] signature verification failed` appears, set `ATLASV_CALLBACK_DEBUG=true` and compare the logged raw body against the expected hash to correct the canonicalization in `verifyAtlasVBody` (see design doc Risk #1).
6. Confirm a real bet debits the wallet and a `ThirdPartyTransaction` row appears with `providerId` pointing at the `atlasv` provider.
