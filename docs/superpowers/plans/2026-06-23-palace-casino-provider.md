# Palace Casino Game Provider Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Palace Casino as a second slot/casino game provider alongside Gasea, using seamless wallet mode, with cross-provider dedup in catalog search and admin-controlled provider toggle + primary designation.

**Architecture:** A `PalaceGateway` class implements the existing `GameProviderGateway` interface for admin API calls (vendors/games/game URL/transactions). Palace callbacks (authenticate/balance/bet/win/cancel/status) are handled by a separate `PalaceWalletService` and mounted at `/v1/palace/callback`, authenticated via `Callback-Token` header comparison. Cross-provider dedup in `searchCatalog` sorts primary-provider results first and deduplicates by normalized `vendorName::gameName`. The admin API gains a `PATCH /providers/:id/primary` endpoint to set/unset the primary provider.

**Tech Stack:** Fastify v5, Prisma 5 + PostgreSQL, Redis, TypeScript, existing `ThirdPartyWalletService` patterns (lockWallet SELECT FOR UPDATE, ThirdPartyTransaction idempotency ledger, Transaction audit trail).

---

## Files

### New
- `apps/api/src/gateways/game-provider/palace.gateway.ts` — PalaceGateway implementing GameProviderGateway
- `apps/api/src/gateways/game-provider/palace-callback.middleware.ts` — Callback-Token auth preHandler
- `apps/api/src/services/palace-wallet.service.ts` — PalaceWalletService for callback commands
- `apps/api/src/routes/palace/callback.ts` — single POST route dispatching by Palace command

### Modified
- `apps/api/prisma/schema.prisma` — add `isPrimary` to GameProvider, add `ProviderUserAccount` model
- `apps/api/prisma/seed.ts` — add Palace provider seed
- `apps/api/src/gateways/game-provider/index.ts` — register PalaceGateway
- `apps/api/src/index.ts` — mount `/v1/palace` route prefix
- `apps/api/src/services/game-catalog.service.ts` — add cross-provider dedup in `searchCatalog`
- `apps/api/src/routes/admin/index.ts` — add `PATCH /providers/:id/primary` endpoint
- `apps/api/.env.example` — add PALACE_* vars

---

## Task 1: Schema — add isPrimary to GameProvider + ProviderUserAccount model

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

- [ ] **Step 1: Add `isPrimary` field and `ProviderUserAccount` model to schema**

In `apps/api/prisma/schema.prisma`, find the `GameProvider` model and add `isPrimary`:

```prisma
model GameProvider {
  id         String             @id @default(uuid())
  code       String             @unique
  name       String
  status     GameProviderStatus @default(ACTIVE)
  apiBaseUrl String
  currency   String             @default("ETB")
  isPrimary  Boolean            @default(false)          // ← add this line
  config     Json?
  createdAt  DateTime           @default(now())
  updatedAt  DateTime           @updatedAt
  vendors    GameVendor[]
  games      ProviderGame[]
  userAccounts ProviderUserAccount[]                     // ← add this line

  @@map("game_providers")
}
```

Then add this model after `ProviderGame`:

```prisma
model ProviderUserAccount {
  id               String       @id @default(uuid())
  providerId       String
  userId           String
  externalUserCode String                               // Palace's numeric user_code as string
  createdAt        DateTime     @default(now())
  provider         GameProvider @relation(fields: [providerId], references: [id], onDelete: Cascade)

  @@unique([providerId, userId])
  @@index([providerId])
  @@map("provider_user_accounts")
}
```

- [ ] **Step 2: Run migration**

```bash
cd apps/api
pnpm db:migrate
```

When prompted for a migration name, enter: `add_palace_provider`

Expected output: `✔ Generated Prisma Client` and `The following migration was created: .../add_palace_provider/migration.sql`

- [ ] **Step 3: Verify generated migration SQL looks sane**

```bash
cat apps/api/prisma/migrations/$(ls -t apps/api/prisma/migrations/ | head -1)/migration.sql
```

Should contain `ALTER TABLE "game_providers" ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false;` and `CREATE TABLE "provider_user_accounts" (...)`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat(db): add isPrimary to GameProvider and ProviderUserAccount model"
```

---

## Task 2: Palace Gateway — admin API (vendors, games, game URL, transactions)

**Files:**
- Create: `apps/api/src/gateways/game-provider/palace.gateway.ts`

- [ ] **Step 1: Write failing test**

Create `apps/api/src/test/palace-gateway.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

vi.stubEnv('PALACE_API_BASE_URL', 'https://palace.test')
vi.stubEnv('PALACE_API_TOKEN', 'test-token')

function jsonOk(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ code: 0, message: 'OK', data }) }
}

