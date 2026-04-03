# Admin Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the admin dashboard with grouped navigation, a two-section financial overview, deposit/withdrawal search filters, a unified Money Flow audit page, and accurate house wallet negative-balance display.

**Architecture:** Backend-first: extend `AdminService` with richer stats, new filter params on transaction queries, and a new `getMoneyFlow` aggregator. Frontend follows: nav restructure, page rewrites using the new API methods.

**Tech Stack:** Fastify v5, Prisma 5 / PostgreSQL, Vitest (backend tests), Nuxt 3, `@nuxt/ui` components, `useAdminApi` composable.

---

## File Map

### Backend (`apps/api`)
| File | Change |
|------|--------|
| `src/services/admin.service.ts` | Extend `getStats()`, extend `getTransactions()` params, add `getMoneyFlow()` |
| `src/controllers/admin.controller.ts` | Pass `from/to/minAmount/maxAmount/userSerial` query params through |
| `src/routes/admin/index.ts` | Add `GET /admin/money-flow` route |
| `src/test/admin.service.test.ts` | Add tests for new stats fields and new filter params |

### Frontend (`apps/admin`)
| File | Change |
|------|--------|
| `composables/useAdminApi.ts` | Extend `getPendingDeposits()`, `getWithdrawals()`, `getStats()` return type, add `getMoneyFlow()` |
| `layouts/default.vue` | Grouped nav with Finance / Games sections |
| `pages/index.vue` | Full rewrite — Section A (Money In/Out) + Section B (Game Performance) |
| `pages/deposits.vue` | Add filter toolbar (search, userSerial, date range, amount range, status) |
| `pages/withdrawals.vue` | Add filter toolbar (same as deposits) |
| `pages/house.vue` | Negative balance display + date range filter on transaction history |
| `pages/money-flow.vue` | New page — flow summary chain + unified ledger |

---

## Task 1: Extend `AdminService.getStats()`

**Files:**
- Modify: `apps/api/src/services/admin.service.ts`
- Test: `apps/api/src/test/admin.service.test.ts`

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `apps/api/src/test/admin.service.test.ts` (after the existing imports and mocks):

```typescript
describe('AdminService.getStats — extended fields', () => {
  let userId: string

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: {
        username: 'stats_test_user',
        phone: '+251900300001',
        passwordHash: 'hashed:pass',
        role: 'PLAYER',
        wallet: { create: { realBalance: 500 } },
      },
    })
    userId = user.id

    // One approved deposit
    await prisma.transaction.create({
      data: {
        userId, type: 'DEPOSIT', status: 'APPROVED',
        amount: 500, balanceBefore: 0, balanceAfter: 500,
        bonusBalanceBefore: 0, bonusBalanceAfter: 0,
      },
    })

    // One approved withdrawal
    await prisma.transaction.create({
      data: {
        userId, type: 'WITHDRAWAL', status: 'APPROVED',
        amount: 100, balanceBefore: 500, balanceAfter: 400,
        bonusBalanceBefore: 0, bonusBalanceAfter: 0,
      },
    })

    // One prize win
    await prisma.transaction.create({
      data: {
        userId, type: 'PRIZE_WIN', status: 'APPROVED',
        amount: 200, balanceBefore: 400, balanceAfter: 600,
        bonusBalanceBefore: 0, bonusBalanceAfter: 0,
      },
    })
  })

  it('returns totalPrizesSum from PRIZE_WIN transactions', async () => {
    const stats = await AdminService.getStats()
    expect(stats.totalPrizesSum).toBeGreaterThanOrEqual(200)
  })

  it('returns gamesCompleted count', async () => {
    const stats = await AdminService.getStats()
    expect(typeof stats.gamesCompleted).toBe('number')
  })

  it('returns gamesCancelled count', async () => {
    const stats = await AdminService.getStats()
    expect(typeof stats.gamesCancelled).toBe('number')
  })

  it('returns houseBalance as a number', async () => {
    const stats = await AdminService.getStats()
    expect(typeof stats.houseBalance).toBe('number')
  })

  it('returns houseCommissionEarned from houseTransaction COMMISSION sum', async () => {
    const stats = await AdminService.getStats()
    expect(typeof stats.houseCommissionEarned).toBe('number')
  })

  it('returns providerStats as an array', async () => {
    const stats = await AdminService.getStats()
    expect(Array.isArray(stats.providerStats)).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api && pnpm test --reporter=verbose src/test/admin.service.test.ts
```

Expected: The new tests fail because `stats.totalPrizesSum`, `stats.gamesCompleted`, etc. do not exist on the returned object.

- [ ] **Step 3: Rewrite `AdminService.getStats()`**

Replace the entire `getStats` method in `apps/api/src/services/admin.service.ts`:

```typescript
static async getStats() {
    const [
        approvedDeposits,
        approvedWithdrawals,
        totalPrizes,
        gamesCompleted,
        gamesCancelled,
        activePlayers,
        houseSummary,
        houseBalance,
        providerData,
    ] = await Promise.all([
        prisma.transaction.aggregate({
            where: { type: TransactionType.DEPOSIT, status: PaymentStatus.APPROVED },
            _sum: { amount: true },
        }),
        prisma.transaction.aggregate({
            where: { type: TransactionType.WITHDRAWAL, status: PaymentStatus.APPROVED },
            _sum: { amount: true },
        }),
        prisma.transaction.aggregate({
            where: { type: TransactionType.PRIZE_WIN, status: PaymentStatus.APPROVED },
            _sum: { amount: true },
        }),
        prisma.game.count({ where: { status: 'COMPLETED' } }),
        prisma.game.count({ where: { status: 'CANCELLED' } }),
        prisma.gameEntry.groupBy({ by: ['userId'] }).then(rows => rows.length),
        HouseWalletService.getSummary(),
        HouseWalletService.getBalance(),
        prisma.thirdPartyTransaction.groupBy({
            by: ['providerId'],
            _sum: { amount: true },
        }),
    ])

    // Compute total prize pools from completed games
    const completedGames = await prisma.game.findMany({
        where: { status: 'COMPLETED' },
        include: { _count: { select: { entries: true } } },
    })
    const totalPrizePools = completedGames.reduce((acc, g) => {
        return acc + Number(g.ticketPrice) * g._count.entries
    }, 0)

    // Provider gained/lost/net per provider
    // amount < 0 = debit from player wallet = house gained; amount > 0 = credit to player = house lost
    const [providerGained, providerLost] = await Promise.all([
        prisma.thirdPartyTransaction.groupBy({
            by: ['providerId'],
            where: { amount: { lt: 0 } },
            _sum: { amount: true },
        }),
        prisma.thirdPartyTransaction.groupBy({
            by: ['providerId'],
            where: { amount: { gt: 0 } },
            _sum: { amount: true },
        }),
    ])
    const gainedMap = new Map(providerGained.map(r => [r.providerId, Math.abs(Number(r._sum.amount ?? 0))]))
    const lostMap = new Map(providerLost.map(r => [r.providerId, Number(r._sum.amount ?? 0)]))

    const allProviderIds = [...new Set([...gainedMap.keys(), ...lostMap.keys()])]
    const providers = await prisma.gameProvider.findMany({
        where: { id: { in: allProviderIds } },
        select: { id: true, code: true },
    })
    const providerMap = new Map(providers.map(p => [p.id, p.code]))

    const providerStats = allProviderIds.map(pid => {
        const gained = gainedMap.get(pid) ?? 0
        const lost = lostMap.get(pid) ?? 0
        return {
            name: providerMap.get(pid) ?? pid,
            gained,
            lost,
            net: gained - lost, // positive = house profited, negative = house lost
        }
    })

    return {
        approvedDepositSum: Number(approvedDeposits._sum.amount ?? 0),
        approvedWithdrawalSum: Number(approvedWithdrawals._sum.amount ?? 0),
        totalPrizesSum: Number(totalPrizes._sum.amount ?? 0),
        gamesCompleted,
        gamesCancelled,
        totalPrizePools,
        activePlayers,
        houseBalance: Number(houseBalance),
        houseCommissionEarned: houseSummary.COMMISSION,
        providerStats,
        // keep backward compat fields
        declinedDepositSum: 0,
        usersCount: 0,
        gamesCount: gamesCompleted,
        totalProfit: houseSummary.COMMISSION,
        commission: houseSummary.COMMISSION,
    }
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
cd apps/api && pnpm test --reporter=verbose src/test/admin.service.test.ts
```

