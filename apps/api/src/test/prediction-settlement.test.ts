import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'

/**
 * Settlement, void and the fee.
 *
 * `computeSettlement` is pure and is tested directly — it is the entire payout
 * formula and every winning birr in the feature goes through it.
 *
 * The `settleMarket` / `voidMarket` cases run against an in-memory Prisma double
 * whose `$transaction` rolls back on throw, because the properties under test
 * are exactly the ones a naive mock would fake away: that a second settle pays
 * nothing, that a crashed batch leaves no half-paid position behind, and that a
 * void returns bonus as bonus.
 *
 * `shareValue` and `feePct` come off the MARKET ROW everywhere; a market in this
 * file settles at 50 ETB a share with a 20% fee to prove neither is pinned.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('redlock', () => {
    class FakeRedlock {
        on() {}
        async acquire() {
            return { unlock: async () => {}, extend: async () => {} }
        }
    }
    return { default: FakeRedlock }
})

vi.mock('../lib/redis.js', () => ({
    default: { get: vi.fn(), set: vi.fn(), del: vi.fn(), eval: vi.fn(), on: vi.fn() },
}))

const queueMock = vi.hoisted(() => ({
    addBulk: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({}),
    getJob: vi.fn().mockResolvedValue(null),
}))

vi.mock('../lib/queue.js', () => ({
    getQueue: () => queueMock,
    QUEUE_NAMES: { NOTIFICATION: 'notification', PREDICTION: 'prediction' },
}))

const sentryMock = vi.hoisted(() => ({ reportError: vi.fn() }))
vi.mock('../lib/sentry.js', () => sentryMock)

const gatewayMock = vi.hoisted(() => ({
    emitBook: vi.fn(),
    emitTrade: vi.fn(),
    emitStatus: vi.fn(),
    emitSettled: vi.fn(),
}))
vi.mock('../gateways/prediction.gateway.js', () => gatewayMock)

/**
 * `BonusService.restore` is production code with its own dedicated real-DB
 * coverage (bonus.service.test.ts) — lot creation against `bonus_grants`, a
 * table this in-memory double does not model. What `refundOpenOrders` needs
 * verified HERE is only its own contract with `restore`: pass the released
 * amount, apply the resulting balance to the wallet, and pass through
 * whatever expiry it looked up from the order's original hold — not a fresh
 * one. This fake reproduces exactly that observable surface against the same
 * double `tx` the rest of the suite uses, the same way redlock/redis/the
 * queue/sentry/the gateway are faked above rather than run for real.
 */
vi.mock('../services/bonus.service.js', () => ({
    BonusService: {
        restore: vi.fn(async (tx: any, userId: string, amount: any, expiresAt: Date | null) => {
            const rows = await tx.$queryRaw`SELECT "bonusBalance" FROM wallets WHERE "userId" = ${userId}`
            const before = new Decimal(rows[0]?.bonusBalance ?? 0)
            const restored = new Decimal(amount)
            const after = before.plus(restored)
            await tx.wallet.update({ where: { userId }, data: { bonusBalance: after } })
            return { granted: restored, bonusBalanceBefore: before, bonusBalanceAfter: after, expiresAt }
        }),
    },
}))

const holder = vi.hoisted(() => ({ client: null as any }))

vi.mock('../lib/prisma.js', () => ({
    default: new Proxy(
        {},
        {
            get: (_target, prop) => holder.client[prop],
            has: (_target, prop) => prop in holder.client,
        },
    ),
}))

import { PredictionSettlementService, round2 } from '../services/prediction/settlement.service.js'
import { BonusService } from '../services/bonus.service.js'

const db = createStore()
holder.client = db.client

// ── In-memory Prisma ──────────────────────────────────────────────────────────