describe('PalaceGateway', () => {
  beforeEach(() => { mockFetch.mockReset() })

  it('getVendors maps provider list to Vendor[]', async () => {
    mockFetch.mockResolvedValue(jsonOk([
      { provider_id: 1, provider_name: 'Pragmatic Play', locale_name: 'Pragmatic Play', status: 1 },
    ]))
    const { PalaceGateway } = await import('../gateways/game-provider/palace.gateway.js')
    const gw = new PalaceGateway()
    const vendors = await gw.getVendors('ETB', 'en')
    expect(vendors).toEqual([
      { code: 'palace:1', name: 'Pragmatic Play', currencyCodes: ['ETB'], categoryCodes: ['SLOTS'] },
    ])
    expect(mockFetch).toHaveBeenCalledWith(
      'https://palace.test/v4/game/providers',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    )
  })

  it('getGames extracts provider_id from vendor code and returns GameListResult', async () => {
    mockFetch.mockResolvedValue(jsonOk([
      { provider_id: 1, game_code: 'vswaysdogs', game_name: 'Dog House', game_image: 'https://img', launch_enable: true, category: 'Slots', reg_date: '2022-01-01' },
    ]))
    const { PalaceGateway } = await import('../gateways/game-provider/palace.gateway.js')
    const gw = new PalaceGateway()
    const result = await gw.getGames('palace:1', 1, 100, 'ETB', 'en')
    expect(result.games).toHaveLength(1)
    expect(result.games[0]).toMatchObject({ gameCode: 'vswaysdogs', gameName: 'Dog House', categoryCode: 'SLOTS' })
    expect(result.totalPages).toBe(1)
  })

  it('getGameUrl calls /v4/game/game-url and returns gameUrl', async () => {
    // Mock user lookup + game URL (two calls)
    mockFetch
      .mockResolvedValueOnce(jsonOk({ game_url: 'https://game.url/launch' }))
    // We can't easily test user provisioning without DB; test the API call
    const { PalaceGateway } = await import('../gateways/game-provider/palace.gateway.js')
    const gw = new PalaceGateway()
    // Override getUserCode to avoid DB
    ;(gw as any).getUserCode = async () => '12345'
    const result = await gw.getGameUrl({
      username: 'testuser', gameCode: 'vswaysdogs', language: 'en',
      platform: 'WEB', currency: 'ETB', lobbyUrl: 'https://lobby', ipAddress: '1.2.3.4',
    })
    expect(result.gameUrl).toBe('https://game.url/launch')
  })

  it('throws on non-zero response code', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ code: 2002, message: 'USER_NOT_FOUND', data: null }) })
    const { PalaceGateway } = await import('../gateways/game-provider/palace.gateway.js')
    const gw = new PalaceGateway()
    await expect(gw.getVendors('ETB', 'en')).rejects.toThrow('Palace error: 2002')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @world-bingo/api test palace-gateway
```

Expected: FAIL with "Cannot find module '../gateways/game-provider/palace.gateway.js'"

- [ ] **Step 3: Implement palace.gateway.ts**

Create `apps/api/src/gateways/game-provider/palace.gateway.ts`:

```typescript
import prisma from '../../lib/prisma.js'
import type {
    GameProviderGateway,
    GameListResult,
    LaunchGameParams,
    TransactionDetail,
    TransactionListResult,
    Vendor,
} from './game-provider.interface.js'

const BASE_URL = (process.env.PALACE_API_BASE_URL ?? '').replace(/\/$/, '')
const API_TOKEN = process.env.PALACE_API_TOKEN ?? ''