Expected: All tests in `AdminService.getStats — extended fields` pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/admin.service.ts apps/api/src/test/admin.service.test.ts
git commit -m "feat(admin): extend getStats with prizes, game counts, house balance, provider stats"
```

---

## Task 2: Extend `AdminService.getTransactions()` with filter params

**Files:**
- Modify: `apps/api/src/services/admin.service.ts`
- Modify: `apps/api/src/controllers/admin.controller.ts`
- Test: `apps/api/src/test/admin.service.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/test/admin.service.test.ts`:

```typescript
describe('AdminService.getTransactions — filter params', () => {
  let userId: string

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: {
        username: 'filter_test_user',
        phone: '+251900400001',
        passwordHash: 'hashed:pass',
        serial: 99901,
        wallet: { create: { realBalance: 1000 } },
      },
    })
    userId = user.id

    await prisma.transaction.createMany({
      data: [
        {
          userId, type: 'DEPOSIT', status: 'APPROVED',
          amount: 100, balanceBefore: 0, balanceAfter: 100,
          bonusBalanceBefore: 0, bonusBalanceAfter: 0,
          createdAt: new Date('2026-01-15T10:00:00Z'),
        },
        {
          userId, type: 'DEPOSIT', status: 'APPROVED',
          amount: 500, balanceBefore: 100, balanceAfter: 600,
          bonusBalanceBefore: 0, bonusBalanceAfter: 0,
          createdAt: new Date('2026-02-20T10:00:00Z'),
        },
        {
          userId, type: 'DEPOSIT', status: 'PENDING_REVIEW',
          amount: 250, balanceBefore: 600, balanceAfter: 850,
          bonusBalanceBefore: 0, bonusBalanceAfter: 0,
          createdAt: new Date('2026-03-01T10:00:00Z'),
        },
      ],
    })
  })

  it('filters by from/to date range', async () => {
    const result = await AdminService.getTransactions({
      type: 'DEPOSIT' as any,
      from: new Date('2026-02-01'),
      to: new Date('2026-02-28'),
    })
    expect(result.data).toHaveLength(1)
    expect(Number(result.data[0].amount)).toBe(500)
  })

  it('filters by minAmount', async () => {
    const result = await AdminService.getTransactions({
      type: 'DEPOSIT' as any,
      minAmount: 200,
    })
    expect(result.data.length).toBeGreaterThanOrEqual(2)
    result.data.forEach(tx => expect(Number(tx.amount)).toBeGreaterThanOrEqual(200))
  })

  it('filters by maxAmount', async () => {
    const result = await AdminService.getTransactions({
      type: 'DEPOSIT' as any,
      maxAmount: 200,
    })
    result.data.forEach(tx => expect(Number(tx.amount)).toBeLessThanOrEqual(200))
  })

  it('filters by userSerial', async () => {
    const result = await AdminService.getTransactions({
      type: 'DEPOSIT' as any,
      userSerial: 99901,
    })
    expect(result.data.length).toBeGreaterThanOrEqual(1)
    result.data.forEach(tx => expect((tx as any).user.serial).toBe(99901))
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/api && pnpm test --reporter=verbose src/test/admin.service.test.ts
```

Expected: `AdminService.getTransactions — filter params` tests fail because the new params are not handled.

- [ ] **Step 3: Update `AdminService.getTransactions()` signature and where clause**

Replace the `getTransactions` method in `apps/api/src/services/admin.service.ts`:

```typescript
static async getTransactions(params: {
    type?: TransactionType
    status?: PaymentStatus
    page?: number
    limit?: number
    from?: Date
    to?: Date
    minAmount?: number
    maxAmount?: number
    userSerial?: number
    search?: string
}) {
    const page = params.page ?? 1
    const limit = params.limit ?? 50
    const skip = (page - 1) * limit

    const where: any = {
        ...(params.type && { type: params.type }),
        ...(params.status && { status: params.status }),
        ...(params.from || params.to ? {
            createdAt: {
                ...(params.from && { gte: params.from }),
                ...(params.to && { lte: params.to }),
            },
        } : {}),
        ...(params.minAmount !== undefined || params.maxAmount !== undefined ? {
            amount: {
                ...(params.minAmount !== undefined && { gte: params.minAmount }),
                ...(params.maxAmount !== undefined && { lte: params.maxAmount }),
            },
        } : {}),
        ...(params.userSerial !== undefined && {
            user: { serial: params.userSerial },
        }),
        ...(params.search && {
            user: {
                OR: [
                    { username: { contains: params.search, mode: 'insensitive' } },
                    { phone: { contains: params.search } },
                ],
            },
        }),
    }

    // If both userSerial and search are set, merge user conditions
    if (params.userSerial !== undefined && params.search) {
        where.user = {
            serial: params.userSerial,
            OR: [
                { username: { contains: params.search, mode: 'insensitive' } },
                { phone: { contains: params.search } },
            ],
        }
    }

    const [data, total] = await Promise.all([
        prisma.transaction.findMany({
            where,
            include: {
                user: {
                    select: { id: true, serial: true, username: true, phone: true },
                },
            },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        }),
        prisma.transaction.count({ where }),
    ])

    return {
        data,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    }
}
```

- [ ] **Step 4: Update `AdminController` to pass new query params**

Replace `getPendingDeposits`, `getOrdersHistory`, and `getWithdrawals` in `apps/api/src/controllers/admin.controller.ts`:

```typescript
static async getPendingDeposits(request: FastifyRequest, reply: FastifyReply) {
    const q = (request.query as any) ?? {}
    const result = await AdminService.getTransactions({
        type: TransactionType.DEPOSIT,
        status: (q.status as PaymentStatus) || PaymentStatus.PENDING_REVIEW,
        search: q.search || undefined,
        userSerial: q.userSerial ? Number(q.userSerial) : undefined,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        minAmount: q.minAmount ? Number(q.minAmount) : undefined,
        maxAmount: q.maxAmount ? Number(q.maxAmount) : undefined,
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
    })
    return result
}

static async getOrdersHistory(request: FastifyRequest, reply: FastifyReply) {
    const q = (request.query as any) ?? {}
    const transactions = await AdminService.getTransactions({
        ...(q.type && q.type !== 'ALL' ? { type: q.type as TransactionType } : {}),
        page: q.page ? parseInt(q.page, 10) : 1,
        limit: q.limit ? parseInt(q.limit, 10) : 20,
    })
    return transactions
}

static async getWithdrawals(request: FastifyRequest, reply: FastifyReply) {
    const q = (request.query as any) ?? {}
    const result = await AdminService.getTransactions({
        type: TransactionType.WITHDRAWAL,
        status: (q.status as PaymentStatus) || PaymentStatus.PENDING_REVIEW,
        search: q.search || undefined,
        userSerial: q.userSerial ? Number(q.userSerial) : undefined,
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        minAmount: q.minAmount ? Number(q.minAmount) : undefined,
        maxAmount: q.maxAmount ? Number(q.maxAmount) : undefined,
        page: q.page ? Number(q.page) : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
    })
    return result
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd apps/api && pnpm test --reporter=verbose src/test/admin.service.test.ts
```

Expected: All `getTransactions — filter params` tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/admin.service.ts apps/api/src/controllers/admin.controller.ts apps/api/src/test/admin.service.test.ts
git commit -m "feat(admin): add date/amount/serial filters to getTransactions"
```

---

## Task 3: Add `getMoneyFlow()` service method and route

**Files:**
- Modify: `apps/api/src/services/admin.service.ts`
- Modify: `apps/api/src/routes/admin/index.ts`
- Test: `apps/api/src/test/admin.service.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/test/admin.service.test.ts`:

```typescript
describe('AdminService.getMoneyFlow', () => {
  let userId: string

  beforeEach(async () => {
    const user = await prisma.user.create({
      data: {
        username: 'flow_test_user',
        phone: '+251900500001',
        passwordHash: 'hashed:pass',
        wallet: { create: { realBalance: 1000 } },
      },
    })
    userId = user.id

    await prisma.transaction.createMany({
      data: [
        {
          userId, type: 'DEPOSIT', status: 'APPROVED',
          amount: 300, balanceBefore: 0, balanceAfter: 300,
          bonusBalanceBefore: 0, bonusBalanceAfter: 0,
        },
        {
          userId, type: 'PRIZE_WIN', status: 'APPROVED',
          amount: 150, balanceBefore: 300, balanceAfter: 450,
          bonusBalanceBefore: 0, bonusBalanceAfter: 0,
        },
      ],
    })
  })

  it('returns rows, total, summary', async () => {
    const result = await AdminService.getMoneyFlow({ page: 1, limit: 20 })
    expect(Array.isArray(result.rows)).toBe(true)
    expect(typeof result.total).toBe('number')
    expect(result.summary).toHaveProperty('totalDeposited')
    expect(result.summary).toHaveProperty('totalWagered')
    expect(result.summary).toHaveProperty('totalPrizesOut')
    expect(result.summary).toHaveProperty('houseKept')
    expect(result.summary).toHaveProperty('refundsIssued')
  })

  it('each row has required shape', async () => {
    const result = await AdminService.getMoneyFlow({ page: 1, limit: 20 })
    if (result.rows.length > 0) {
      const row = result.rows[0]
      expect(row).toHaveProperty('id')
      expect(row).toHaveProperty('createdAt')
      expect(row).toHaveProperty('type')
      expect(row).toHaveProperty('direction')
      expect(row).toHaveProperty('amount')
      expect(row).toHaveProperty('source')
      expect(['IN', 'OUT']).toContain(row.direction)
    }
  })

  it('filters by direction IN', async () => {
    const result = await AdminService.getMoneyFlow({ page: 1, limit: 20, direction: 'IN' })
    result.rows.forEach(r => expect(r.direction).toBe('IN'))
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/api && pnpm test --reporter=verbose src/test/admin.service.test.ts
```

Expected: `AdminService.getMoneyFlow` tests fail — method does not exist.

- [ ] **Step 3: Add `getMoneyFlow()` to `AdminService`**

Add this method at the end of the `AdminService` class in `apps/api/src/services/admin.service.ts`:

```typescript
static async getMoneyFlow(params: {
    page?: number
    limit?: number
    direction?: 'IN' | 'OUT'
    types?: string[]
    from?: Date
    to?: Date
    search?: string
}) {
    const page = params.page ?? 1
    const limit = params.limit ?? 30
    const skip = (page - 1) * limit

    const dateFilter = (params.from || params.to) ? {
        createdAt: {
            ...(params.from && { gte: params.from }),
            ...(params.to && { lte: params.to }),
        },
    } : {}

    // Direction mapping: which transaction types are IN vs OUT
    const IN_TYPES = ['DEPOSIT', 'PRIZE_WIN', 'COMMISSION', 'BOT_PRIZE_WIN', 'ADMIN_REAL_ADJUSTMENT', 'ADMIN_BONUS_ADJUSTMENT']
    const OUT_TYPES = ['WITHDRAWAL', 'GAME_ENTRY', 'REFUND', 'REFUND_ISSUED']

    // Fetch from all three sources in parallel
    const [playerTxs, houseTxs, providerTxs] = await Promise.all([
        prisma.transaction.findMany({
            where: {
                ...dateFilter,
                ...(params.search && {
                    user: {
                        OR: [
                            { username: { contains: params.search, mode: 'insensitive' } },
                            { phone: { contains: params.search } },
                        ],
                    },
                }),
            },
            include: { user: { select: { username: true, id: true } } },
            orderBy: { createdAt: 'desc' },
            take: limit * 3,
        }),
        prisma.houseTransaction.findMany({
            where: { ...dateFilter },
            orderBy: { createdAt: 'desc' },
            take: limit * 3,
        }),
        prisma.thirdPartyTransaction.findMany({
            where: { ...dateFilter },
            orderBy: { createdAt: 'desc' },
            take: limit * 3,
        }),
    ])

    // Normalize to common shape
    const normalizeDirection = (type: string, source: string): 'IN' | 'OUT' => {
        if (source === 'Provider') {
            // positive amount = credit to player (house lost), negative = debit (house gained)
            return 'IN' // will be overridden per row
        }
        if (source === 'House Wallet') {
            return IN_TYPES.includes(type) ? 'IN' : 'OUT'
        }
        return IN_TYPES.includes(type) ? 'IN' : 'OUT'
    }

    const rows: Array<{
        id: string
        createdAt: Date
        type: string
        direction: 'IN' | 'OUT'
        amount: number
        playerName?: string
        playerId?: string
        gameId?: string
        source: string
        balanceAfter?: number
    }> = []

    for (const tx of playerTxs) {
        const direction = IN_TYPES.includes(tx.type) ? 'IN' : 'OUT'
        rows.push({
            id: tx.id,
            createdAt: tx.createdAt,
            type: tx.type,
            direction,
            amount: Number(tx.amount),
            playerName: (tx as any).user?.username,
            playerId: (tx as any).user?.id,
            gameId: (tx as any).gameId ?? undefined,
            source: 'Player Wallet',
            balanceAfter: Number(tx.balanceAfter),
        })
    }

    for (const tx of houseTxs) {
        const direction = tx.type === 'COMMISSION' || tx.type === 'BOT_PRIZE_WIN' ? 'IN' : 'OUT'
        rows.push({
            id: tx.id,
            createdAt: tx.createdAt,
            type: tx.type,
            direction,
            amount: Number(tx.amount),
            playerId: tx.userId ?? undefined,
            gameId: tx.gameId ?? undefined,
            source: 'House Wallet',
            balanceAfter: Number(tx.balanceAfter),
        })
    }

    for (const tx of providerTxs) {
        const net = Number(tx.amount)
        // positive net = player received money = house lost; negative net = player paid = house gained
        const direction: 'IN' | 'OUT' = net < 0 ? 'IN' : 'OUT'
        rows.push({
            id: tx.id,
            createdAt: tx.createdAt,
            type: `PROVIDER_${tx.type}`,
            direction,
            amount: Math.abs(net),
            playerId: tx.userId,
            source: 'Provider',
        })
    }

    // Filter by direction if requested
    const filtered = params.direction
        ? rows.filter(r => r.direction === params.direction)
        : rows

    // Filter by type if requested
    const typeFiltered = params.types?.length
        ? filtered.filter(r => params.types!.includes(r.type))
        : filtered

    // Sort by createdAt desc and paginate
    typeFiltered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    const total = typeFiltered.length
    const paginated = typeFiltered.slice(skip, skip + limit)

    // Summary totals (platform-wide, unfiltered)
    const [depositSum, wagerSum, prizeSum, houseSummary] = await Promise.all([
        prisma.transaction.aggregate({
            where: { type: TransactionType.DEPOSIT, status: PaymentStatus.APPROVED },
            _sum: { amount: true },
        }),
        prisma.transaction.aggregate({
            where: { type: TransactionType.GAME_ENTRY },
            _sum: { amount: true },
        }),
        prisma.transaction.aggregate({
            where: { type: TransactionType.PRIZE_WIN, status: PaymentStatus.APPROVED },
            _sum: { amount: true },
        }),
        HouseWalletService.getSummary(),
    ])

    return {
        rows: paginated,
        total,
        page,
        limit,
        summary: {
            totalDeposited: Number(depositSum._sum.amount ?? 0),
            totalWagered: Number(wagerSum._sum.amount ?? 0),
            totalPrizesOut: Number(prizeSum._sum.amount ?? 0),
            houseKept: houseSummary.COMMISSION,
            refundsIssued: houseSummary.REFUND_ISSUED,
        },
    }
}
```

- [ ] **Step 4: Add the route in `apps/api/src/routes/admin/index.ts`**

Add after the `GET /house/bots` route (around line 210):

```typescript
fastify.get('/money-flow', async (req: any, _reply) => {
    const {
        page, limit, direction, from, to, search,
    } = req.query as Record<string, string>
    const types = req.query['type[]']
        ? (Array.isArray(req.query['type[]']) ? req.query['type[]'] : [req.query['type[]']])
        : undefined
    return AdminService.getMoneyFlow({
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
        direction: direction as 'IN' | 'OUT' | undefined,
        types,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        search: search || undefined,
    })
})
```

Also add the `AdminService` import if not already present at top of the route file — it is already imported via `AdminController` which imports `AdminService`, but the route needs direct access. Add to existing imports:

```typescript
import { AdminService } from '../../services/admin.service'
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd apps/api && pnpm test --reporter=verbose src/test/admin.service.test.ts
```

Expected: All `AdminService.getMoneyFlow` tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/admin.service.ts apps/api/src/routes/admin/index.ts apps/api/src/test/admin.service.test.ts
git commit -m "feat(admin): add getMoneyFlow aggregator and GET /admin/money-flow route"
```

---

## Task 4: Extend `useAdminApi.ts`

**Files:**
- Modify: `apps/admin/composables/useAdminApi.ts`

No automated test for composables — verify manually in Task 6+ when pages use these methods.

- [ ] **Step 1: Update `getStats` return type and add new methods**

Replace the `getPendingDeposits`, `getWithdrawals`, and `getStats` entries, and add `getMoneyFlow` in `apps/admin/composables/useAdminApi.ts`:

```typescript
// replace the getStats line:
getStats: () => apiFetch<{
    approvedDepositSum: number
    approvedWithdrawalSum: number
    totalPrizesSum: number
    gamesCompleted: number
    gamesCancelled: number
    totalPrizePools: number
    activePlayers: number
    houseBalance: number
    houseCommissionEarned: number
    providerStats: Array<{ name: string; gained: number; lost: number; net: number }>
    // legacy
    declinedDepositSum: number
    usersCount: number
    gamesCount: number
    totalProfit: number
    commission: number
}>('/admin/stats'),

// replace getPendingDeposits:
getPendingDeposits: (params?: {
    status?: string
    search?: string
    userSerial?: number
    from?: string
    to?: string
    minAmount?: number
    maxAmount?: number
    page?: number
    limit?: number
}) => {
    const qs = new URLSearchParams()
    if (params?.status) qs.set('status', params.status)
    if (params?.search) qs.set('search', params.search)
    if (params?.userSerial) qs.set('userSerial', String(params.userSerial))
    if (params?.from) qs.set('from', params.from)
    if (params?.to) qs.set('to', params.to)
    if (params?.minAmount !== undefined) qs.set('minAmount', String(params.minAmount))
    if (params?.maxAmount !== undefined) qs.set('maxAmount', String(params.maxAmount))
    if (params?.page) qs.set('page', String(params.page))
    if (params?.limit) qs.set('limit', String(params.limit))
    const query = qs.toString()
    return apiFetch<any>(`/admin/transactions/pending${query ? `?${query}` : ''}`)
},

// replace getWithdrawals:
getWithdrawals: (params?: {
    status?: string
    search?: string
    userSerial?: number
    from?: string
    to?: string
    minAmount?: number
    maxAmount?: number
    page?: number
    limit?: number
}) => {
    const qs = new URLSearchParams()
    if (params?.status) qs.set('status', params.status)
    if (params?.search) qs.set('search', params.search)
    if (params?.userSerial) qs.set('userSerial', String(params.userSerial))
    if (params?.from) qs.set('from', params.from)
    if (params?.to) qs.set('to', params.to)
    if (params?.minAmount !== undefined) qs.set('minAmount', String(params.minAmount))
    if (params?.maxAmount !== undefined) qs.set('maxAmount', String(params.maxAmount))
    if (params?.page) qs.set('page', String(params.page))
    if (params?.limit) qs.set('limit', String(params.limit))
    const query = qs.toString()
    return apiFetch<any>(`/admin/withdrawals${query ? `?${query}` : ''}`)
},
```

Add `getMoneyFlow` after `getBotActivity`:

```typescript
getMoneyFlow: (params?: {
    page?: number
    limit?: number
    direction?: 'IN' | 'OUT'
    types?: string[]
    from?: string
    to?: string
    search?: string
}) => {
    const qs = new URLSearchParams()
    if (params?.page) qs.set('page', String(params.page))
    if (params?.limit) qs.set('limit', String(params.limit))
    if (params?.direction) qs.set('direction', params.direction)
    if (params?.from) qs.set('from', params.from)
    if (params?.to) qs.set('to', params.to)
    if (params?.search) qs.set('search', params.search)
    params?.types?.forEach(t => qs.append('type[]', t))
    const query = qs.toString()
    return apiFetch<{
        rows: Array<{
            id: string
            createdAt: string
            type: string
            direction: 'IN' | 'OUT'
            amount: number
            playerName?: string
            playerId?: string
            gameId?: string
            source: string
            balanceAfter?: number
        }>
        total: number
        page: number
        limit: number
        summary: {
            totalDeposited: number
            totalWagered: number
            totalPrizesOut: number
            houseKept: number
            refundsIssued: number
        }
    }>(`/admin/money-flow${query ? `?${query}` : ''}`)
},
```

Also update `getHouseTransactions` to accept `from`/`to`:

```typescript
getHouseTransactions: (params?: { page?: number; limit?: number; type?: string; from?: string; to?: string }) => {
    const qs = new URLSearchParams()
    if (params?.page) qs.set('page', String(params.page))
    if (params?.limit) qs.set('limit', String(params.limit))
    if (params?.type) qs.set('type', params.type)
    if (params?.from) qs.set('from', params.from)
    if (params?.to) qs.set('to', params.to)
    const query = qs.toString()
    return apiFetch<any>(`/admin/house/transactions${query ? `?${query}` : ''}`)
},
```

- [ ] **Step 2: Commit**

```bash
git add apps/admin/composables/useAdminApi.ts
git commit -m "feat(admin): extend useAdminApi with filter params and getMoneyFlow"
```

---

## Task 5: Restructure Sidebar Navigation

**Files:**
- Modify: `apps/admin/layouts/default.vue`

- [ ] **Step 1: Replace `navItems` with grouped nav**

Replace the entire `<script setup>` block in `apps/admin/layouts/default.vue`:

```typescript
<script setup lang="ts">
const { user, logout } = useAdminAuth()
const { locale, setLocale } = useI18n()
const toggleLocale = () => setLocale(locale.value === 'en' ? 'am' : 'en')

const navGroups = [
  {
    label: null,
    items: [
      { label: 'Dashboard', icon: 'i-heroicons:squares-2x2', to: '/' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { label: 'Deposits',     icon: 'i-heroicons:arrow-down-tray',         to: '/deposits'   },
      { label: 'Withdrawals',  icon: 'i-heroicons:arrow-up-tray',           to: '/withdrawals' },
      { label: 'House Wallet', icon: 'i-heroicons:building-library',        to: '/house'       },
      { label: 'Money Flow',   icon: 'i-heroicons:arrows-right-left',       to: '/money-flow'  },
    ],
  },
  {
    label: 'Games',
    items: [
      { label: 'Active Games',    icon: 'i-heroicons:puzzle-piece',   to: '/games'                    },
      { label: 'Game Templates',  icon: 'i-heroicons:cog-6-tooth',    to: '/settings/game-templates'  },
      { label: 'Tournaments',     icon: 'i-heroicons:trophy',         to: '/tournaments'              },
    ],
  },
  {
    label: null,
    items: [
      { label: 'Players',      icon: 'i-heroicons:user-group',              to: '/players'   },
      { label: 'Users',        icon: 'i-heroicons:users',                   to: '/users'     },
      { label: 'Providers',    icon: 'i-heroicons:globe-alt',               to: '/providers' },
      { label: 'Cashback',     icon: 'i-heroicons:gift',                    to: '/cashback'  },
      { label: 'Feature Flags',icon: 'i-heroicons:adjustments-horizontal',  to: '/settings/features' },
      { label: 'Profile',      icon: 'i-heroicons:user-circle',             to: '/settings/profile'  },
    ],
  },
]

const mobileOpen = ref(false)
const route = useRoute()
watch(() => route.path, () => { mobileOpen.value = false })
</script>
```

- [ ] **Step 2: Replace the `<nav>` block inside `<aside>`**

Replace the `<nav class="flex-1 px-3 space-y-0.5">` block:

```html
<nav class="flex-1 px-3 space-y-4">
  <div v-for="(group, gi) in navGroups" :key="gi">
    <p v-if="group.label" class="px-3 mb-1 text-[10px] font-bold text-white/30 uppercase tracking-widest">
      {{ group.label }}
    </p>
    <div class="space-y-0.5">
      <NuxtLink
        v-for="item in group.items"
        :key="item.to"
        :to="item.to"
        class="admin-nav-link flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-zinc-400 hover:text-white hover:bg-white/6 transition-all"
        :class="route.path === item.to || (item.to !== '/' && route.path.startsWith(item.to))
          ? 'bg-yellow-400/10 text-yellow-500!'
          : ''"
      >
        <UIcon :name="item.icon" class="w-4.5 h-4.5 flex-shrink-0" />
        {{ item.label }}
      </NuxtLink>
    </div>
  </div>
</nav>
```

- [ ] **Step 3: Commit**

```bash
git add apps/admin/layouts/default.vue
git commit -m "feat(admin): restructure sidebar nav into Finance and Games groups"
```

---

## Task 6: Rewrite Dashboard Overview (`pages/index.vue`)

**Files:**
- Modify: `apps/admin/pages/index.vue`

- [ ] **Step 1: Rewrite the full page**

Replace the entire contents of `apps/admin/pages/index.vue`:

```vue
<script setup lang="ts">
const { getStats } = useAdminApi()

const loading = ref(false)
const stats = ref<{
  approvedDepositSum: number
  approvedWithdrawalSum: number
  totalPrizesSum: number
  gamesCompleted: number
  gamesCancelled: number
  totalPrizePools: number
  activePlayers: number
  houseBalance: number
  houseCommissionEarned: number
  providerStats: Array<{ name: string; gained: number; lost: number; net: number }>
} | null>(null)

const refresh = async () => {
  loading.value = true
  try {
    stats.value = await getStats() as any
  } catch (e) {
    console.error('Failed to fetch stats', e)
  } finally {
    loading.value = false
  }
}

onMounted(refresh)

const fmt = (n: number) =>
  n.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const houseIsDeficit = computed(() => (stats.value?.houseBalance ?? 0) < 0)
</script>

<template>
  <div class="space-y-8">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Dashboard Overview</h1>
        <p class="text-sm text-white/50 mt-0.5">Platform performance and financials</p>
      </div>
      <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" :loading="loading" @click="refresh">
        Refresh
      </UButton>
    </div>

    <!-- ── Section A: Money In / Out ──────────────────────────────────────── -->
    <div>
      <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-3">Money In / Out</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">

        <div class="rounded-2xl border border-green-500/20 bg-green-500/5 p-5">
          <p class="text-[10px] font-bold text-green-400/70 uppercase tracking-widest">Total Deposits Approved</p>
          <p class="mt-2 text-2xl font-bold text-green-400 tabular-nums">{{ fmt(stats?.approvedDepositSum ?? 0) }} ETB</p>
        </div>

        <div class="rounded-2xl border border-red-500/20 bg-red-500/5 p-5">
          <p class="text-[10px] font-bold text-red-400/70 uppercase tracking-widest">Total Withdrawals Approved</p>
          <p class="mt-2 text-2xl font-bold text-red-400 tabular-nums">{{ fmt(stats?.approvedWithdrawalSum ?? 0) }} ETB</p>
        </div>

        <div class="rounded-2xl border border-white/10 bg-white/5 p-5">
          <p class="text-[10px] font-bold text-white/40 uppercase tracking-widest">Net (Deposits − Withdrawals)</p>
          <p class="mt-2 text-2xl font-bold tabular-nums"
            :class="(stats?.approvedDepositSum ?? 0) - (stats?.approvedWithdrawalSum ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'">
            {{ fmt((stats?.approvedDepositSum ?? 0) - (stats?.approvedWithdrawalSum ?? 0)) }} ETB
          </p>
        </div>

        <div class="rounded-2xl border border-red-500/20 bg-red-500/5 p-5">
          <p class="text-[10px] font-bold text-red-400/70 uppercase tracking-widest">Total Prizes Paid Out</p>
          <p class="mt-2 text-2xl font-bold text-red-400 tabular-nums">{{ fmt(stats?.totalPrizesSum ?? 0) }} ETB</p>
        </div>

        <div class="rounded-2xl border p-5"
          :class="houseIsDeficit
            ? 'border-red-500/40 bg-red-500/5'
            : 'border-yellow-400/20 bg-yellow-400/5'">
          <div class="flex items-center gap-2 mb-1">
            <p class="text-[10px] font-bold uppercase tracking-widest"
              :class="houseIsDeficit ? 'text-red-400/70' : 'text-yellow-400/70'">
              House Wallet Balance
            </p>
            <UBadge v-if="houseIsDeficit" color="error" variant="soft" size="xs">⚠ Deficit</UBadge>
          </div>
          <p class="mt-1 text-2xl font-bold tabular-nums"
            :class="houseIsDeficit ? 'text-red-400' : 'text-yellow-400'">
            {{ fmt(stats?.houseBalance ?? 0) }} ETB
          </p>
        </div>

      </div>

      <!-- Provider Net Table -->
      <div v-if="stats?.providerStats?.length" class="mt-4 rounded-2xl border border-(--surface-border) overflow-hidden shadow-lg" style="background:var(--surface-raised);">
        <div class="px-5 py-3 border-b border-(--surface-border)">
          <p class="text-xs font-bold text-white/40 uppercase tracking-widest">Provider Performance (House Perspective)</p>
        </div>
        <table class="w-full text-sm">
          <thead class="border-b border-(--surface-border)">
            <tr>
              <th class="text-left px-5 py-2 text-white/40 text-xs font-semibold uppercase">Provider</th>
              <th class="text-right px-5 py-2 text-green-400/60 text-xs font-semibold uppercase">Gained (ETB)</th>
              <th class="text-right px-5 py-2 text-red-400/60 text-xs font-semibold uppercase">Lost (ETB)</th>
              <th class="text-right px-5 py-2 text-white/40 text-xs font-semibold uppercase">Net (ETB)</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-white/5">
            <tr v-for="p in stats.providerStats" :key="p.name" class="hover:bg-white/3 transition-colors">
              <td class="px-5 py-3 font-mono text-white/70 text-sm">{{ p.name }}</td>
              <td class="px-5 py-3 text-right font-bold font-mono tabular-nums text-green-400">
                +{{ fmt(p.gained) }}
              </td>
              <td class="px-5 py-3 text-right font-bold font-mono tabular-nums text-red-400">
                -{{ fmt(p.lost) }}
              </td>
              <td class="px-5 py-3 text-right font-bold font-mono tabular-nums"
                :class="p.net >= 0 ? 'text-green-400' : 'text-red-400'">
                {{ p.net >= 0 ? '+' : '' }}{{ fmt(p.net) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ── Section B: Game Performance ───────────────────────────────────── -->
    <div>
      <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-3">Game Performance</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">

        <div class="rounded-2xl border border-(--surface-border) p-5" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/40 uppercase tracking-widest">Games Completed</p>
          <p class="mt-2 text-2xl font-bold text-white tabular-nums">{{ stats?.gamesCompleted ?? 0 }}</p>
        </div>

        <div class="rounded-2xl border border-(--surface-border) p-5" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/40 uppercase tracking-widest">Games Cancelled</p>
          <p class="mt-2 text-2xl font-bold text-white tabular-nums">{{ stats?.gamesCancelled ?? 0 }}</p>
        </div>

        <div class="rounded-2xl border border-(--surface-border) p-5" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/40 uppercase tracking-widest">Total Prize Pools Generated</p>
          <p class="mt-2 text-2xl font-bold text-yellow-500 tabular-nums">{{ fmt(stats?.totalPrizePools ?? 0) }} ETB</p>
        </div>

        <div class="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-5">
          <p class="text-[10px] font-bold text-blue-400/70 uppercase tracking-widest">House Commission Earned</p>
          <p class="mt-2 text-2xl font-bold text-blue-400 tabular-nums">{{ fmt(stats?.houseCommissionEarned ?? 0) }} ETB</p>
        </div>

        <div class="rounded-2xl border border-(--surface-border) p-5" style="background:var(--surface-raised);">
          <p class="text-[10px] font-bold text-white/40 uppercase tracking-widest">Active Players</p>
          <p class="mt-2 text-2xl font-bold text-white tabular-nums">{{ stats?.activePlayers ?? 0 }}</p>
        </div>

      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Commit**

```bash
git add apps/admin/pages/index.vue
git commit -m "feat(admin): rewrite dashboard with two-section financial overview"
```

---

## Task 7: Add Filter Toolbar to Deposits Page

**Files:**
- Modify: `apps/admin/pages/deposits.vue`

- [ ] **Step 1: Add filter state and fetch function update**

At the top of `<script setup>` in `apps/admin/pages/deposits.vue`, add after the existing refs:

```typescript
// Filter state
const filterSearch = ref('')
const filterUserSerial = ref('')
const filterFrom = ref('')
const filterTo = ref('')
const filterMinAmount = ref('')
const filterMaxAmount = ref('')
const filterStatus = ref('')
let searchTimer: ReturnType<typeof setTimeout> | null = null

const page = ref(1)
const totalPages = ref(1)
const LIMIT = 20

const statusOptions = [
  { label: 'Pending Review', value: '' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Declined', value: 'REJECTED' },
]
```

Replace the existing `fetchDeposits` / `onMounted` logic:

```typescript
const fetchDeposits = async () => {
  loading.value = true
  try {
    const result: any = await getPendingDeposits({
      status: filterStatus.value || undefined,
      search: filterSearch.value || undefined,
      userSerial: filterUserSerial.value ? Number(filterUserSerial.value) : undefined,
      from: filterFrom.value || undefined,
      to: filterTo.value || undefined,
      minAmount: filterMinAmount.value ? Number(filterMinAmount.value) : undefined,
      maxAmount: filterMaxAmount.value ? Number(filterMaxAmount.value) : undefined,
      page: page.value,
      limit: LIMIT,
    })
    pendingDeposits.value = result?.data ?? result ?? []
    totalPages.value = result?.pagination?.totalPages ?? 1
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load deposits', color: 'error' })
  } finally {
    loading.value = false
  }
}

const onSearch = () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { page.value = 1; fetchDeposits() }, 400)
}

const resetFilters = () => {
  filterSearch.value = ''
  filterUserSerial.value = ''
  filterFrom.value = ''
  filterTo.value = ''
  filterMinAmount.value = ''
  filterMaxAmount.value = ''
  filterStatus.value = ''
  page.value = 1
  fetchDeposits()
}

watch([page, filterStatus], fetchDeposits)
onMounted(fetchDeposits)
```

- [ ] **Step 2: Add filter toolbar to the template**

In `apps/admin/pages/deposits.vue`, after the `<h1>` header block and before the table, add:

```html
<!-- Filter Toolbar -->
<div class="flex flex-wrap gap-3 bg-white/5 p-3 rounded-2xl border border-white/5 shadow-inner">
  <UInput
    v-model="filterSearch"
    icon="i-heroicons:magnifying-glass"
    placeholder="Search username or phone…"
    class="flex-1 min-w-48"
    @input="onSearch"
  />
  <UInput
    v-model="filterUserSerial"
    placeholder="User ID"
    class="w-28"
    @input="onSearch"
  />
  <UInput
    v-model="filterFrom"
    type="date"
    class="w-40"
    @change="page = 1; fetchDeposits()"
  />
  <UInput
    v-model="filterTo"
    type="date"
    class="w-40"
    @change="page = 1; fetchDeposits()"
  />
  <UInput
    v-model="filterMinAmount"
    type="number"
    placeholder="Min ETB"
    class="w-28"
    @input="onSearch"
  />
  <UInput
    v-model="filterMaxAmount"
    type="number"
    placeholder="Max ETB"
    class="w-28"
    @input="onSearch"
  />
  <USelect
    v-model="filterStatus"
    :items="statusOptions"
    value-key="value"
    class="w-40"
  />
  <UButton color="neutral" variant="ghost" icon="i-heroicons:x-mark" @click="resetFilters">Reset</UButton>
</div>

<!-- Pagination (add below table) -->
<div v-if="totalPages > 1" class="flex items-center justify-between px-1 mt-3">
  <p class="text-sm text-white/40">Page {{ page }} of {{ totalPages }}</p>
  <div class="flex gap-2">
    <UButton size="xs" color="neutral" variant="soft" :disabled="page <= 1" @click="page--">Prev</UButton>
    <UButton size="xs" color="neutral" variant="soft" :disabled="page >= totalPages" @click="page++">Next</UButton>
  </div>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add apps/admin/pages/deposits.vue
git commit -m "feat(admin): add search/filter toolbar to deposits page"
```

---

## Task 8: Add Filter Toolbar to Withdrawals Page

**Files:**
- Modify: `apps/admin/pages/withdrawals.vue`

- [ ] **Step 1: Replace the `<script setup>` block**

The current script calls `getWithdrawals(selectedStatus.value || undefined)` (a string). Replace the entire `<script setup>` in `apps/admin/pages/withdrawals.vue` with:

```typescript
<script setup lang="ts">
interface WithdrawalTransaction {
  id: string
  amount: number
  status: string
  createdAt: string
  note?: string
  user: { username: string; phone: string; serial?: number }
}

const { getWithdrawals, approveTransaction, declineTransaction } = useAdminApi()
const toast = useToast()

const formatUserId = (serial?: number) => {
  if (!serial) return '---'
  return serial.toString().padStart(5, '0')
}

const columns = [
  { accessorKey: 'id', header: 'TX ID' },
  { accessorKey: 'user.serial', header: 'Player ID' },
  { accessorKey: 'user.username', header: 'Username' },
  { accessorKey: 'user.phone', header: 'TeleBirr' },
  { accessorKey: 'amount', header: 'Amount' },
  { accessorKey: 'note', header: 'Bank info' },
  { accessorKey: 'createdAt', header: 'Requested' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'actions', header: 'Actions' }
]

// ── Data ───────────────────────────────────────────────────────────────────
const withdrawals = ref<WithdrawalTransaction[]>([])
const loading = ref(false)
const page = ref(1)
const totalPages = ref(1)
const LIMIT = 20

// ── Modals ──────────────────────────────────────────────────────────────────
const showConfirmModal = ref(false)
const pendingAction = ref<{ id: string; type: 'approve' | 'reject' } | null>(null)
const declineNote = ref('')
const viewMode = ref<'table' | 'card'>('table')

// ── Filters ─────────────────────────────────────────────────────────────────
const filterSearch = ref('')
const filterUserSerial = ref('')
const filterFrom = ref('')
const filterTo = ref('')
const filterMinAmount = ref('')
const filterMaxAmount = ref('')
const filterStatus = ref('PENDING_REVIEW')
let searchTimer: ReturnType<typeof setTimeout> | null = null

const statusOptions = [
  { label: 'Pending Review', value: 'PENDING_REVIEW' },
  { label: 'Approved', value: 'APPROVED' },
  { label: 'Rejected', value: 'REJECTED' },
  { label: 'All', value: '' },
]

// ── Stats ───────────────────────────────────────────────────────────────────
const approvedSum = ref(0)
const pendingCount = computed(() =>
  withdrawals.value.filter(w => w.status === 'PENDING_REVIEW').length
)

// ── Fetch ───────────────────────────────────────────────────────────────────
const refreshWithdrawals = async () => {
  loading.value = true
  try {
    const result: any = await getWithdrawals({
      status: filterStatus.value || undefined,
      search: filterSearch.value || undefined,
      userSerial: filterUserSerial.value ? Number(filterUserSerial.value) : undefined,
      from: filterFrom.value || undefined,
      to: filterTo.value || undefined,
      minAmount: filterMinAmount.value ? Number(filterMinAmount.value) : undefined,
      maxAmount: filterMaxAmount.value ? Number(filterMaxAmount.value) : undefined,
      page: page.value,
      limit: LIMIT,
    })
    withdrawals.value = result?.data ?? result ?? []
    totalPages.value = result?.pagination?.totalPages ?? 1
    approvedSum.value = 0 // fetched separately if needed
  } catch {
    toast.add({ title: 'Error', description: 'Failed to fetch withdrawals', color: 'error' })
  } finally {
    loading.value = false
  }
}

const onSearch = () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { page.value = 1; refreshWithdrawals() }, 400)
}

const resetFilters = () => {
  filterSearch.value = ''
  filterUserSerial.value = ''
  filterFrom.value = ''
  filterTo.value = ''
  filterMinAmount.value = ''
  filterMaxAmount.value = ''
  filterStatus.value = 'PENDING_REVIEW'
  page.value = 1
  refreshWithdrawals()
}

watch([page, filterStatus], refreshWithdrawals)
onMounted(refreshWithdrawals)

// ── Actions ──────────────────────────────────────────────────────────────────
const confirmAction = (id: string, type: 'approve' | 'reject') => {
  pendingAction.value = { id, type }
  declineNote.value = ''
  showConfirmModal.value = true
}

const executeAction = async () => {
  if (!pendingAction.value) return
  const { id, type } = pendingAction.value
  try {
    if (type === 'approve') {
      await approveTransaction(id)
      toast.add({ title: 'Marked as Transferred ✅', description: 'Player has been notified', color: 'success' })
    } else {
      await declineTransaction(id, declineNote.value || undefined)
      toast.add({ title: 'Rejected', description: 'Balance refunded to player wallet', color: 'warning' })
    }
    showConfirmModal.value = false
    refreshWithdrawals()
  } catch (e: any) {
    toast.add({ title: 'Error', description: e?.data?.message ?? 'Action failed', color: 'error' })
  }
}

const copyToClipboard = (text: string) => {
  navigator.clipboard.writeText(text)
  toast.add({ title: 'Copied', color: 'success' })
}
</script>
```

- [ ] **Step 2: Add filter toolbar to the template**

In the template, replace the existing `<!-- Toolbar Filters -->` div (currently just has a status select + alert) with:

```html
<!-- Filter Toolbar -->
<div class="flex flex-wrap gap-3 bg-white/5 p-3 rounded-2xl border border-white/5 shadow-inner">
  <UInput
    v-model="filterSearch"
    icon="i-heroicons:magnifying-glass"
    placeholder="Search username or phone…"
    class="flex-1 min-w-48"
    @input="onSearch"
  />
  <UInput
    v-model="filterUserSerial"
    placeholder="User ID"
    class="w-28"
    @input="onSearch"
  />
  <UInput v-model="filterFrom" type="date" class="w-40" @change="page = 1; refreshWithdrawals()" />
  <UInput v-model="filterTo" type="date" class="w-40" @change="page = 1; refreshWithdrawals()" />
  <UInput
    v-model="filterMinAmount"
    type="number"
    placeholder="Min ETB"
    class="w-28"
    @input="onSearch"
  />
  <UInput
    v-model="filterMaxAmount"
    type="number"
    placeholder="Max ETB"
    class="w-28"
    @input="onSearch"
  />
  <USelect
    v-model="filterStatus"
    :items="statusOptions"
    value-key="value"
    class="w-44"
  />
  <UButton color="neutral" variant="ghost" icon="i-heroicons:x-mark" @click="resetFilters">Reset</UButton>
</div>

<div v-if="filterStatus === 'PENDING_REVIEW'" class="mt-2">
  <UAlert
    icon="i-heroicons:information-circle"
    color="warning"
    variant="soft"
    class="py-1.5"
    title="Manual Settlement"
    description="Send funds via TeleBirr to the phone shown, then click 'Mark Transferred'."
  />
</div>
```

Add pagination after the table/card views (before the `<UModal>`):

```html
<div v-if="totalPages > 1" class="flex items-center justify-between px-1 mt-3">
  <p class="text-sm text-white/40">Page {{ page }} of {{ totalPages }}</p>
  <div class="flex gap-2">
    <UButton size="xs" color="neutral" variant="soft" :disabled="page <= 1" @click="page--">Prev</UButton>
    <UButton size="xs" color="neutral" variant="soft" :disabled="page >= totalPages" @click="page++">Next</UButton>
  </div>
</div>
```

- [ ] **Step 3: Commit**

```bash
git add apps/admin/pages/withdrawals.vue
git commit -m "feat(admin): add search/filter toolbar to withdrawals page"
```

---

## Task 9: House Wallet — Negative Balance Display + Date Filter

**Files:**
- Modify: `apps/admin/pages/house.vue`

- [ ] **Step 1: Add date filter state and update `fetchTransactions`**

In `apps/admin/pages/house.vue`, replace the `txFilter` and `txPage` refs section with:

```typescript
const txPage = ref(1)
const txFilter = ref('')
const txFrom = ref('')
const txTo = ref('')
const txLoading = ref(false)
const transactions = ref<any[]>([])
const txTotal = ref(0)
const TX_LIMIT = 20
```

Replace `fetchTransactions`:

```typescript
const fetchTransactions = async () => {
  txLoading.value = true
  try {
    const data = await getHouseTransactions({
      page: txPage.value,
      limit: TX_LIMIT,
      type: txFilter.value || undefined,
      from: txFrom.value || undefined,
      to: txTo.value || undefined,
    })
    transactions.value = data.transactions ?? []
    txTotal.value = data.total ?? 0
  } catch {
    toast.add({ title: 'Error', description: 'Failed to fetch transactions', color: 'error' })
  } finally {
    txLoading.value = false
  }
}

watch([txPage, txFilter, txFrom, txTo], fetchTransactions)
```

- [ ] **Step 2: Update the balance display to show negative in red**

In the template, replace the balance display section (the `<div class="flex items-end gap-3 mb-6">` block):

```html
<div class="flex items-end gap-3 mb-2">
  <span class="text-5xl font-extrabold tabular-nums"
    :class="Number(balance) < 0 ? 'text-red-400' : 'text-yellow-400'">
    {{ balance }}
  </span>
  <span class="text-xl font-bold mb-1"
    :class="Number(balance) < 0 ? 'text-red-400/60' : 'text-yellow-400/60'">
    ETB
  </span>
</div>
<div v-if="Number(balance) < 0" class="mb-4">
  <UBadge color="error" variant="soft" icon="i-heroicons:exclamation-triangle">
    ⚠ House is in deficit — prizes exceeded commissions
  </UBadge>
</div>
```

- [ ] **Step 3: Add date filters to the transaction history toolbar**

Replace the filter row in the transactions section:

```html
<div class="flex items-center gap-3 flex-wrap">
  <USelect
    v-model="txFilter"
    :items="filterOptions"
    value-key="value"
    size="sm"
    class="w-40"
  />
  <UInput v-model="txFrom" type="date" size="sm" class="w-40" />
  <UInput v-model="txTo" type="date" size="sm" class="w-40" />
  <UButton
    v-if="txFilter || txFrom || txTo"
    size="sm" color="neutral" variant="ghost"
    icon="i-heroicons:x-mark"
    @click="txFilter = ''; txFrom = ''; txTo = ''; txPage = 1"
  >
    Reset
  </UButton>
</div>
```

Also update the backend house transactions route to accept `from`/`to`. In `apps/api/src/routes/admin/index.ts`, replace the `GET /house/transactions` handler:

```typescript
fastify.get('/house/transactions', async (req: any, _reply) => {
    const page = Number(req.query.page ?? 1)
    const limit = Number(req.query.limit ?? 20)
    const type = req.query.type as 'COMMISSION' | 'BOT_PRIZE_WIN' | 'REFUND_ISSUED' | undefined
    const from = req.query.from ? new Date(req.query.from) : undefined
    const to = req.query.to ? new Date(req.query.to) : undefined
    const where: any = {
        ...(type && { type }),
        ...((from || to) && {
            createdAt: {
                ...(from && { gte: from }),
                ...(to && { lte: to }),
            },
        }),
    }
    const [transactions, total] = await Promise.all([
        prisma.houseTransaction.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.houseTransaction.count({ where }),
    ])
    return { transactions, total, page, limit }
})
```

- [ ] **Step 4: Commit**

```bash
git add apps/admin/pages/house.vue apps/api/src/routes/admin/index.ts
git commit -m "feat(admin): negative balance display and date filter on house wallet"
```

---

## Task 10: Money Flow Audit Page (`/money-flow`)

**Files:**
- Create: `apps/admin/pages/money-flow.vue`

- [ ] **Step 1: Create the new page**

Create `apps/admin/pages/money-flow.vue`:

```vue
<script setup lang="ts">
const { getMoneyFlow } = useAdminApi()
const toast = useToast()
const router = useRouter()

// ── State ──────────────────────────────────────────────────────────────────
const loading = ref(false)
const rows = ref<any[]>([])
const total = ref(0)
const page = ref(1)
const LIMIT = 30
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / LIMIT)))

const summary = ref({
  totalDeposited: 0,
  totalWagered: 0,
  totalPrizesOut: 0,
  houseKept: 0,
  refundsIssued: 0,
})

// ── Filters ────────────────────────────────────────────────────────────────
const filterDirection = ref('')
const filterSearch = ref('')
const filterFrom = ref('')
const filterTo = ref('')
const filterTypes = ref<string[]>([])
let searchTimer: ReturnType<typeof setTimeout> | null = null

const TYPE_OPTIONS = [
  'DEPOSIT', 'WITHDRAWAL', 'GAME_ENTRY', 'PRIZE_WIN',
  'COMMISSION', 'BOT_PRIZE_WIN', 'REFUND', 'ADMIN_REAL_ADJUSTMENT',
  'PROVIDER_BET', 'PROVIDER_BET_RESULT',
]

const directionOptions = [
  { label: 'All Directions', value: '' },
  { label: 'IN (received)', value: 'IN' },
  { label: 'OUT (paid)', value: 'OUT' },
]

// ── Fetch ──────────────────────────────────────────────────────────────────
const fetch = async () => {
  loading.value = true
  try {
    const result = await getMoneyFlow({
      page: page.value,
      limit: LIMIT,
      direction: filterDirection.value as 'IN' | 'OUT' | undefined || undefined,
      types: filterTypes.value.length ? filterTypes.value : undefined,
      from: filterFrom.value || undefined,
      to: filterTo.value || undefined,
      search: filterSearch.value || undefined,
    })
    rows.value = result.rows
    total.value = result.total
    summary.value = result.summary
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load money flow', color: 'error' })
  } finally {
    loading.value = false
  }
}

const onSearch = () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { page.value = 1; fetch() }, 400)
}

const resetFilters = () => {
  filterDirection.value = ''
  filterSearch.value = ''
  filterFrom.value = ''
  filterTo.value = ''
  filterTypes.value = []
  page.value = 1
  fetch()
}

const filterByType = (type: string) => {
  filterTypes.value = [type]
  page.value = 1
  fetch()
}

watch([page, filterDirection, filterFrom, filterTo], fetch)
onMounted(fetch)

// ── Helpers ────────────────────────────────────────────────────────────────
const fmt = (n: number) =>
  n.toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const typeColor = (type: string) => {
  if (['DEPOSIT', 'COMMISSION', 'PRIZE_WIN'].includes(type)) return 'success'
  if (['WITHDRAWAL', 'REFUND', 'REFUND_ISSUED'].includes(type)) return 'error'
  if (['GAME_ENTRY', 'BOT_PRIZE_WIN'].includes(type)) return 'warning'
  if (type.startsWith('PROVIDER')) return 'info'
  return 'neutral'
}

const sourceColor = (source: string) => {
  if (source === 'House Wallet') return 'text-yellow-400'
  if (source === 'Provider') return 'text-blue-400'
  return 'text-white/60'
}

const columns = [
  { accessorKey: 'createdAt', header: 'Date' },
  { accessorKey: 'type', header: 'Type' },
  { accessorKey: 'direction', header: 'Dir.' },
  { accessorKey: 'amount', header: 'Amount' },
  { accessorKey: 'playerName', header: 'Player' },
  { accessorKey: 'gameId', header: 'Game' },
  { accessorKey: 'source', header: 'Source' },
  { accessorKey: 'balanceAfter', header: 'Balance After' },
]
</script>

<template>
  <div class="space-y-8 pb-20 md:pb-0">
    <!-- Header -->
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Money Flow</h1>
        <p class="text-sm text-white/50 mt-0.5">Full audit trail — every ETB in and out of the platform</p>
      </div>
      <UButton icon="i-heroicons:arrow-path" color="neutral" variant="ghost" :loading="loading" @click="fetch">
        Refresh
      </UButton>
    </div>

    <!-- ── Flow Summary Chain ────────────────────────────────────────────── -->
    <div class="rounded-2xl border border-(--surface-border) p-6 shadow-xl overflow-x-auto" style="background:var(--surface-raised);">
      <p class="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-5">Platform-Wide Lifetime Flow</p>
      <div class="flex items-center gap-3 min-w-max">

        <button class="text-center group" @click="filterByType('DEPOSIT')">
          <p class="text-[10px] text-white/40 uppercase tracking-widest mb-1">Deposited</p>
          <p class="text-xl font-bold text-green-400 group-hover:text-green-300 transition-colors tabular-nums">
            {{ fmt(summary.totalDeposited) }}
          </p>
          <p class="text-[10px] text-white/30">ETB</p>
        </button>

        <UIcon name="i-heroicons:arrow-right" class="w-5 h-5 text-white/20 flex-shrink-0" />

        <button class="text-center group" @click="filterByType('GAME_ENTRY')">
          <p class="text-[10px] text-white/40 uppercase tracking-widest mb-1">Wagered</p>
          <p class="text-xl font-bold text-yellow-400 group-hover:text-yellow-300 transition-colors tabular-nums">
            {{ fmt(summary.totalWagered) }}
          </p>
          <p class="text-[10px] text-white/30">ETB</p>
        </button>

        <UIcon name="i-heroicons:arrow-right" class="w-5 h-5 text-white/20 flex-shrink-0" />

        <button class="text-center group" @click="filterByType('PRIZE_WIN')">
          <p class="text-[10px] text-white/40 uppercase tracking-widest mb-1">Prizes Out</p>
          <p class="text-xl font-bold text-red-400 group-hover:text-red-300 transition-colors tabular-nums">
            {{ fmt(summary.totalPrizesOut) }}
          </p>
          <p class="text-[10px] text-white/30">ETB</p>
        </button>

        <UIcon name="i-heroicons:arrow-right" class="w-5 h-5 text-white/20 flex-shrink-0" />

        <button class="text-center group" @click="filterByType('COMMISSION')">
          <p class="text-[10px] text-white/40 uppercase tracking-widest mb-1">House Kept</p>
          <p class="text-xl font-bold text-blue-400 group-hover:text-blue-300 transition-colors tabular-nums">
            {{ fmt(summary.houseKept) }}
          </p>
          <p class="text-[10px] text-white/30">ETB</p>
        </button>

        <UIcon name="i-heroicons:arrow-right" class="w-5 h-5 text-white/20 flex-shrink-0" />

        <button class="text-center group" @click="filterByType('REFUND')">
          <p class="text-[10px] text-white/40 uppercase tracking-widest mb-1">Refunds</p>
          <p class="text-xl font-bold text-orange-400 group-hover:text-orange-300 transition-colors tabular-nums">
            {{ fmt(summary.refundsIssued) }}
          </p>
          <p class="text-[10px] text-white/30">ETB</p>
        </button>

      </div>
    </div>

    <!-- ── Filters ───────────────────────────────────────────────────────── -->
    <div class="flex flex-wrap gap-3 bg-white/5 p-3 rounded-2xl border border-white/5 shadow-inner">
      <UInput
        v-model="filterSearch"
        icon="i-heroicons:magnifying-glass"
        placeholder="Search player…"
        class="flex-1 min-w-48"
        @input="onSearch"
      />
      <UInput v-model="filterFrom" type="date" class="w-40" @change="page = 1; fetch()" />
      <UInput v-model="filterTo" type="date" class="w-40" @change="page = 1; fetch()" />
      <USelect
        v-model="filterDirection"
        :items="directionOptions"
        value-key="value"
        class="w-44"
      />
      <UButton
        v-if="filterSearch || filterFrom || filterTo || filterDirection || filterTypes.length"
        color="neutral" variant="ghost" icon="i-heroicons:x-mark"
        @click="resetFilters"
      >
        Reset
      </UButton>
    </div>

    <!-- Active type filter badge -->
    <div v-if="filterTypes.length" class="flex items-center gap-2">
      <span class="text-xs text-white/40">Showing only:</span>
      <UBadge
        v-for="t in filterTypes" :key="t"
        :color="typeColor(t)" variant="soft" size="sm"
        class="cursor-pointer"
        @click="filterTypes = filterTypes.filter(x => x !== t); page = 1; fetch()"
      >
        {{ t }} ✕
      </UBadge>
    </div>

    <!-- ── Unified Ledger ─────────────────────────────────────────────────── -->
    <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl" style="background:var(--surface-raised);">
      <UTable :columns="columns" :data="rows" :loading="loading">

        <template #createdAt-cell="{ row }">
          <span class="text-white/50 text-xs font-mono">
            {{ new Date(row.original.createdAt).toLocaleString() }}
          </span>
        </template>

        <template #type-cell="{ row }">
          <UBadge :color="typeColor(row.original.type)" variant="soft" size="sm">
            {{ row.original.type }}
          </UBadge>
        </template>

        <template #direction-cell="{ row }">
          <span :class="row.original.direction === 'IN' ? 'text-green-400' : 'text-red-400'"
            class="text-xs font-bold">
            {{ row.original.direction === 'IN' ? '▲ IN' : '▼ OUT' }}
          </span>
        </template>

        <template #amount-cell="{ row }">
          <span class="font-bold font-mono tabular-nums"
            :class="row.original.direction === 'IN' ? 'text-green-400' : 'text-red-400'">
            {{ row.original.direction === 'IN' ? '+' : '-' }}{{ Number(row.original.amount).toFixed(2) }} ETB
          </span>
        </template>

        <template #playerName-cell="{ row }">
          <span v-if="row.original.playerName" class="text-white/70 text-sm font-medium">
            {{ row.original.playerName }}
          </span>
          <span v-else class="text-white/20">—</span>
        </template>

        <template #gameId-cell="{ row }">
          <NuxtLink
            v-if="row.original.gameId"
            :to="`/games`"
            class="text-xs font-mono text-blue-400 hover:text-blue-300 transition-colors"
            :title="row.original.gameId"
          >
            {{ row.original.gameId.slice(0, 8) }}…
          </NuxtLink>
          <span v-else class="text-white/20">—</span>
        </template>

        <template #source-cell="{ row }">
          <span class="text-xs font-medium" :class="sourceColor(row.original.source)">
            {{ row.original.source }}
          </span>
        </template>

        <template #balanceAfter-cell="{ row }">
          <span v-if="row.original.balanceAfter !== undefined" class="font-mono text-white/50 text-sm">
            {{ Number(row.original.balanceAfter).toFixed(2) }}
          </span>
          <span v-else class="text-white/20">—</span>
        </template>

      </UTable>

      <div v-if="rows.length === 0 && !loading" class="py-16 text-center text-white/30">
        <UIcon name="i-heroicons:arrows-right-left" class="w-10 h-10 mx-auto mb-3 opacity-20" />
        <p>No transactions found</p>
      </div>
    </div>

    <!-- Pagination -->
    <div class="flex items-center justify-between px-1">
      <p class="text-sm text-white/40">{{ total }} total entries</p>
      <div class="flex items-center gap-2">
        <UButton size="xs" color="neutral" variant="soft" :disabled="page <= 1" @click="page--">Previous</UButton>
        <span class="text-sm text-white/60 font-mono">{{ page }} / {{ totalPages }}</span>
        <UButton size="xs" color="neutral" variant="soft" :disabled="page >= totalPages" @click="page++">Next</UButton>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Commit**

```bash
git add apps/admin/pages/money-flow.vue
git commit -m "feat(admin): add Money Flow audit page with flow summary and unified ledger"
```

---

## Task 11: Final Verification

- [ ] **Step 1: Run full backend test suite**

```bash
cd apps/api && pnpm test
```

Expected: All tests pass with no regressions.

- [ ] **Step 2: Run typecheck across the monorepo**

```bash
cd /path/to/repo && pnpm typecheck
```

Expected: No TypeScript errors.

- [ ] **Step 3: Smoke-test the admin app locally**

Start infra and apps:
```bash
pnpm infra:up
pnpm --filter @world-bingo/api dev &
pnpm --filter @world-bingo/admin dev
```

Verify:
1. Sidebar shows Finance group (Deposits, Withdrawals, House Wallet, Money Flow) and Games group
2. Dashboard shows Section A (Money In/Out with provider table) and Section B (Game Performance)
3. Deposits page has 7-filter toolbar; results update on filter change
4. Withdrawals page has same toolbar
5. House Wallet balance turns red with deficit badge when balance < 0; date filters work
6. Money Flow page loads with flow summary chain; clicking a number filters the ledger

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -p
git commit -m "fix(admin): post-smoke-test adjustments"
```