function createStore() {
    type Row = Record<string, any>

    const isDec = (v: any): boolean =>
        !!v &&
        typeof v === 'object' &&
        typeof v.toFixed === 'function' &&
        typeof v.comparedTo === 'function'

    const dec = (v: any) => new Decimal(v as any)

    const eq = (a: any, b: any): boolean => {
        if (a === null || a === undefined || b === null || b === undefined) {
            return (a ?? null) === (b ?? null)
        }
        if (isDec(a) || isDec(b)) return dec(a).equals(dec(b))
        if (a instanceof Date || b instanceof Date) {
            return new Date(a).getTime() === new Date(b).getTime()
        }
        return a === b
    }

    const cmp = (a: any, b: any): number => {
        if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1
        if (b === null || b === undefined) return 1
        if (isDec(a) || isDec(b)) return dec(a).comparedTo(dec(b))
        if (a instanceof Date || b instanceof Date) {
            return new Date(a).getTime() - new Date(b).getTime()
        }
        if (typeof a === 'string') return a < b ? -1 : a > b ? 1 : 0
        return a - b
    }

    const OPS = new Set(['equals', 'in', 'notIn', 'not', 'gt', 'gte', 'lt', 'lte', 'mode', 'contains'])

    const isOpNode = (cond: any): boolean =>
        !!cond &&
        typeof cond === 'object' &&
        !Array.isArray(cond) &&
        !(cond instanceof Date) &&
        !isDec(cond) &&
        Object.keys(cond).length > 0 &&
        Object.keys(cond).every((k) => OPS.has(k))

    function matches(row: Row, where: any): boolean {
        if (!where) return true
        for (const [key, cond] of Object.entries(where)) {
            if (key === 'AND') {
                if (!(cond as any[]).every((c) => matches(row, c))) return false
                continue
            }
            if (key === 'OR') {
                if (!(cond as any[]).some((c) => matches(row, c))) return false
                continue
            }
            if (key === 'NOT') {
                if (matches(row, cond)) return false
                continue
            }
            const value = row[key]
            if (isOpNode(cond)) {
                for (const [op, operand] of Object.entries(cond as Row)) {
                    if (op === 'equals' && !eq(value, operand)) return false
                    if (op === 'in' && !(operand as any[]).some((v) => eq(value, v))) return false
                    if (op === 'notIn' && (operand as any[]).some((v) => eq(value, v))) return false
                    if (op === 'not') {
                        if (isOpNode(operand)) {
                            if (matches(row, { [key]: operand })) return false
                        } else if (eq(value, operand)) return false
                    }
                    if (op === 'gt' && !(cmp(value, operand) > 0)) return false
                    if (op === 'gte' && !(cmp(value, operand) >= 0)) return false
                    if (op === 'lt' && !(cmp(value, operand) < 0)) return false
                    if (op === 'lte' && !(cmp(value, operand) <= 0)) return false
                    if (
                        op === 'contains' &&
                        !(typeof value === 'string' && typeof operand === 'string' && value.includes(operand))
                    ) {
                        return false
                    }
                }
                continue
            }
            if (!eq(value, cond)) return false
        }
        return true
    }

    function sortRows(rows: Row[], orderBy: any): Row[] {
        if (!orderBy) return [...rows]
        const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((s: Row) =>
            Object.entries(s),
        )
        return [...rows].sort((a, b) => {
            for (const [field, dir] of specs) {
                const c = cmp(a[field], b[field])
                if (c !== 0) return dir === 'desc' ? -c : c
            }
            return 0
        })
    }

    function applyData(row: Row, data: Row): void {
        for (const [key, value] of Object.entries(data)) {
            if (
                value && typeof value === 'object' && !Array.isArray(value) &&
                !(value instanceof Date) && !isDec(value)
            ) {
                if ('increment' in value) {
                    row[key] = isDec(row[key]) || isDec((value as Row).increment)
                        ? dec(row[key]).plus(dec((value as Row).increment))
                        : row[key] + (value as Row).increment
                    continue
                }
                if ('set' in value) {
                    row[key] = (value as Row).set
                    continue
                }
            }
            row[key] = value
        }
        row.updatedAt = new Date()
    }

    const tables: Record<string, Row[]> = {
        wallet: [],
        transaction: [],
        houseTransaction: [],
        predictionMarket: [],
        predictionOutcome: [],
        predictionOrder: [],
        predictionPosition: [],
    }

    const defaults: Record<string, Row> = {
        wallet: { realBalance: dec(0), bonusBalance: dec(0) },
        transaction: {},
        houseTransaction: {},
        predictionMarket: { status: 'DRAFT', totalShares: 0, totalVolume: dec(0) },
        predictionOutcome: { lastPrice: null },
        predictionOrder: {
            filledQuantity: 0, reservedReal: dec(0), reservedBonus: dec(0), status: 'OPEN',
        },
        predictionPosition: {
            shares: 0, costBasisReal: dec(0), costBasisBonus: dec(0),
            status: 'OPEN', payout: dec(0), feePaid: dec(0),
        },
    }

    const house = { balance: dec(0) }

    let ids = 0
    let clock = 0
    const nextId = (model: string) => `${model}-${(ids += 1)}`
    const nextTime = () => new Date(1_800_000_000_000 + (clock += 1))

    function expandWhere(where: any): Row {
        const out: Row = {}
        for (const [key, value] of Object.entries(where ?? {})) {
            if (
                key.includes('_') && value && typeof value === 'object' &&
                !isOpNode(value) && !(value instanceof Date) && !isDec(value)
            ) {
                Object.assign(out, value)
                continue
            }
            out[key] = value
        }
        return out
    }

    const relations: Record<string, Record<string, (row: Row) => any>> = {
        predictionMarket: {
            outcomes: (row) =>
                sortRows(tables.predictionOutcome.filter((o) => o.marketId === row.id), {
                    sortOrder: 'asc',
                }),
        },
        predictionOrder: {
            market: (row) => tables.predictionMarket.find((m) => m.id === row.marketId) ?? null,
            outcome: (row) => tables.predictionOutcome.find((o) => o.id === row.outcomeId) ?? null,
        },
    }

    function project(model: string, row: Row | null, args: any): any {
        if (!row) return null
        const out: Row = { ...row }
        if (args?.include) {
            for (const [rel, spec] of Object.entries(args.include)) {
                if (!spec) continue
                const resolve = relations[model]?.[rel]
                if (!resolve) continue
                const value = resolve(row)
                out[rel] = Array.isArray(value)
                    ? value.map((r) => ({ ...r }))
                    : value ? { ...value } : null
            }
        }
        if (args?.select) {
            const picked: Row = {}
            for (const [key, want] of Object.entries(args.select)) {
                if (!want) continue
                picked[key] = out[key]
            }
            return picked
        }
        return out
    }

    function model(name: string) {
        const rows = () => tables[name]
        const find = (where: any) => rows().find((r) => matches(r, expandWhere(where))) ?? null

        return {
            findUnique: async (args: any) => project(name, find(args.where), args),
            findFirst: async (args: any = {}) => {
                const list = sortRows(
                    rows().filter((r) => matches(r, expandWhere(args.where))),
                    args.orderBy,
                )
                return project(name, list[0] ?? null, args)
            },
            findMany: async (args: any = {}) => {
                let list = sortRows(
                    rows().filter((r) => matches(r, expandWhere(args.where))),
                    args.orderBy,
                )
                if (args.take !== undefined) list = list.slice(0, args.take)
                return list.map((r) => project(name, r, args))
            },
            create: async (args: any) => {
                const row: Row = {
                    id: nextId(name),
                    ...defaults[name],
                    ...args.data,
                    createdAt: args.data.createdAt ?? nextTime(),
                    updatedAt: nextTime(),
                }
                rows().push(row)
                return project(name, row, args)
            },
            update: async (args: any) => {
                const row = find(args.where)
                if (!row) throw new Error(`${name} not found`)
                applyData(row, args.data)
                return project(name, row, args)
            },
            updateMany: async (args: any) => {
                const list = rows().filter((r) => matches(r, expandWhere(args.where)))
                for (const row of list) applyData(row, args.data)
                return { count: list.length }
            },
            aggregate: async (args: any) => {
                const list = rows().filter((r) => matches(r, expandWhere(args.where)))
                const sum: Row = {}
                for (const field of Object.keys(args._sum ?? {})) {
                    if (list.length === 0) {
                        sum[field] = null
                        continue
                    }
                    sum[field] = isDec(list[0][field])
                        ? list.reduce((acc: Decimal, r: Row) => acc.plus(dec(r[field])), dec(0))
                        : list.reduce((acc: number, r: Row) => acc + (r[field] ?? 0), 0)
                }
                return { _sum: sum }
            },
        }
    }

    const snapshot = () =>
        Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))

    const client: Row = {}
    for (const name of Object.keys(tables)) client[name] = model(name)

    client.$queryRaw = async (strings: any, ...values: any[]) => {
        const sql = Array.isArray(strings) ? strings.join(' ? ') : String(strings)
        if (/house_wallet/i.test(sql)) return [{ balance: house.balance }]
        if (/FROM wallets/i.test(sql)) {
            const wallet = tables.wallet.find((w) => w.userId === values[0])
            return wallet
                ? [{
                    id: wallet.id,
                    realBalance: wallet.realBalance,
                    bonusBalance: wallet.bonusBalance,
                }]
                : []
        }
        return []
    }

    client.$executeRaw = async (strings: any, ...values: any[]) => {
        const sql = Array.isArray(strings) ? strings.join(' ? ') : String(strings)
        if (/UPDATE house_wallet/i.test(sql)) house.balance = dec(values[0])
        return 1
    }

    client.$transaction = async (arg: any) => {
        if (Array.isArray(arg)) return Promise.all(arg)
        const snap = snapshot()
        const houseBefore = house.balance
        try {
            return await arg(client)
        } catch (err) {
            for (const [k, v] of Object.entries(snap)) tables[k] = v
            house.balance = houseBefore
            throw err
        }
    }

    return {
        client,
        tables,
        house,
        reset: () => {
            for (const key of Object.keys(tables)) tables[key] = []
            house.balance = dec(0)
            ids = 0
            clock = 0
        },
    }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const D = (v: number | string) => new Decimal(v)