async function request<T>(path: string, body: object): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_TOKEN}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Palace ${path} responded ${res.status}`)
    const json = (await res.json()) as { code: number; message: string; data?: T }
    if (json.code !== 0) throw new Error(`Palace error: ${json.code} — ${json.message}`)
    return json.data as T
}

/** lang code: Palace uses numeric lang (1=English by convention) */
function langCode(_language: string): number {
    return 1
}

export class PalaceGateway implements GameProviderGateway {
    readonly providerCode = 'palace'

    async getVendors(currency: string, language: string): Promise<Vendor[]> {
        const data = await request<Array<{
            provider_id: number
            provider_name: string
            status: number
        }>>('/v4/game/providers', { lang: langCode(language) })

        return data
            .filter((p) => p.status === 1)
            .map((p) => ({
                code: `palace:${p.provider_id}`,
                name: p.provider_name,
                currencyCodes: [currency],
                categoryCodes: ['SLOTS'],
            }))
    }

    async getGames(
        vendorCode: string,
        _page: number,
        _pageSize: number,
        _currency: string,
        language: string,
    ): Promise<GameListResult> {
        const providerId = parseInt(vendorCode.replace('palace:', ''), 10)
        if (isNaN(providerId)) throw new Error(`Invalid Palace vendor code: ${vendorCode}`)

        const data = await request<Array<{
            provider_id: number
            game_code: string
            game_name: string
            game_image: string | null
            launch_enable: boolean
            category: string
        }>>('/v4/game/games', { provider_id: providerId, lang: langCode(language) })

        const games = data
            .filter((g) => g.launch_enable)
            .map((g) => ({
                gameCode: g.game_code,
                gameName: g.game_name,
                categoryCode: (g.category ?? 'SLOTS').toUpperCase().replace(/\s+/g, '_'),
                imageSquare: g.game_image ?? null,
                imageLandscape: null,
                languageCodes: ['en', 'am'],
                platformCodes: ['WEB', 'H5'],
                currencyCodes: ['ETB'],
            }))

        return { games, currentPage: 1, totalItems: games.length, totalPages: 1 }
    }

    async getGameUrl(params: LaunchGameParams): Promise<{ gameUrl: string; token: string }> {
        const userCode = await this.getUserCode(params.username)
        const providerId = parseInt(params.gameCode.split(':')[0], 10) // game code is plain — provider_id from vendor
        // gameCode from DB is the raw Palace game_code (e.g. "vswaysdogs"); we need provider_id
        // Resolve provider_id via DB vendor lookup
        const realProviderId = await this.resolveProviderId(params.username, params.gameCode)

        const data = await request<{ game_url: string }>('/v4/game/game-url', {
            user_code: parseInt(userCode, 10),
            provider_id: realProviderId,
            game_symbol: params.gameCode,
            lang: langCode(params.language),
            return_url: params.lobbyUrl,
            win_ratio: 0,
        })

        return { gameUrl: data.game_url, token: '' }
    }

    async terminateSession(_username: string): Promise<void> {
        // Palace has no session termination endpoint in seamless mode
    }

    async getTransactions(fromTime: number, toTime: number, page: number): Promise<TransactionListResult> {
        const toDate = (ts: number) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19)
        const offset = (page - 1) * 1000

        const data = await request<{
            total: number
            list: Array<{
                trans_id: number
                user_code: number
                round_id: string
                trans_type: number
                provider_id: number
                provider_name: string
                game_code: string
                game_name: string
                prebalance: number
                trans_amount: number
                balance: number
                regdate: string
            }>
        }>('/v4/game/transaction', {
            start_time: toDate(fromTime),
            end_time: toDate(toTime),
            offset,
            limit: 1000,
        })

        const transactions = (data.list ?? []).map((t) => ({
            betId: String(t.trans_id),
            roundId: t.round_id,
            externalTransactionId: String(t.trans_id),
            username: String(t.user_code),
            currencyCode: 'ETB',
            gameCode: t.game_code,
            vendorCode: `palace:${t.provider_id}`,
            gameCategoryCode: 'SLOTS',
            betAmount: t.trans_type === 1 ? t.trans_amount : 0,
            winAmount: t.trans_type === 2 ? t.trans_amount : 0,
            winLoss: t.trans_type === 2 ? t.trans_amount : -t.trans_amount,
            effectiveTurnover: t.trans_type === 1 ? t.trans_amount : 0,
            jackpotAmount: 0,
            status: 1,
            vendorBetTime: new Date(t.regdate).getTime(),
            vendorSettleTime: new Date(t.regdate).getTime(),
            isFreeSpin: false,
            vendorBetId: String(t.trans_id),
        }))

        const totalPages = Math.ceil((data.total ?? 0) / 1000) || 1
        return { transactions, currentPage: page, totalItems: data.total ?? 0, totalPages }
    }

    async getTransactionDetail(betId: string, _fromTime: number, _toTime: number): Promise<TransactionDetail> {
        const data = await request<Array<{
            trans_id: number
            user_code: number
            round_id: string
            trans_type: number
            provider_id: number
            game_code: string
            prebalance: number
            trans_amount: number
            balance: number
            regdate: string
        }>>('/v4/game/transaction-id', { last_id: parseInt(betId, 10) - 1, limit: 1 })

        const t = data[0]
        if (!t) throw new Error(`Palace transaction ${betId} not found`)

        return {
            betId: String(t.trans_id),
            roundId: t.round_id,
            externalTransactionId: String(t.trans_id),
            username: String(t.user_code),
            currencyCode: 'ETB',
            gameCode: t.game_code,
            vendorCode: `palace:${t.provider_id}`,
            gameCategoryCode: 'SLOTS',
            betAmount: t.trans_type === 1 ? t.trans_amount : 0,
            winAmount: t.trans_type === 2 ? t.trans_amount : 0,
            winLoss: t.trans_type === 2 ? t.trans_amount : -t.trans_amount,
            effectiveTurnover: t.trans_type === 1 ? t.trans_amount : 0,
            jackpotAmount: 0,
            refundAmount: 0,
            status: 1,
            vendorBetTime: new Date(t.regdate).getTime(),
            vendorSettleTime: new Date(t.regdate).getTime(),
            isFreeSpin: false,
            vendorBetId: String(t.trans_id),
        }
    }

    /** Lazily provision or retrieve Palace user_code for a given username. */
    async getUserCode(username: string): Promise<string> {
        const provider = await prisma.gameProvider.findUnique({ where: { code: 'palace' } })
        if (!provider) throw new Error("Palace provider not seeded in DB")

        const user = await prisma.user.findUnique({ where: { username }, select: { id: true } })
        if (!user) throw new Error(`User not found: ${username}`)

        const existing = await prisma.providerUserAccount.findUnique({
            where: { providerId_userId: { providerId: provider.id, userId: user.id } },
        })
        if (existing) return existing.externalUserCode

        const data = await request<{ user_code: number }>('/v4/user/create', { name: username })
        await prisma.providerUserAccount.create({
            data: { providerId: provider.id, userId: user.id, externalUserCode: String(data.user_code) },
        })
        return String(data.user_code)
    }

    /** Resolve Palace provider_id from a game code stored in DB (via the vendor relationship). */
    private async resolveProviderId(username: string, gameCode: string): Promise<number> {
        const provider = await prisma.gameProvider.findUnique({ where: { code: 'palace' } })
        if (!provider) throw new Error("Palace provider not seeded")

        const game = await prisma.providerGame.findUnique({
            where: { providerId_gameCode: { providerId: provider.id, gameCode } },
            include: { vendor: true },
        })
        if (!game) throw new Error(`Palace game not found in DB: ${gameCode}`)

        // vendor.code = 'palace:{provider_id}'
        const providerId = parseInt(game.vendor.code.replace('palace:', ''), 10)
        if (isNaN(providerId)) throw new Error(`Invalid vendor code for game ${gameCode}: ${game.vendor.code}`)
        return providerId
    }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @world-bingo/api test palace-gateway
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/gateways/game-provider/palace.gateway.ts apps/api/src/test/palace-gateway.test.ts
git commit -m "feat(palace): add PalaceGateway implementing GameProviderGateway"
```

---

## Task 3: Palace Callback Auth Middleware

**Files:**
- Create: `apps/api/src/gateways/game-provider/palace-callback.middleware.ts`

- [ ] **Step 1: Create middleware**

```typescript
import crypto from 'node:crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'

let _token: string | null = null

function getCallbackToken(): string {
    if (!_token) {
        const t = (process.env.PALACE_CALLBACK_TOKEN ?? '').trim()
        if (!t) console.warn('[Palace] WARNING: PALACE_CALLBACK_TOKEN is empty')
        else _token = t
        return t
    }
    return _token
}

function palaceError(result: number, status: string) {
    return { result, status, data: null }
}

export async function verifyPalaceCallbackToken(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<void> {
    const received = request.headers['callback-token']
    if (!received || typeof received !== 'string') {
        request.log.warn('[Palace] Missing Callback-Token header on %s', request.url)
        return reply.status(200).send(palaceError(1007, 'TOKEN_NOT_FOUND'))
    }

    const expected = getCallbackToken()
    if (!expected) {
        return reply.status(200).send(palaceError(1001, 'INTERNAL_SERVER_ERROR'))
    }

    // Constant-time comparison (tokens may differ in length, so pad to max)
    const a = Buffer.from(received.padEnd(256))
    const b = Buffer.from(expected.padEnd(256))
    const same = a.length === b.length && crypto.timingSafeEqual(a, b) && received === expected

    if (!same) {
        request.log.warn('[Palace] Invalid Callback-Token on %s', request.url)
        return reply.status(200).send(palaceError(1009, 'TOKEN_INVALID'))
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/gateways/game-provider/palace-callback.middleware.ts
git commit -m "feat(palace): add Callback-Token verification middleware"
```

---

## Task 4: PalaceWalletService — callback command handler

**Files:**
- Create: `apps/api/src/services/palace-wallet.service.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/api/src/test/palace-wallet.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma.js', () => ({
    default: {
        gameProvider: { findUnique: vi.fn() },
        wallet: { findUnique: vi.fn(), update: vi.fn() },
        thirdPartyTransaction: { findUnique: vi.fn(), create: vi.fn() },
        transaction: { create: vi.fn() },
        user: { findUnique: vi.fn() },
        $transaction: vi.fn(),
        $queryRaw: vi.fn(),
    },
}))

vi.mock('../lib/redis.js', () => ({ default: { get: vi.fn().mockResolvedValue(null), setex: vi.fn() } }))

import prisma from '../lib/prisma.js'
const p = prisma as any

describe('PalaceWalletService', () => {
    beforeEach(() => vi.clearAllMocks())

    it('getBalance returns USER_NOT_FOUND for unknown account', async () => {
        p.user.findUnique.mockResolvedValue(null)
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.getBalance('nobody')
        expect(res).toEqual({ result: 2002, status: 'USER_NOT_FOUND', data: null })
    })

    it('getBalance returns balance for known user', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '100.00', bonusBalance: '50.00' })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.getBalance('alice')
        expect(res.result).toBe(0)
        expect((res.data as any).balance).toBe(150)
    })

    it('processBet returns BALANCE_NOT_ENOUGH when wallet is insufficient', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        p.$transaction.mockRejectedValue({ code: 'BALANCE_NOT_ENOUGH' })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '10.00', bonusBalance: '0.00' })
        p.thirdPartyTransaction.create.mockResolvedValue({})
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.processBet({
            trans_guid: 'tg1', account: 'alice', gplay_id: 'gp1',
            round_id: 'r1', game_code: 'game1', amount: 100,
        })
        expect(res).toEqual({ result: 2006, status: 'BALANCE_NOT_ENOUGH', data: null })
    })

    it('processBet is idempotent on duplicate trans_guid', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue({
            status: 'COMPLETED', balanceAfter: '90.00',
        })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.processBet({
            trans_guid: 'tg1', account: 'alice', gplay_id: 'gp1',
            round_id: 'r1', game_code: 'game1', amount: 10,
        })
        expect(res.result).toBe(0)
        expect((res.data as any).balance).toBe(90)
        expect(p.$transaction).not.toHaveBeenCalled()
    })
})
```

- [ ] **Step 2: Run to verify fail**

```bash
pnpm --filter @world-bingo/api test palace-wallet
```

Expected: FAIL with "Cannot find module '../services/palace-wallet.service.js'"

- [ ] **Step 3: Implement PalaceWalletService**

Create `apps/api/src/services/palace-wallet.service.ts`:

```typescript
import { Decimal } from '@prisma/client/runtime/library'
import prisma from '../lib/prisma.js'
import redis from '../lib/redis.js'
import { TransactionType, PaymentStatus, ThirdPartyTxType, ThirdPartyTxStatus } from '@world-bingo/shared-types'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PalaceResponse {
    result: number
    status: string
    data: object | null
}

interface BetParams {
    trans_guid: string
    account: string
    gplay_id: string
    round_id: string
    game_code: string
    amount: number
}

interface WinParams extends BetParams {
    type: number  // 2=Win, 32=BonusCallWin
}

interface CancelParams extends BetParams {
    cancle_trans_guid: string  // original bet's trans_guid (Palace typo preserved)
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PROVIDER_CODE = 'palace'
const CURRENCY = process.env.PALACE_CURRENCY ?? 'ETB'
const USER_CACHE_TTL = 3600

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _providerId: string | null = null

async function getPalaceProviderId(): Promise<string> {
    if (_providerId) return _providerId
    const provider = await prisma.gameProvider.findUnique({ where: { code: PROVIDER_CODE } })
    if (!provider) throw new Error(`Provider '${PROVIDER_CODE}' not seeded in DB`)
    _providerId = provider.id
    return _providerId
}

function ok(data: object): PalaceResponse {
    return { result: 0, status: 'OK', data }
}

function palaceErr(code: number, status: string): PalaceResponse {
    return { result: code, status, data: null }
}

async function resolveUser(account: string): Promise<{ id: string; isActive: boolean } | null> {
    const cacheKey = `tp:user:${account}`
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    let user: { id: string; isActive: boolean } | null = null

    // GASea-style: 32-char hex = UUID without dashes
    if (/^[0-9a-f]{32}$/i.test(account)) {
        const id = `${account.slice(0, 8)}-${account.slice(8, 12)}-${account.slice(12, 16)}-${account.slice(16, 20)}-${account.slice(20)}`
        user = await prisma.user.findUnique({ where: { id }, select: { id: true, isActive: true } })
    } else {
        user = await prisma.user.findUnique({ where: { username: account }, select: { id: true, isActive: true } })
    }

    if (user) await redis.setex(cacheKey, USER_CACHE_TTL, JSON.stringify(user))
    return user
}

type WalletRow = { id: string; realBalance: Decimal; bonusBalance: Decimal }

async function lockWallet(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    userId: string,
): Promise<WalletRow> {
    const rows = await tx.$queryRaw<WalletRow[]>`
        SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
    `
    if (!rows[0]) throw { code: 'USER_NOT_FOUND' }
    return rows[0]
}

async function findExisting(transactionId: string) {
    const providerId = await getPalaceProviderId()
    return prisma.thirdPartyTransaction.findUnique({
        where: { providerId_transactionId: { providerId, transactionId } },
    })
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class PalaceWalletService {
    static async getBalance(account: string): Promise<PalaceResponse> {
        const user = await resolveUser(account)
        if (!user) return palaceErr(2002, 'USER_NOT_FOUND')
        if (!user.isActive) return palaceErr(2002, 'USER_NOT_FOUND')

        const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
        if (!wallet) return palaceErr(2002, 'USER_NOT_FOUND')

        const balance = new Decimal(wallet.realBalance).plus(new Decimal(wallet.bonusBalance))
        return ok({ balance: Number(balance.toFixed(2)) })
    }

    static async processBet(params: BetParams): Promise<PalaceResponse> {
        const user = await resolveUser(params.account)
        if (!user) return palaceErr(2002, 'USER_NOT_FOUND')
        if (!user.isActive) return palaceErr(2002, 'USER_NOT_FOUND')

        const existing = await findExisting(params.trans_guid)
        if (existing) {
            if (existing.status === ThirdPartyTxStatus.FAILED) return palaceErr(2006, 'BALANCE_NOT_ENOUGH')
            return ok({ balance: Number(new Decimal(existing.balanceAfter).toFixed(2)) })
        }

        try {
            const balanceAfter = await prisma.$transaction(async (tx) => {
                const wallet = await lockWallet(tx, user.id)
                const realBefore = new Decimal(wallet.realBalance)
                const bonusBefore = new Decimal(wallet.bonusBalance)
                const totalBefore = realBefore.plus(bonusBefore)
                const betAmount = new Decimal(params.amount).abs()

                if (totalBefore.lessThan(betAmount)) throw { code: 'BALANCE_NOT_ENOUGH' }

                let newReal = realBefore
                let newBonus = bonusBefore
                if (realBefore.greaterThanOrEqualTo(betAmount)) {
                    newReal = realBefore.minus(betAmount)
                } else {
                    newReal = new Decimal(0)
                    newBonus = bonusBefore.minus(betAmount.minus(realBefore))
                }
                const newTotal = newReal.plus(newBonus)

                await tx.wallet.update({
                    where: { userId: user.id },
                    data: { realBalance: newReal, bonusBalance: newBonus },
                })

                const providerId = await getPalaceProviderId()
                await tx.thirdPartyTransaction.create({
                    data: {
                        providerId,
                        userId: user.id,
                        transactionId: params.trans_guid,
                        betId: params.gplay_id,
                        roundId: params.round_id,
                        gameCode: params.game_code,
                        type: ThirdPartyTxType.BET,
                        status: ThirdPartyTxStatus.COMPLETED,
                        betAmount,
                        amount: betAmount.negated(),
                        balanceBefore: totalBefore,
                        balanceAfter: newTotal,
                        rawRequest: params as any,
                    },
                })

                await tx.transaction.create({
                    data: {
                        userId: user.id,
                        type: TransactionType.TP_BET,
                        amount: betAmount,
                        status: PaymentStatus.APPROVED,
                        note: `Palace bet: ${params.game_code} round ${params.round_id}`,
                        referenceId: params.trans_guid,
                        balanceBefore: totalBefore,
                        balanceAfter: newTotal,
                        bonusBalanceBefore: bonusBefore,
                        bonusBalanceAfter: newBonus,
                    },
                })

                return newTotal
            })

            return ok({ balance: Number(balanceAfter.toFixed(2)) })
        } catch (e: any) {
            if (e?.code === 'BALANCE_NOT_ENOUGH') {
                try {
                    const wallet = await prisma.wallet.findUnique({ where: { userId: user.id } })
                    const current = wallet
                        ? new Decimal(wallet.realBalance).plus(new Decimal(wallet.bonusBalance))
                        : new Decimal(0)
                    const providerId = await getPalaceProviderId()
                    await prisma.thirdPartyTransaction.create({
                        data: {
                            providerId,
                            userId: user.id,
                            transactionId: params.trans_guid,
                            betId: params.gplay_id,
                            roundId: params.round_id,
                            gameCode: params.game_code,
                            type: ThirdPartyTxType.BET,
                            status: ThirdPartyTxStatus.FAILED,
                            betAmount: new Decimal(params.amount).abs(),
                            amount: new Decimal(0),
                            balanceBefore: current,
                            balanceAfter: current,
                        },
                    })
                } catch { /* ignore duplicate */ }
                return palaceErr(2006, 'BALANCE_NOT_ENOUGH')
            }
            if (e?.code) return palaceErr(1001, 'INTERNAL_SERVER_ERROR')
            throw e
        }
    }

    static async processWin(params: WinParams): Promise<PalaceResponse> {
        const user = await resolveUser(params.account)
        if (!user) return palaceErr(2002, 'USER_NOT_FOUND')
        if (!user.isActive) return palaceErr(2002, 'USER_NOT_FOUND')

        const existing = await findExisting(params.trans_guid)
        if (existing) return ok({ balance: Number(new Decimal(existing.balanceAfter).toFixed(2)) })

        const balanceAfter = await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)
            const winAmount = new Decimal(params.amount).abs()
            const newReal = realBefore.plus(winAmount)
            const newTotal = newReal.plus(bonusBefore)

            await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })

            const providerId = await getPalaceProviderId()
            await tx.thirdPartyTransaction.create({
                data: {
                    providerId,
                    userId: user.id,
                    transactionId: params.trans_guid,
                    betId: params.gplay_id,
                    roundId: params.round_id,
                    gameCode: params.game_code,
                    type: ThirdPartyTxType.BET_RESULT,
                    status: ThirdPartyTxStatus.COMPLETED,
                    winAmount,
                    amount: winAmount,
                    balanceBefore: totalBefore,
                    balanceAfter: newTotal,
                    rawRequest: params as any,
                },
            })

            await tx.transaction.create({
                data: {
                    userId: user.id,
                    type: TransactionType.TP_WIN,
                    amount: winAmount,
                    status: PaymentStatus.APPROVED,
                    note: `Palace win: ${params.game_code} round ${params.round_id}`,
                    referenceId: params.trans_guid,
                    balanceBefore: totalBefore,
                    balanceAfter: newTotal,
                    bonusBalanceBefore: bonusBefore,
                    bonusBalanceAfter: bonusBefore,
                },
            })

            return newTotal
        })

        return ok({ balance: Number(balanceAfter.toFixed(2)) })
    }

    static async processCancel(params: CancelParams): Promise<PalaceResponse> {
        const user = await resolveUser(params.account)
        if (!user) return palaceErr(2002, 'USER_NOT_FOUND')
        if (!user.isActive) return palaceErr(2002, 'USER_NOT_FOUND')

        // Idempotency on the cancel's own trans_guid
        const existing = await findExisting(params.trans_guid)
        if (existing) return ok({ balance: Number(new Decimal(existing.balanceAfter).toFixed(2)) })

        const providerId = await getPalaceProviderId()

        // Find original bet to know amount to refund
        const originalBet = await prisma.thirdPartyTransaction.findUnique({
            where: { providerId_transactionId: { providerId, transactionId: params.cancle_trans_guid } },
        })

        const balanceAfter = await prisma.$transaction(async (tx) => {
            const wallet = await lockWallet(tx, user.id)
            const realBefore = new Decimal(wallet.realBalance)
            const bonusBefore = new Decimal(wallet.bonusBalance)
            const totalBefore = realBefore.plus(bonusBefore)

            // Refund the original bet amount; if not found, use the cancel amount
            const refundAmount = originalBet
                ? new Decimal(originalBet.betAmount ?? params.amount).abs()
                : new Decimal(params.amount).abs()

            const newReal = realBefore.plus(refundAmount)
            const newTotal = newReal.plus(bonusBefore)

            await tx.wallet.update({ where: { userId: user.id }, data: { realBalance: newReal } })

            await tx.thirdPartyTransaction.create({
                data: {
                    providerId,
                    userId: user.id,
                    transactionId: params.trans_guid,
                    betId: params.gplay_id,
                    roundId: params.round_id,
                    gameCode: params.game_code,
                    type: ThirdPartyTxType.ROLLBACK,
                    status: ThirdPartyTxStatus.COMPLETED,
                    amount: refundAmount,
                    balanceBefore: totalBefore,
                    balanceAfter: newTotal,
                    rawRequest: params as any,
                },
            })

            await tx.transaction.create({
                data: {
                    userId: user.id,
                    type: TransactionType.TP_ROLLBACK,
                    amount: refundAmount,
                    status: PaymentStatus.APPROVED,
                    note: `Palace cancel: ${params.game_code} round ${params.round_id}`,
                    referenceId: params.trans_guid,
                    balanceBefore: totalBefore,
                    balanceAfter: newTotal,
                    bonusBalanceBefore: bonusBefore,
                    bonusBalanceAfter: bonusBefore,
                },
            })

            return newTotal
        })

        return ok({ balance: Number(balanceAfter.toFixed(2)) })
    }

    static async getStatus(account: string, transGuid: string): Promise<PalaceResponse> {
        const providerId = await getPalaceProviderId()
        const tx = await prisma.thirdPartyTransaction.findUnique({
            where: { providerId_transactionId: { providerId, transactionId: transGuid } },
        })

        return ok({
            account,
            trans_guid: transGuid,
            trans_status: tx ? 'OK' : 'NOT_FOUND',
        })
    }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @world-bingo/api test palace-wallet
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/palace-wallet.service.ts apps/api/src/test/palace-wallet.test.ts
git commit -m "feat(palace): add PalaceWalletService for seamless callback commands"
```