const HOUR = 3_600_000

interface Seeded {
    marketId: string
    outcomeA: string
    outcomeB: string
}

function seedMarket(overrides: Record<string, any> = {}): Seeded {
    const id = `market-${db.tables.predictionMarket.length + 1}`
    db.tables.predictionMarket.push({
        id,
        eventName: 'ETFC Fight Night',
        question: 'Sedo vs Johnny — who wins?',
        status: 'RESOLVING',
        closesAt: new Date(Date.now() - HOUR),
        shareValue: D(100),
        feePct: D(15),
        totalShares: 0,
        totalVolume: D(0),
        winningOutcomeId: null,
        resolvedAt: new Date(Date.now() - HOUR),
        disputeUntil: new Date(Date.now() - 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    })
    db.tables.predictionOutcome.push(
        { id: `${id}-a`, marketId: id, label: 'Sedo', sortOrder: 0, lastPrice: null },
        { id: `${id}-b`, marketId: id, label: 'Johnny', sortOrder: 1, lastPrice: null },
    )
    return { marketId: id, outcomeA: `${id}-a`, outcomeB: `${id}-b` }
}

function seedUser(userId: string, real = 0, bonus = 0): string {
    db.tables.wallet.push({
        id: `wallet-${userId}`, userId, realBalance: D(real), bonusBalance: D(bonus),
    })
    return userId
}

function seedPosition(
    marketId: string,
    outcomeId: string,
    userId: string,
    shares: number,
    basisReal: number,
    basisBonus = 0,
    overrides: Record<string, any> = {},
) {
    const row = {
        id: `position-${db.tables.predictionPosition.length + 1}`,
        marketId,
        outcomeId,
        userId,
        shares,
        costBasisReal: D(basisReal),
        costBasisBonus: D(basisBonus),
        status: 'OPEN',
        payout: D(0),
        feePaid: D(0),
        settledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    }
    db.tables.predictionPosition.push(row)
    return row
}

function seedOrder(
    marketId: string,
    outcomeId: string,
    userId: string,
    limitPrice: number,
    quantity: number,
    overrides: Record<string, any> = {},
) {
    const row = {
        id: `order-${db.tables.predictionOrder.length + 1}`,
        marketId,
        outcomeId,
        userId,
        limitPrice: D(limitPrice),
        quantity,
        filledQuantity: 0,
        reservedReal: D(limitPrice * quantity),
        reservedBonus: D(0),
        status: 'OPEN',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    }
    db.tables.predictionOrder.push(row)
    return row
}

function walletOf(userId: string) {
    const wallet = db.tables.wallet.find((w) => w.userId === userId)!
    return { real: wallet.realBalance.toString(), bonus: wallet.bonusBalance.toString() }
}

function positionFor(userId: string) {
    return db.tables.predictionPosition.find((p) => p.userId === userId)!
}

function marketRow(marketId: string) {
    return db.tables.predictionMarket.find((m) => m.id === marketId)!
}

beforeEach(() => {
    db.reset()
    vi.clearAllMocks()
})

// ── computeSettlement — the payout formula ────────────────────────────────────

describe('computeSettlement — fee is charged on profit, not gross', () => {
    it('takes 15% of (gross - basis)', () => {
        const result = PredictionSettlementService.computeSettlement(10, D(100), D(350), D(15))

        expect(result.gross.toString()).toBe('1000')
        expect(result.profit.toString()).toBe('650')
        expect(result.fee.toString()).toBe('97.5')
        expect(result.net.toString()).toBe('902.5')
        // The player keeps the stake plus profit-after-fee.
        expect(result.net.minus(D(350)).toString()).toBe('552.5')
    })

    it('leaves a share bought at 90 ETB profitable after the fee', () => {
        // At 15% of GROSS this would pay 85 and lose the player 5 birr.
        const result = PredictionSettlementService.computeSettlement(1, D(100), D(90), D(15))

        expect(result.profit.toString()).toBe('10')
        expect(result.fee.toString()).toBe('1.5')
        expect(result.net.toString()).toBe('98.5')
        expect(result.net.greaterThan(D(90))).toBe(true)
    })

    it('keeps EVERY legal price in the book winnable', () => {
        for (let price = 1; price <= 99; price += 1) {
            const result = PredictionSettlementService.computeSettlement(
                1, D(100), D(price), D(15),
            )
            expect(result.net.greaterThan(D(price))).toBe(true)
        }
    })

    it('clamps profit at zero rather than paying a negative fee', () => {
        // A corrupted basis above gross must not turn the fee into a credit.
        const result = PredictionSettlementService.computeSettlement(1, D(100), D(140), D(15))

        expect(result.profit.toString()).toBe('0')
        expect(result.fee.toString()).toBe('0')
        expect(result.net.toString()).toBe('100')
    })

    it('charges nothing when the position broke even', () => {
        const result = PredictionSettlementService.computeSettlement(5, D(100), D(500), D(15))

        expect(result.profit.toString()).toBe('0')
        expect(result.fee.toString()).toBe('0')
        expect(result.net.toString()).toBe('500')
    })

    it('honours a zero fee percentage', () => {
        const result = PredictionSettlementService.computeSettlement(3, D(100), D(90), D(0))

        expect(result.fee.toString()).toBe('0')
        expect(result.net.toString()).toBe('300')
    })

    it('rounds the fee to the cent, half up', () => {
        // profit 33.34 × 15% = 5.001 → 5.00
        expect(
            PredictionSettlementService.computeSettlement(1, D(100), D('66.66'), D(15)).fee
                .toString(),
        ).toBe('5')
        // profit 33.30 × 15% = 4.995 → 5.00 (half UP, not half even)
        expect(
            PredictionSettlementService.computeSettlement(1, D(100), D('66.70'), D(15)).fee
                .toString(),
        ).toBe('5')
        expect(round2(D('4.995')).toString()).toBe('5')
        expect(round2(D('0.145')).toString()).toBe('0.15')
    })

    it('computes everything from the given shareValue, never from 100', () => {
        // 4 shares at a 50 ETB share: gross 200, basis 80, profit 120, fee 18.
        const result = PredictionSettlementService.computeSettlement(4, D(50), D(80), D(15))

        expect(result.gross.toString()).toBe('200')
        expect(result.profit.toString()).toBe('120')
        expect(result.fee.toString()).toBe('18')
        expect(result.net.toString()).toBe('182')
    })

    it('keeps every legal price winnable on a 50 ETB share too', () => {
        for (let price = 1; price <= 49; price += 1) {
            const result = PredictionSettlementService.computeSettlement(1, D(50), D(price), D(15))
            expect(result.net.greaterThan(D(price))).toBe(true)
        }
    })

    it('pays exactly gross when a position has no basis recorded', () => {
        const result = PredictionSettlementService.computeSettlement(2, D(100), D(0), D(15))

        expect(result.fee.toString()).toBe('30')
        expect(result.net.toString()).toBe('170')
    })
})

// ── settleMarket ──────────────────────────────────────────────────────────────

describe('settleMarket', () => {
    it('pays the winning side its gross less the fee on profit, and marks losers LOST', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket({
            totalShares: 10,
            totalVolume: D(1000),
            winningOutcomeId: `market-1-a`,
        })
        seedUser('alice', 700)
        seedUser('bob', 300)
        seedPosition(marketId, outcomeA, 'alice', 10, 300)
        seedPosition(marketId, outcomeB, 'bob', 10, 700)

        const result = await PredictionSettlementService.settleMarket(marketId)

        // gross 1000, basis 300, profit 700, fee 105, net 895.
        expect(result.settled).toBe(true)
        expect(result.positionsWon).toBe(1)
        expect(result.positionsLost).toBe(1)
        expect(result.totalFee.toString()).toBe('105')

        expect(walletOf('alice')).toEqual({ real: '1595', bonus: '0' })
        expect(walletOf('bob')).toEqual({ real: '300', bonus: '0' })

        const winner = positionFor('alice')
        expect(winner.status).toBe('WON')
        expect(winner.payout.toString()).toBe('895')
        expect(winner.feePaid.toString()).toBe('105')

        const loser = positionFor('bob')
        expect(loser.status).toBe('LOST')
        expect(loser.payout.toString()).toBe('0')

        expect(marketRow(marketId).status).toBe('SETTLED')
        expect(gatewayMock.emitSettled).toHaveBeenCalledWith(marketId, outcomeA, 10, result.totalFee)
    })

    it('pays out gross equal to the total escrow before the fee is carved off', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket({
            totalShares: 10, totalVolume: D(1000), winningOutcomeId: 'market-1-a',
        })
        seedUser('alice', 0)
        seedUser('carol', 0)
        seedUser('bob', 0)
        seedPosition(marketId, outcomeA, 'alice', 6, 180)
        seedPosition(marketId, outcomeA, 'carol', 4, 120)
        seedPosition(marketId, outcomeB, 'bob', 10, 700)

        await PredictionSettlementService.settleMarket(marketId)

        const winners = db.tables.predictionPosition.filter((p) => p.status === 'WON')
        const gross = winners.reduce(
            (acc, p) => acc.plus(D(p.payout)).plus(D(p.feePaid)),
            D(0),
        )
        // Winning-side gross == totalShares × shareValue == every escrowed birr.
        expect(gross.toString()).toBe('1000')
        expect(gross.toString()).toBe(marketRow(marketId).totalVolume.toString())
        // Losers fund it exactly; the house takes only the winners' profit.
        expect(db.house.balance.toString()).toBe('105')
    })

    it('credits real balance only, even for a bonus-funded position', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket({
            totalShares: 5, totalVolume: D(500), winningOutcomeId: 'market-1-a',
        })
        seedUser('alice', 10, 40)
        seedUser('bob', 0)
        // Alice's 150 basis was entirely promotional credit.
        seedPosition(marketId, outcomeA, 'alice', 5, 0, 150)
        seedPosition(marketId, outcomeB, 'bob', 5, 350)

        await PredictionSettlementService.settleMarket(marketId)

        // gross 500, profit 350, fee 52.50, net 447.50 — all of it cash.
        expect(walletOf('alice')).toEqual({ real: '457.5', bonus: '40' })

        const win = db.tables.transaction.find((t) => t.type === 'PREDICTION_WIN')!
        expect(win.amount.toString()).toBe('447.5')
        expect(win.bonusBalanceBefore.toString()).toBe(win.bonusBalanceAfter.toString())
    })

    it('uses the market s own feePct and shareValue, not the defaults', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket({
            shareValue: D(50),
            feePct: D(20),
            totalShares: 10,
            totalVolume: D(500),
            winningOutcomeId: 'market-1-a',
        })
        seedUser('alice', 0)
        seedUser('bob', 0)
        seedPosition(marketId, outcomeA, 'alice', 10, 200)
        seedPosition(marketId, outcomeB, 'bob', 10, 300)

        const result = await PredictionSettlementService.settleMarket(marketId)

        // gross = 10 × 50 = 500 (not 1000); profit 300; fee 20% = 60; net 440.
        expect(positionFor('alice').payout.toString()).toBe('440')
        expect(result.totalFee.toString()).toBe('60')
        expect(walletOf('alice')).toEqual({ real: '440', bonus: '0' })
    })

    it('books the house fee exactly once', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket({
            totalShares: 10, totalVolume: D(1000), winningOutcomeId: 'market-1-a',
        })
        seedUser('alice', 0)
        seedUser('bob', 0)
        seedPosition(marketId, outcomeA, 'alice', 10, 300)
        seedPosition(marketId, outcomeB, 'bob', 10, 700)

        await PredictionSettlementService.settleMarket(marketId)

        const booked = db.tables.houseTransaction.filter((h) => h.type === 'PREDICTION_FEE')
        expect(booked).toHaveLength(1)
        expect(booked[0].amount.toString()).toBe('105')
        expect(booked[0].gameId).toBe(marketId)
        expect(db.house.balance.toString()).toBe('105')
    })

    it('refunds every still-open order before paying anyone', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket({
            totalShares: 5, totalVolume: D(500), winningOutcomeId: 'market-1-a',
        })
        seedUser('alice', 0)
        seedUser('bob', 0)
        seedUser('dave', 100, 50)
        seedPosition(marketId, outcomeA, 'alice', 5, 150)
        seedPosition(marketId, outcomeB, 'bob', 5, 350)
        // Never matched — that money was never at risk on the result.
        seedOrder(marketId, outcomeA, 'dave', 20, 10, {
            reservedReal: D(120), reservedBonus: D(80),
        })

        const result = await PredictionSettlementService.settleMarket(marketId)

        expect(result.ordersRefunded).toBe(1)
        expect(db.tables.predictionOrder[0].status).toBe('CANCELLED')
        // Refunded in the buckets it was held in: 120 real, 80 bonus.
        expect(walletOf('dave')).toEqual({ real: '220', bonus: '130' })
        // And the depth those cancelled orders made up is pushed out, since a
        // settled market never fills again to correct it later.
        expect(gatewayMock.emitBook).toHaveBeenCalledWith(marketId)
    })

    it('stops paying when the resolution is reversed mid-run', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket({
            totalShares: 10, totalVolume: D(1000), winningOutcomeId: 'market-1-a',
        })
        seedUser('alice', 0)
        seedUser('bob', 0)
        seedPosition(marketId, outcomeA, 'alice', 10, 300)
        seedPosition(marketId, outcomeB, 'bob', 10, 700)

        // The admin unresolves at the very edge of the dispute window, after
        // settlement read the market but before it paid anyone.
        const originalFindMany = db.client.predictionPosition.findMany
        let fired = false
        db.client.predictionPosition.findMany = async (args: any) => {
            const rows = await originalFindMany(args)
            if (!fired && rows.length > 0) {
                fired = true
                Object.assign(marketRow(marketId), {
                    status: 'CLOSED', winningOutcomeId: null, disputeUntil: null,
                })
            }
            return rows
        }

        try {
            const result = await PredictionSettlementService.settleMarket(marketId)
            expect(result).toMatchObject({ settled: false, reason: 'resolution_reversed' })
        } finally {
            db.client.predictionPosition.findMany = originalFindMany
        }

        // Nobody was paid, nobody was marked LOST, and no fee was booked — a
        // payout that raced a reversal would have left the market CLOSED with
        // its winners already credited, ready for the other side to be paid too.
        expect(walletOf('alice')).toEqual({ real: '0', bonus: '0' })
        expect(positionFor('alice').status).toBe('OPEN')
        expect(positionFor('bob').status).toBe('OPEN')
        expect(db.tables.houseTransaction).toHaveLength(0)
        expect(marketRow(marketId).status).toBe('CLOSED')
    })

    it('refuses a market that is not RESOLVING', async () => {
        for (const status of ['DRAFT', 'OPEN', 'CLOSED', 'SETTLED', 'VOIDED']) {
            const { marketId } = seedMarket({ status, winningOutcomeId: null })
            const result = await PredictionSettlementService.settleMarket(marketId)
            expect(result.settled).toBe(false)
            expect(result.reason).toBe(`market_status_${status}`)
        }
    })

    it('refuses while the dispute window is still open', async () => {
        const { marketId } = seedMarket({
            winningOutcomeId: 'market-1-a',
            disputeUntil: new Date(Date.now() + HOUR),
        })
        seedUser('alice', 0)
        seedPosition(marketId, 'market-1-a', 'alice', 1, 30)

        const result = await PredictionSettlementService.settleMarket(marketId)

        expect(result).toMatchObject({ settled: false, reason: 'dispute_window_open' })
        expect(positionFor('alice').status).toBe('OPEN')
        expect(walletOf('alice')).toEqual({ real: '0', bonus: '0' })
    })

    it('refuses a RESOLVING market with no winning outcome', async () => {
        const { marketId } = seedMarket({ winningOutcomeId: null })

        const result = await PredictionSettlementService.settleMarket(marketId)

        expect(result).toMatchObject({ settled: false, reason: 'no_winning_outcome' })
    })

    it('reports an unknown market rather than throwing', async () => {
        const result = await PredictionSettlementService.settleMarket('nope')

        expect(result).toMatchObject({ settled: false, reason: 'market_not_found' })
    })

    it('reports a solvency breach instead of silently paying from the wrong pocket', async () => {
        // 10 shares claim 1000 of escrow but only 400 of basis is recorded.
        const { marketId, outcomeA, outcomeB } = seedMarket({
            totalShares: 10, totalVolume: D(1000), winningOutcomeId: 'market-1-a',
        })
        seedUser('alice', 0)
        seedUser('bob', 0)
        seedPosition(marketId, outcomeA, 'alice', 10, 300)
        seedPosition(marketId, outcomeB, 'bob', 1, 100)

        await PredictionSettlementService.settleMarket(marketId)

        expect(sentryMock.reportError).toHaveBeenCalled()
        const messages = sentryMock.reportError.mock.calls.map((c: any[]) => String(c[0]?.message))
        expect(messages.some((m) => m.includes('SOLVENCY BREACH'))).toBe(true)
    })
})