---

## Task 5: Palace Callback Route

**Files:**
- Create: `apps/api/src/routes/palace/callback.ts`

- [ ] **Step 1: Create callback route**

Create `apps/api/src/routes/palace/callback.ts`:

```typescript
import type { FastifyPluginAsync } from 'fastify'
import { verifyPalaceCallbackToken } from '../../gateways/game-provider/palace-callback.middleware.js'
import { PalaceWalletService } from '../../services/palace-wallet.service.js'

/**
 * Palace Casino seamless wallet callback.
 * Palace sends a single POST to this URL with a JSON body containing { command, data, timestamp, check }.
 * Auth: Callback-Token header (constant token comparison).
 * All responses return HTTP 200 — Palace retries on non-200.
 *
 * Commands: authenticate, balance, bet, win, cancel, status
 */
const palaceCallbackRoute: FastifyPluginAsync = async (fastify) => {
    fastify.post('/', {
        preHandler: [verifyPalaceCallbackToken],
        handler: async (req) => {
            const body = req.body as {
                command: string
                data: Record<string, any>
                timestamp?: string
                check?: string
            }

            const { command, data } = body

            switch (command) {
                case 'authenticate':
                    return PalaceWalletService.getBalance(data.account)

                case 'balance':
                    return PalaceWalletService.getBalance(data.account)

                case 'bet':
                    return PalaceWalletService.processBet({
                        trans_guid: data.trans_guid,
                        account: data.account,
                        gplay_id: String(data.gplay_id ?? ''),
                        round_id: String(data.round_id ?? ''),
                        game_code: String(data.game_code ?? ''),
                        amount: Number(data.amount ?? 0),
                    })

                case 'win':
                    return PalaceWalletService.processWin({
                        trans_guid: data.trans_guid,
                        account: data.account,
                        gplay_id: String(data.gplay_id ?? ''),
                        round_id: String(data.round_id ?? ''),
                        game_code: String(data.game_code ?? ''),
                        amount: Number(data.amount ?? 0),
                        type: Number(data.type ?? 2),
                    })

                case 'cancel':
                    return PalaceWalletService.processCancel({
                        trans_guid: data.trans_guid,
                        account: data.account,
                        gplay_id: String(data.gplay_id ?? ''),
                        round_id: String(data.round_id ?? ''),
                        game_code: String(data.game_code ?? ''),
                        amount: Number(data.amount ?? 0),
                        cancle_trans_guid: String(data.cancle_trans_guid ?? data.trans_guid),
                    })

                case 'status':
                    return PalaceWalletService.getStatus(data.account, data.trans_guid)

                default:
                    req.log.warn('[Palace] Unknown command: %s', command)
                    return { result: 1012, status: 'PARAMETERS_INVALID', data: null }
            }
        },
    })
}

export default palaceCallbackRoute
```