// ── Idempotency ───────────────────────────────────────────────────────────────

describe('settleMarket — idempotency', () => {
    function seedSettleable() {
        const seeded = seedMarket({
            totalShares: 10, totalVolume: D(1000), winningOutcomeId: 'market-1-a',
        })
        seedUser('alice', 0)
        seedUser('bob', 0)
        seedPosition(seeded.marketId, seeded.outcomeA, 'alice', 10, 300)
        seedPosition(seeded.marketId, seeded.outcomeB, 'bob', 10, 700)
        return seeded
    }

    it('pays once when settle runs twice', async () => {
        const { marketId } = seedSettleable()

        await PredictionSettlementService.settleMarket(marketId)
        const second = await PredictionSettlementService.settleMarket(marketId)

        // The second run bounces off the status guard without touching money.
        expect(second.settled).toBe(false)
        expect(second.reason).toBe('market_status_SETTLED')
        expect(walletOf('alice')).toEqual({ real: '895', bonus: '0' })
        expect(db.tables.transaction.filter((t) => t.type === 'PREDICTION_WIN')).toHaveLength(1)
        expect(db.tables.houseTransaction).toHaveLength(1)
    })

    it('pays once even when the market is forced back to RESOLVING', async () => {
        // Belt and braces: the per-POSITION guard must hold on its own, without
        // help from the market status.
        const { marketId } = seedSettleable()

        await PredictionSettlementService.settleMarket(marketId)
        marketRow(marketId).status = 'RESOLVING'
        await PredictionSettlementService.settleMarket(marketId)

        expect(walletOf('alice')).toEqual({ real: '895', bonus: '0' })
        expect(db.tables.transaction.filter((t) => t.type === 'PREDICTION_WIN')).toHaveLength(1)
        expect(db.tables.houseTransaction).toHaveLength(1)
        expect(db.house.balance.toString()).toBe('105')
    })

    it('resumes after a crash mid-batch without paying the already-paid twice', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket({
            totalShares: 10, totalVolume: D(1000), winningOutcomeId: 'market-1-a',
        })
        seedUser('alice', 0)
        seedUser('carol', 0)
        seedUser('bob', 0)
        seedPosition(marketId, outcomeA, 'alice', 6, 180)
        seedPosition(marketId, outcomeA, 'carol', 4, 120)
        seedPosition(marketId, outcomeB, 'bob', 10, 700)

        // Crash while crediting the second winner.
        const realUpdate = db.client.wallet.update
        let credits = 0
        db.client.wallet.update = async (args: any) => {
            credits += 1
            if (credits === 2) throw new Error('connection reset mid-batch')
            return realUpdate(args)
        }

        await expect(PredictionSettlementService.settleMarket(marketId))
            .rejects.toThrow('connection reset mid-batch')

        // The batch was one transaction: nothing at all was paid.
        expect(walletOf('alice')).toEqual({ real: '0', bonus: '0' })
        expect(walletOf('carol')).toEqual({ real: '0', bonus: '0' })
        expect(db.tables.predictionPosition.every((p) => p.status === 'OPEN')).toBe(true)

        db.client.wallet.update = realUpdate

        const retry = await PredictionSettlementService.settleMarket(marketId)

        expect(retry.settled).toBe(true)
        expect(retry.positionsWon).toBe(2)
        // 6 shares: gross 600, profit 420, fee 63, net 537.
        expect(walletOf('alice')).toEqual({ real: '537', bonus: '0' })
        // 4 shares: gross 400, profit 280, fee 42, net 358.
        expect(walletOf('carol')).toEqual({ real: '358', bonus: '0' })
        expect(db.tables.transaction.filter((t) => t.type === 'PREDICTION_WIN')).toHaveLength(2)
    })

    it('skips a position an earlier run already marked WON', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket({
            totalShares: 10, totalVolume: D(1000), winningOutcomeId: 'market-1-a',
        })
        seedUser('alice', 537)
        seedUser('carol', 0)
        seedUser('bob', 0)
        // Alice was paid before the process died; her row is already terminal.
        seedPosition(marketId, outcomeA, 'alice', 6, 180, 0, {
            status: 'WON', payout: D(537), feePaid: D(63), settledAt: new Date(),
        })
        seedPosition(marketId, outcomeA, 'carol', 4, 120)
        seedPosition(marketId, outcomeB, 'bob', 10, 700)

        const result = await PredictionSettlementService.settleMarket(marketId)

        expect(result.positionsWon).toBe(1)
        expect(walletOf('alice')).toEqual({ real: '537', bonus: '0' })
        expect(walletOf('carol')).toEqual({ real: '358', bonus: '0' })
        // The house books what was actually charged across both runs.
        expect(db.house.balance.toString()).toBe('105')
    })
})