- [ ] **Step 2: Commit**

```bash
git add apps/api/src/routes/palace/callback.ts
git commit -m "feat(palace): add Palace seamless callback route"
```

---

## Task 6: Register Gateway, Route, and Seed

**Files:**
- Modify: `apps/api/src/gateways/game-provider/index.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/prisma/seed.ts`
- Modify: `apps/api/.env.example`

- [ ] **Step 1: Register PalaceGateway in gateway registry**

In `apps/api/src/gateways/game-provider/index.ts`, add:

```typescript
import type { GameProviderGateway } from './game-provider.interface.js'
import { GaseaGateway } from './gasea.gateway.js'
import { PalaceGateway } from './palace.gateway.js'          // ← add

const registry = new Map<string, GameProviderGateway>()

export function registerGameProviderGateway(gateway: GameProviderGateway): void {
    registry.set(gateway.providerCode, gateway)
}

export function getGameProviderGateway(code: string): GameProviderGateway {
    const gw = registry.get(code)
    if (!gw) throw new Error(`Game provider gateway not found: ${code}`)
    return gw
}

export function listGameProviderGateways(): GameProviderGateway[] {
    return [...registry.values()]
}

// Register built-in providers
registerGameProviderGateway(new GaseaGateway())
registerGameProviderGateway(new PalaceGateway())              // ← add

export type { GameProviderGateway }
export * from './game-provider.interface.js'
```

- [ ] **Step 2: Mount Palace callback route in main index**

In `apps/api/src/index.ts`:

**a)** Add the import near line 28 (next to the aggregator import):
```typescript
import palaceCallbackRoute from './routes/palace/callback.js'
```

**b)** Add the rate-limit bypass near line 104 (next to the aggregator bypass):
```typescript
if (req.url.startsWith('/v1/palace/')) return true
```

**c)** Add the route registration near line 222 (next to the aggregator registration):
```typescript
await server.register(palaceCallbackRoute, { prefix: '/v1/palace/callback' })
```

- [ ] **Step 3: Seed Palace provider in DB**

In `apps/api/prisma/seed.ts`, find the GASea provider upsert and add Palace after it:

```typescript
await prisma.gameProvider.upsert({
    where: { code: 'palace' },
    update: {},
    create: {
        code: 'palace',
        name: 'Palace Casino',
        status: 'ACTIVE',
        apiBaseUrl: process.env.PALACE_API_BASE_URL ?? '',
        currency: 'ETB',
        isPrimary: false,
        config: {},
    },
})
console.log('Palace Casino provider seeded')
```

- [ ] **Step 4: Add Palace env vars to .env.example**

In `apps/api/.env.example`, add after the Gasea block:

```bash
# Palace Casino game provider
PALACE_API_BASE_URL=""        # e.g. https://api.palacecasino.io
PALACE_API_TOKEN=""           # Bearer token from Admin → Settings → API Token
PALACE_CALLBACK_TOKEN=""      # From Admin → Settings → Callback Token
PALACE_CURRENCY="ETB"
```

- [ ] **Step 5: Run seed to verify no errors**

```bash
pnpm --filter @world-bingo/api db:seed
```

Expected: `GASea provider seeded` then `Palace Casino provider seeded` — no errors.

- [ ] **Step 6: Run typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/gateways/game-provider/index.ts apps/api/src/index.ts apps/api/prisma/seed.ts apps/api/.env.example
git commit -m "feat(palace): register gateway, mount callback route, seed provider"
```

---

## Task 7: Cross-Provider Dedup in searchCatalog

**Files:**
- Modify: `apps/api/src/services/game-catalog.service.ts`

- [ ] **Step 1: Update searchCatalog to include vendor name and provider isPrimary, then dedup**

In `apps/api/src/services/game-catalog.service.ts`, find the `searchCatalog` method and make these changes:

**a) Add a normalization helper near the top of the file (after existing `normalizeQuery`):**

```typescript
function dedupKey(vendorName: string, gameName: string): string {
    const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    return `${clean(vendorName)}::${clean(gameName)}`
}
```

**b) Update the `findMany` select to include `vendor.name` and `provider.isPrimary`:**

Change:
```typescript
select: {
    id: true,
    gameCode: true,
    gameName: true,
    categoryCode: true,
    imageSquare: true,
    imageLandscape: true,
    provider: { select: { code: true, name: true } },
    vendor: { select: { code: true } },
},
```

To:
```typescript
select: {
    id: true,
    gameCode: true,
    gameName: true,
    categoryCode: true,
    imageSquare: true,
    imageLandscape: true,
    provider: { select: { code: true, name: true, isPrimary: true } },
    vendor: { select: { code: true, name: true } },
},
```

**c) Add dedup logic after `const providerGames = await prisma.providerGame.findMany(...)` and before building `results`:**

```typescript
// Dedup: if multiple providers serve the same game (same vendor+game name),
// show only the primary provider's copy. Primary providers sort first.
const sortedForDedup = [...providerGames].sort((a, b) => {
    if (a.provider.isPrimary && !b.provider.isPrimary) return -1
    if (!a.provider.isPrimary && b.provider.isPrimary) return 1
    return 0
})
const seenKeys = new Map<string, true>()
const dedupedGames = sortedForDedup.filter((game) => {
    const key = dedupKey(game.vendor?.name ?? '', game.gameName)
    if (seenKeys.has(key)) return false
    seenKeys.set(key, true)
    return true
})
```

**d) Change the `results` mapping to use `dedupedGames` instead of `providerGames`:**

```typescript
const results: SearchResult[] = dedupedGames.map((game) => ({
    kind: 'provider',
    id: game.id,
    providerCode: game.provider.code,
    providerName: game.provider.name,
    vendorCode: game.vendor?.code ?? null,
    gameCode: game.gameCode,
    gameName: game.gameName,
    categoryCode: game.categoryCode,
    imageSquare: game.imageSquare,
    imageLandscape: game.imageLandscape,
}))
```

- [ ] **Step 2: Run existing tests to confirm no regressions**

```bash
pnpm --filter @world-bingo/api test game-catalog
```

Expected: PASS (or no tests exist yet, in which case 0 failures).

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/game-catalog.service.ts
git commit -m "feat(catalog): cross-provider dedup by vendor+game name in searchCatalog"
```

---

## Task 8: Admin API — Set Primary Provider endpoint

**Files:**
- Modify: `apps/api/src/routes/admin/index.ts`

- [ ] **Step 1: Add PATCH /providers/:id/primary endpoint**

In `apps/api/src/routes/admin/index.ts`, find the providers section (around line 343) and add after the existing `PATCH /providers/:id/status`:

```typescript
f.patch('/providers/:id/primary', async (req: any, reply) => {
    const { isPrimary } = req.body as { isPrimary: boolean }
    if (typeof isPrimary !== 'boolean') {
        return reply.status(400).send({ error: 'isPrimary must be a boolean' })
    }

    if (isPrimary) {
        // Clear primary from all others first
        await prisma.gameProvider.updateMany({ data: { isPrimary: false } })
    }

    return prisma.gameProvider.update({
        where: { id: req.params.id },
        data: { isPrimary },
    })
})
```

- [ ] **Step 2: Verify GET /providers returns isPrimary**

The existing `GET /providers` does `prisma.gameProvider.findMany()` which already returns all fields including the new `isPrimary`. No change needed.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/admin/index.ts
git commit -m "feat(admin): add PATCH /providers/:id/primary endpoint"
```

---

## Task 9: Full Integration Verification

- [ ] **Step 1: Start infra**

```bash
pnpm infra:up
```

Expected: PostgreSQL and Redis containers start.

- [ ] **Step 2: Run migration + seed**

```bash
pnpm --filter @world-bingo/api db:migrate
pnpm --filter @world-bingo/api db:seed
```

Expected: migration runs cleanly (already applied), seed outputs `Palace Casino provider seeded`.

- [ ] **Step 3: Run all tests**

```bash
pnpm test
```

Expected: all tests pass, including `palace-gateway` and `palace-wallet`.

- [ ] **Step 4: Run typecheck across all packages**

```bash
pnpm typecheck
```

Expected: zero errors.

- [ ] **Step 5: Start API and verify Palace callback route is reachable**

```bash
pnpm --filter @world-bingo/api dev
```

Then in another terminal:

```bash
curl -s -X POST http://localhost:8080/v1/palace/callback \
  -H "Content-Type: application/json" \
  -H "Callback-Token: wrong-token" \
  -d '{"command":"balance","data":{"account":"test"},"timestamp":"1600000001","check":"21"}'
```

Expected response: `{"result":1009,"status":"TOKEN_INVALID","data":null}`

- [ ] **Step 6: Verify provider list in admin**

```bash
curl -s http://localhost:8080/v1/admin/providers | python3 -m json.tool
```

(Requires admin JWT — or check via Swagger at http://localhost:8080/docs)

Expected: array containing both `gasea` and `palace` providers.

- [ ] **Step 7: Final commit (if any lingering uncommitted changes)**

```bash
git status
```

If clean: done. If not, commit remaining files.