// ── Void ──────────────────────────────────────────────────────────────────────

describe('voidMarket', () => {
    it('returns each position at cost basis, bonus as bonus and real as real', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket({
            status: 'CLOSED', totalShares: 10, totalVolume: D(1000),
        })
        seedUser('alice', 5, 7)
        seedUser('bob', 0)
        seedPosition(marketId, outcomeA, 'alice', 10, 120, 180)
        seedPosition(marketId, outcomeB, 'bob', 10, 700)

        const result = await PredictionSettlementService.voidMarket(marketId, 'Draw')

        expect(result.voided).toBe(true)
        expect(result.positionsRefunded).toBe(2)
        expect(result.totalRefunded.toString()).toBe('1000')

        // 180 of promotional credit returns as promotional credit.
        expect(walletOf('alice')).toEqual({ real: '125', bonus: '187' })
        expect(walletOf('bob')).toEqual({ real: '700', bonus: '0' })

        expect(positionFor('alice').status).toBe('REFUNDED')
        expect(positionFor('alice').payout.toString()).toBe('300')
        expect(positionFor('alice').feePaid.toString()).toBe('0')

        const market = marketRow(marketId)
        expect(market.status).toBe('VOIDED')
        expect(market.voidReason).toBe('Draw')

        // A void produces no revenue, so nothing is booked to the house.
        expect(db.tables.houseTransaction).toHaveLength(0)
        expect(db.house.balance.toString()).toBe('0')
    })

    it('refunds open orders as well as positions', async () => {
        const { marketId, outcomeA } = seedMarket({ status: 'OPEN' })
        seedUser('dave', 0, 0)
        seedOrder(marketId, outcomeA, 'dave', 25, 4, {
            reservedReal: D(60), reservedBonus: D(40),
        })

        const result = await PredictionSettlementService.voidMarket(marketId, 'Bout cancelled')

        expect(result.ordersRefunded).toBe(1)
        expect(walletOf('dave')).toEqual({ real: '60', bonus: '40' })
        expect(
            db.tables.transaction.filter((t) => t.type === 'PREDICTION_REFUND'),
        ).toHaveLength(1)
    })

    it('restores a refunded order s bonus reserve to a lot carrying its ORIGINAL expiry', async () => {
        // The expiry comes from the order's own PREDICTION_ORDER_HOLD
        // transaction (Task 16), looked up by `note` containing the order's id
        // — not a fresh window. The hold is seeded directly (this double does
        // not run `placeOrder`, so nothing creates it on its own).
        const { marketId, outcomeA } = seedMarket({ status: 'OPEN' })
        seedUser('dave', 0, 0)
        const order = seedOrder(marketId, outcomeA, 'dave', 25, 4, {
            reservedReal: D(0), reservedBonus: D(100),
        })
        const originalExpiry = new Date(Date.now() + 1_800_000)
        db.tables.transaction.push({
            id: 'tx-hold-1',
            userId: 'dave',
            type: 'PREDICTION_ORDER_HOLD',
            amount: D(100),
            status: 'APPROVED',
            referenceId: marketId,
            note: `Prediction order ${order.id}`,
            balanceBefore: D(0),
            balanceAfter: D(0),
            bonusBalanceBefore: D(100),
            bonusBalanceAfter: D(0),
            bonusExpiresAtSpend: originalExpiry,
            createdAt: new Date(),
            updatedAt: new Date(),
        })

        vi.mocked(BonusService.restore).mockClear()
        const result = await PredictionSettlementService.voidMarket(marketId, 'Bout cancelled')

        expect(result.ordersRefunded).toBe(1)
        expect(walletOf('dave')).toEqual({ real: '0', bonus: '100' })
        expect(BonusService.restore).toHaveBeenCalledTimes(1)
        const [, restoredUserId, restoredAmount, restoredExpiry] = vi.mocked(BonusService.restore).mock.calls[0]
        expect(restoredUserId).toBe('dave')
        expect(new Decimal(restoredAmount as any).toString()).toBe('100')
        expect((restoredExpiry as Date | null)?.getTime()).toBe(originalExpiry.getTime())
    })

    it('claims VOIDED before it hands back a single birr', async () => {
        // A void on a LIVE market is the expected operational case — a cancelled
        // bout with a full book. If the status only flipped after the refunds,
        // `placeOrder`'s in-transaction status check would keep passing all the
        // way through the refund pass, and an order committed in that window
        // would rest forever on a terminal market with its reserve unreachable.
        const { marketId, outcomeA, outcomeB } = seedMarket({
            status: 'OPEN', totalShares: 5, totalVolume: D(500),
        })
        seedUser('alice', 0)
        seedUser('bob', 0)
        seedOrder(marketId, outcomeA, 'alice', 30, 10)
        seedPosition(marketId, outcomeA, 'alice', 5, 150)
        seedPosition(marketId, outcomeB, 'bob', 5, 350)

        const statusWhenPaid: string[] = []
        const originalUpdate = db.client.wallet.update
        db.client.wallet.update = async (args: any) => {
            statusWhenPaid.push(marketRow(marketId).status)
            return originalUpdate(args)
        }

        try {
            const result = await PredictionSettlementService.voidMarket(marketId, 'Bout cancelled')
            expect(result.voided).toBe(true)
        } finally {
            db.client.wallet.update = originalUpdate
        }

        expect(statusWhenPaid.length).toBe(3)
        expect([...new Set(statusWhenPaid)]).toEqual(['VOIDED'])
    })

    it('refunds the reserve the order actually still holds, not the stale batch snapshot', async () => {
        const { marketId, outcomeA } = seedMarket({ status: 'OPEN' })
        seedUser('mia', 0)
        const order = seedOrder(marketId, outcomeA, 'mia', 30, 10) // 300 reserved

        // A fill lands between the batch read (which is outside any transaction)
        // and the refund transaction: half the order is a position now, and half
        // its reserve has become that position's cost basis.
        const originalFindMany = db.client.predictionOrder.findMany
        let fired = false
        db.client.predictionOrder.findMany = async (args: any) => {
            const rows = await originalFindMany(args)
            if (!fired && rows.length > 0) {
                fired = true
                order.filledQuantity = 5
                order.reservedReal = D(150)
                order.status = 'PARTIALLY_FILLED'
            }
            return rows
        }

        try {
            await PredictionSettlementService.voidMarket(marketId, 'Bout cancelled')
        } finally {
            db.client.predictionOrder.findMany = originalFindMany
        }

        // Refunding the snapshot's 300 would pay that 150 out twice — once here
        // and once again when the position it became is refunded.
        expect(walletOf('mia')).toEqual({ real: '150', bonus: '0' })
        expect(order.reservedReal.toString()).toBe('0')
        expect(order.status).toBe('CANCELLED')
    })

    it('pushes a fresh book once the resting orders are cancelled', async () => {
        const { marketId, outcomeA } = seedMarket({ status: 'OPEN' })
        seedUser('dave', 0)
        seedOrder(marketId, outcomeA, 'dave', 25, 4)

        await PredictionSettlementService.voidMarket(marketId, 'Draw')

        // A terminal market never fills again, so without this emit the last
        // book a client saw — full of depth that no longer exists — is its final
        // one until it reloads.
        expect(gatewayMock.emitBook).toHaveBeenCalledWith(marketId)
    })

    it('refunds once when void runs twice', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket({
            status: 'CLOSED', totalShares: 5, totalVolume: D(500),
        })
        seedUser('alice', 0)
        seedUser('bob', 0)
        seedPosition(marketId, outcomeA, 'alice', 5, 150)
        seedPosition(marketId, outcomeB, 'bob', 5, 350)

        await PredictionSettlementService.voidMarket(marketId, 'No contest')
        const second = await PredictionSettlementService.voidMarket(marketId, 'No contest')

        expect(second.positionsRefunded).toBe(0)
        expect(walletOf('alice')).toEqual({ real: '150', bonus: '0' })
        expect(walletOf('bob')).toEqual({ real: '350', bonus: '0' })
        expect(db.tables.transaction.filter((t) => t.type === 'PREDICTION_REFUND')).toHaveLength(2)
    })

    it('refuses to void a market that already settled', async () => {
        const { marketId } = seedMarket({ status: 'SETTLED' })

        const result = await PredictionSettlementService.voidMarket(marketId, 'Too late')

        expect(result).toMatchObject({ voided: false, reason: 'market_already_settled' })
    })

    it('reports an unknown market rather than throwing', async () => {
        const result = await PredictionSettlementService.voidMarket('nope', 'Draw')

        expect(result).toMatchObject({ voided: false, reason: 'market_not_found' })
    })

    it('returns every escrowed birr and no more', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket({
            status: 'CLOSED', totalShares: 12, totalVolume: D(1200),
        })
        seedUser('alice', 0)
        seedUser('bob', 0)
        seedUser('carol', 0)
        seedPosition(marketId, outcomeA, 'alice', 7, 210, 35)
        seedPosition(marketId, outcomeA, 'carol', 5, 100, 55)
        seedPosition(marketId, outcomeB, 'bob', 12, 800)

        const result = await PredictionSettlementService.voidMarket(marketId, 'Draw')

        // Σ refunds == Σ costBasis == totalShares × shareValue.
        expect(result.totalRefunded.toString()).toBe('1200')
        const returned = db.tables.wallet.reduce(
            (acc, w) => acc.plus(D(w.realBalance)).plus(D(w.bonusBalance)),
            D(0),
        )
        expect(returned.toString()).toBe('1200')
    })
})
