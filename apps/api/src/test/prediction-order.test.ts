import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'

/**
 * Order placement, matching and cancellation — the money paths.
 *
 * These run against an in-memory Prisma double rather than a live database: the
 * point of the suite is the ARITHMETIC (what leaves a wallet, what lands in a
 * cost basis, what comes back) and that arithmetic is identical whether the rows
 * live in Postgres or in an array. What the double does provide, and what a bag
 * of `vi.fn()`s would not, is read-after-write: an order placed by one case is
 * really in the book for the next, so `placeOrder` genuinely matches against it.
 *
 * `$transaction` snapshots and rolls back on throw, so a rejected placement
 * leaves no half-applied money movement — the property the real transaction
 * gives us and the one these tests would otherwise silently lose.
 *
 * Every assertion is computed from the market's own `shareValue`; one market in
 * this file trades at 50 ETB a share to prove nothing is pinned to 100.
 */

// ── Redlock ───────────────────────────────────────────────────────────────────

/**
 * redlock@4's `Lock` exposes `unlock` and `extend` — and NOT `release`. The
 * default double here is deliberately permissive (it answers to both) so the
 * rest of the suite can exercise matching and escrow; one dedicated case below
 * flips `lockMode.faithful` to model the real v4 lock and asserts the service
 * can still release it.
 */
const lockMode = vi.hoisted(() => ({ faithful: false }))

vi.mock('redlock', () => {
    class FakeRedlock {
        on() {}
        async acquire() {
            const lock: Record<string, unknown> = {
                unlock: async () => {},
                extend: async () => {},
            }
            if (!lockMode.faithful) lock.release = async () => {}
            return lock
        }
    }
    return { default: FakeRedlock }
})

vi.mock('../lib/redis.js', () => ({
    default: { get: vi.fn(), set: vi.fn(), del: vi.fn(), eval: vi.fn(), on: vi.fn() },
}))

vi.mock('../gateways/prediction.gateway.js', () => ({
    emitBook: vi.fn(),
    emitTrade: vi.fn(),
    emitStatus: vi.fn(),
    emitSettled: vi.fn(),
}))

/**
 * `BonusService.spend`/`.restore` are production code with their own dedicated
 * real-DB coverage (bonus.service.test.ts) — soonest-expiry-first lot
 * consumption and lot creation against `bonus_grants`, a table this in-memory
 * double does not model. What `placeOrder`/`cancelOrder` need verified HERE is
 * only their own contract with these two: pass the reserve/release, apply the
 * resulting balance to the wallet, propagate `InsufficientBonusBalanceError`
 * untouched, and — for `restore` — pass through whatever expiry the caller
 * looked up. These fakes reproduce exactly that observable surface against the
 * same double `tx` the rest of the suite uses, the same way redis/redlock/the
 * gateway are faked below rather than run for real.
 *
 * `bonusMockState.nextSpendExpiry` lets a test control what `spend` reports as
 * `soonestExpiryConsumed` on the next call, so a test can place a bonus-funded
 * order whose `PREDICTION_ORDER_HOLD` transaction carries a known expiry and
 * then assert `cancelOrder` looks that same expiry back up and restores it.
 */
const bonusMockState = vi.hoisted(() => ({ nextSpendExpiry: null as Date | null }))

vi.mock('../services/bonus.service.js', () => ({
    BonusService: {
        spend: vi.fn(async (tx: any, userId: string, amount: any) => {
            const rows = await tx.$queryRaw`SELECT "bonusBalance" FROM wallets WHERE "userId" = ${userId}`
            const before = new Decimal(rows[0]?.bonusBalance ?? 0)
            const need = new Decimal(amount)
            if (before.lessThan(need)) {
                throw Object.assign(new Error('Insufficient bonus balance'), {
                    statusCode: 400,
                    name: 'InsufficientBonusBalanceError',
                })
            }
            const after = before.minus(need)
            await tx.wallet.update({ where: { userId }, data: { bonusBalance: after } })
            return {
                spent: need,
                bonusBalanceBefore: before,
                bonusBalanceAfter: after,
                soonestExpiryConsumed: bonusMockState.nextSpendExpiry,
            }
        }),
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

// ── In-memory Prisma ──────────────────────────────────────────────────────────

/**
 * The mock factory is hoisted above every import, so it cannot close over a
 * store built with `Decimal`. It hands out a proxy instead and the real store is
 * attached once the module body runs — before any test does.
 */
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

import { PredictionOrderService } from '../services/prediction/order.service.js'
import { BonusService } from '../services/bonus.service.js'

const db = createStore()
holder.client = db.client

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
            if (value && typeof value === 'object' && !Array.isArray(value) &&
                !(value instanceof Date) && !isDec(value)) {
                if ('increment' in value) {
                    row[key] = isDec(row[key]) || isDec((value as Row).increment)
                        ? dec(row[key]).plus(dec((value as Row).increment))
                        : row[key] + (value as Row).increment
                    continue
                }
                if ('decrement' in value) {
                    row[key] = isDec(row[key]) || isDec((value as Row).decrement)
                        ? dec(row[key]).minus(dec((value as Row).decrement))
                        : row[key] - (value as Row).decrement
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

    // ── The store ────────────────────────────────────────────────────────────

    const tables: Record<string, Row[]> = {
        user: [],
        wallet: [],
        transaction: [],
        predictionMarket: [],
        predictionOutcome: [],
        predictionOrder: [],
        predictionFill: [],
        predictionPosition: [],
    }

    const defaults: Record<string, Row> = {
        user: { role: 'PLAYER' },
        wallet: { realBalance: dec(0), bonusBalance: dec(0), spendAccount: 'REAL' },
        transaction: {},
        predictionMarket: {
            status: 'DRAFT',
            shareValue: dec(100),
            feePct: dec(15),
            minOrderShares: 1,
            maxOrderShares: 10000,
            totalShares: 0,
            totalVolume: dec(0),
            winningOutcomeId: null,
            disputeUntil: null,
        },
        predictionOutcome: { lastPrice: null },
        predictionOrder: {
            filledQuantity: 0,
            reservedReal: dec(0),
            reservedBonus: dec(0),
            status: 'OPEN',
        },
        predictionFill: {},
        predictionPosition: {
            shares: 0,
            costBasisReal: dec(0),
            costBasisBonus: dec(0),
            status: 'OPEN',
            payout: dec(0),
            feePaid: dec(0),
        },
    }

    let ids = 0
    let clock = 0
    const nextId = (model: string) => `${model}-${(ids += 1)}`
    // Monotonic, so `createdAt ASC` is a stable, meaningful tiebreak.
    const nextTime = () => new Date(1_800_000_000_000 + (clock += 1))

    function expandWhere(where: any): Row {
        const out: Row = {}
        for (const [key, value] of Object.entries(where ?? {})) {
            if (
                key.includes('_') &&
                value &&
                typeof value === 'object' &&
                !isOpNode(value) &&
                !(value instanceof Date) &&
                !isDec(value)
            ) {
                Object.assign(out, value)
                continue
            }
            out[key] = value
        }
        return out
    }

    const relations: Record<string, Record<string, (row: Row, spec: any) => any>> = {
        predictionOrder: {
            market: (row) => tables.predictionMarket.find((m) => m.id === row.marketId) ?? null,
            outcome: (row) => tables.predictionOutcome.find((o) => o.id === row.outcomeId) ?? null,
        },
        predictionMarket: {
            outcomes: (row) =>
                sortRows(
                    tables.predictionOutcome.filter((o) => o.marketId === row.id),
                    { sortOrder: 'asc' },
                ),
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
                const value = resolve(row, spec)
                out[rel] = Array.isArray(value)
                    ? value.map((r) => project('', r, spec === true ? {} : spec))
                    : project('', value, spec === true ? {} : spec)
            }
        }
        if (args?.select) {
            const picked: Row = {}
            for (const [key, want] of Object.entries(args.select)) {
                if (!want) continue
                const resolve = relations[model]?.[key]
                if (resolve) {
                    const value = resolve(row, want)
                    picked[key] = Array.isArray(value)
                        ? value.map((r) => project('', r, want === true ? {} : want))
                        : project('', value, want === true ? {} : want)
                    continue
                }
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
                if (args.cursor) {
                    const at = list.findIndex((r) => matches(r, expandWhere(args.cursor)))
                    if (at >= 0) list = list.slice(at + (args.skip ?? 0))
                }
                if (args.take !== undefined) list = list.slice(0, args.take)
                return list.map((r) => project(name, r, args))
            },
            count: async (args: any = {}) =>
                rows().filter((r) => matches(r, expandWhere(args.where))).length,
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
            createMany: async (args: any) => {
                const list = Array.isArray(args.data) ? args.data : [args.data]
                for (const data of list) {
                    rows().push({
                        id: nextId(name),
                        ...defaults[name],
                        ...data,
                        createdAt: data.createdAt ?? nextTime(),
                        updatedAt: nextTime(),
                    })
                }
                return { count: list.length }
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
            upsert: async (args: any) => {
                const row = find(args.where)
                if (row) {
                    applyData(row, args.update)
                    return project(name, row, args)
                }
                const created: Row = {
                    id: nextId(name),
                    ...defaults[name],
                    ...expandWhere(args.where),
                    ...args.create,
                    createdAt: nextTime(),
                    updatedAt: nextTime(),
                }
                rows().push(created)
                return project(name, created, args)
            },
            deleteMany: async (args: any = {}) => {
                const keep = rows().filter((r) => !matches(r, expandWhere(args.where)))
                const count = rows().length - keep.length
                tables[name] = keep
                return { count }
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
                        ? list.reduce((acc, r) => acc.plus(dec(r[field])), dec(0))
                        : list.reduce((acc, r) => acc + (r[field] ?? 0), 0)
                }
                return { _sum: sum }
            },
        }
    }

    const snapshot = () =>
        Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))

    const restore = (snap: Record<string, Row[]>) => {
        for (const [k, v] of Object.entries(snap)) tables[k] = v
    }

    const client: Row = {}
    for (const name of Object.keys(tables)) client[name] = model(name)

    client.$queryRaw = async (strings: any, ...values: any[]) => {
        const sql = Array.isArray(strings) ? strings.join(' ? ') : String(strings)
        if (/FROM wallets/i.test(sql)) {
            const wallet = tables.wallet.find((w) => w.userId === values[0])
            return wallet
                ? [{
                    id: wallet.id,
                    realBalance: wallet.realBalance,
                    bonusBalance: wallet.bonusBalance,
                    spendAccount: wallet.spendAccount,
                }]
                : []
        }
        return []
    }
    client.$executeRaw = async () => 0
    client.$transaction = async (arg: any) => {
        if (Array.isArray(arg)) return Promise.all(arg)
        const snap = snapshot()
        try {
            return await arg(client)
        } catch (err) {
            restore(snap)
            throw err
        }
    }

    return {
        client,
        tables,
        reset: () => {
            for (const key of Object.keys(tables)) tables[key] = []
            ids = 0
            clock = 0
        },
    }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const D = (v: number | string | Decimal) => new Decimal(v as any)

const HOUR = 3_600_000

interface Seeded {
    marketId: string
    outcomeA: string
    outcomeB: string
}

function seedMarket(overrides: Record<string, any> = {}): Seeded {
    const market = {
        id: `market-${db.tables.predictionMarket.length + 1}`,
        eventName: 'ETFC Fight Night',
        question: 'Sedo vs Johnny — who wins?',
        status: 'OPEN',
        closesAt: new Date(Date.now() + HOUR),
        shareValue: D(100),
        feePct: D(15),
        minOrderShares: 1,
        maxOrderShares: 10000,
        totalShares: 0,
        totalVolume: D(0),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    }
    db.tables.predictionMarket.push(market)

    const outcomeA = { id: `${market.id}-a`, marketId: market.id, label: 'Sedo', sortOrder: 0, lastPrice: null }
    const outcomeB = { id: `${market.id}-b`, marketId: market.id, label: 'Johnny', sortOrder: 1, lastPrice: null }
    db.tables.predictionOutcome.push(outcomeA, outcomeB)

    return { marketId: market.id, outcomeA: outcomeA.id, outcomeB: outcomeB.id }
}

function seedUser(
    userId: string,
    real: number,
    bonus = 0,
    role = 'PLAYER',
    spendAccount: 'REAL' | 'BONUS' = 'REAL',
): string {
    // A user row as well as a wallet: placeOrder reads the role to refuse staff
    // accounts, so a wallet with no user behind it is not a valid fixture.
    db.tables.user.push({ id: userId, role })
    db.tables.wallet.push({
        id: `wallet-${userId}`,
        userId,
        realBalance: D(real),
        bonusBalance: D(bonus),
        spendAccount,
    })
    return userId
}

function walletOf(userId: string) {
    const wallet = db.tables.wallet.find((w) => w.userId === userId)!
    return { real: wallet.realBalance.toString(), bonus: wallet.bonusBalance.toString() }
}

function positionOf(userId: string, outcomeId: string) {
    return db.tables.predictionPosition.find(
        (p) => p.userId === userId && p.outcomeId === outcomeId,
    )
}

function marketRow(marketId: string) {
    return db.tables.predictionMarket.find((m) => m.id === marketId)!
}

/** Σ costBasis across every position on the market. */
function totalCostBasis(marketId: string): Decimal {
    return db.tables.predictionPosition
        .filter((p) => p.marketId === marketId)
        .reduce((acc, p) => acc.plus(D(p.costBasisReal)).plus(D(p.costBasisBonus)), D(0))
}

/** Everything the players still own: wallets + live reserves + escrowed basis. */
function moneyInSystem(): Decimal {
    const wallets = db.tables.wallet.reduce(
        (acc, w) => acc.plus(D(w.realBalance)).plus(D(w.bonusBalance)),
        D(0),
    )
    const reserved = db.tables.predictionOrder.reduce(
        (acc, o) => acc.plus(D(o.reservedReal)).plus(D(o.reservedBonus)),
        D(0),
    )
    const basis = db.tables.predictionPosition.reduce(
        (acc, p) => acc.plus(D(p.costBasisReal)).plus(D(p.costBasisBonus)),
        D(0),
    )
    return wallets.plus(reserved).plus(basis)
}

beforeEach(() => {
    db.reset()
    lockMode.faithful = false
    bonusMockState.nextSpendExpiry = null
    vi.clearAllMocks()
})

// ── Staff may not trade ───────────────────────────────────────────────────────

describe('placeOrder — staff accounts cannot trade', () => {
    // The people who resolve markets must not be able to hold a position in
    // one. An audit log records what an admin decided; only refusing the order
    // shows they had nothing riding on it.
    for (const role of ['ADMIN', 'SUPER_ADMIN', 'CLERK']) {
        it(`refuses a ${role} with 403 and moves no money`, async () => {
            const { marketId, outcomeA } = seedMarket()
            seedUser('staffer', 1000, 0, role)

            await expect(
                PredictionOrderService.placeOrder('staffer', {
                    marketId,
                    outcomeId: outcomeA,
                    limitPrice: 35,
                    quantity: 10,
                }),
            ).rejects.toMatchObject({ statusCode: 403 })

            // The guard runs before the wallet is touched, so a refused order
            // must leave the balance and the book exactly as they were.
            expect(walletOf('staffer')).toEqual({ real: '1000', bonus: '0' })
            expect(db.tables.predictionOrder).toHaveLength(0)
            expect(db.tables.transaction).toHaveLength(0)
        })
    }

    it('still allows a PLAYER', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 1000)

        const { order } = await PredictionOrderService.placeOrder('alice', {
            marketId,
            outcomeId: outcomeA,
            limitPrice: 35,
            quantity: 10,
        })

        expect(order.status).toBe('OPEN')
        expect(walletOf('alice')).toEqual({ real: '650', bonus: '0' })
    })
})

// ── Reserve ───────────────────────────────────────────────────────────────────

describe('placeOrder — the money leaves the wallet at placement', () => {
    it('reserves limitPrice x quantity and rests the order', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 1000)

        const { order } = await PredictionOrderService.placeOrder('alice', {
            marketId,
            outcomeId: outcomeA,
            limitPrice: 35,
            quantity: 10,
        })

        expect(order.status).toBe('OPEN')
        expect(order.filledQuantity).toBe(0)
        expect(D(order.reservedReal).plus(order.reservedBonus).toString()).toBe('350')
        expect(walletOf('alice')).toEqual({ real: '650', bonus: '0' })
    })

    // Task 16 (deposit-bonuses plan) replaced the old "bonus first, then real"
    // mixed-spend behavior these two cases used to cover: placeOrder now
    // reserves entirely from whichever account wallet.spendAccount selects
    // (REAL by default), never splitting a single reserve across both. See
    // the "spendAccount selection" block below for explicit BONUS/REAL
    // coverage, including the case that used to exercise this fixture.

    it('spends entirely from real balance and leaves bonus untouched (default spendAccount)', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 900, 100)

        const { order } = await PredictionOrderService.placeOrder('alice', {
            marketId,
            outcomeId: outcomeA,
            limitPrice: 50,
            quantity: 10,
        })

        expect(order.reservedReal.toString()).toBe('500')
        expect(order.reservedBonus.toString()).toBe('0')
        expect(walletOf('alice')).toEqual({ real: '400', bonus: '100' })
    })

    it('reserves entirely from bonus when spendAccount is BONUS, even though real also has funds', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 900, 500, 'PLAYER', 'BONUS')

        const { order } = await PredictionOrderService.placeOrder('alice', {
            marketId,
            outcomeId: outcomeA,
            limitPrice: 40,
            quantity: 5,
        })

        expect(order.reservedBonus.toString()).toBe('200')
        expect(order.reservedReal.toString()).toBe('0')
        expect(walletOf('alice')).toEqual({ real: '900', bonus: '300' })
    })

    it('writes a PREDICTION_ORDER_HOLD transaction with both balance snapshots', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 900, 100)

        await PredictionOrderService.placeOrder('alice', {
            marketId,
            outcomeId: outcomeA,
            limitPrice: 50,
            quantity: 10,
        })

        const hold = db.tables.transaction.find((t) => t.type === 'PREDICTION_ORDER_HOLD')!
        expect(hold.amount.toString()).toBe('500')
        expect(hold.referenceId).toBe(marketId)
        expect(hold.balanceBefore.toString()).toBe('900')
        expect(hold.balanceAfter.toString()).toBe('400')
        expect(hold.bonusBalanceBefore.toString()).toBe('100')
        expect(hold.bonusBalanceAfter.toString()).toBe('100')
        expect(hold.bonusExpiresAtSpend ?? null).toBeNull()
    })

    it('rejects an order the wallet cannot fund, leaving the balance untouched', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 100, 50)

        await expect(
            PredictionOrderService.placeOrder('alice', {
                marketId,
                outcomeId: outcomeA,
                limitPrice: 35,
                quantity: 10,
            }),
        ).rejects.toThrow('Insufficient funds')

        expect(walletOf('alice')).toEqual({ real: '100', bonus: '50' })
        expect(db.tables.predictionOrder).toHaveLength(0)
    })
})

// ── Player-selected spend account (Task 16) ─────────────────────────────────

describe('placeOrder — spendAccount selection', () => {
    it('reserves entirely from BONUS when spendAccount is BONUS', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('predbonus1', 1000, 100, 'PLAYER', 'BONUS')

        const { order } = await PredictionOrderService.placeOrder('predbonus1', {
            marketId,
            outcomeId: outcomeA,
            limitPrice: 5,
            quantity: 10,
        })

        expect(D(order.reservedBonus).toNumber()).toBe(50)
        expect(D(order.reservedReal).toNumber()).toBe(0)
        expect(walletOf('predbonus1')).toEqual({ real: '1000', bonus: '50' }) // real untouched
    })

    it('rejects with insufficient bonus balance rather than falling back to real', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('predbonus2', 1000, 5, 'PLAYER', 'BONUS')

        await expect(
            PredictionOrderService.placeOrder('predbonus2', {
                marketId,
                outcomeId: outcomeA,
                limitPrice: 5,
                quantity: 10,
            }),
        ).rejects.toThrow('Insufficient bonus balance')

        expect(walletOf('predbonus2')).toEqual({ real: '1000', bonus: '5' })
        expect(db.tables.predictionOrder).toHaveLength(0)
    })

    it('reserves entirely from REAL when spendAccount is REAL, never touching bonus', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('predreal1', 1000, 500, 'PLAYER', 'REAL')

        const { order } = await PredictionOrderService.placeOrder('predreal1', {
            marketId,
            outcomeId: outcomeA,
            limitPrice: 5,
            quantity: 10,
        })

        expect(D(order.reservedReal).toNumber()).toBe(50)
        expect(D(order.reservedBonus).toNumber()).toBe(0)
        expect(walletOf('predreal1')).toEqual({ real: '950', bonus: '500' }) // bonus untouched
    })
})

// ── Matching through the service ──────────────────────────────────────────────

describe('placeOrder — matching against the book', () => {
    it('matches complementary orders and escrows exactly shareValue per share', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket()
        seedUser('bob', 1000)
        seedUser('alice', 1000)

        await PredictionOrderService.placeOrder('bob', {
            marketId,
            outcomeId: outcomeB,
            limitPrice: 65,
            quantity: 10,
        })
        const taken = await PredictionOrderService.placeOrder('alice', {
            marketId,
            outcomeId: outcomeA,
            limitPrice: 35,
            quantity: 10,
        })

        expect(taken.order.status).toBe('FILLED')
        expect(taken.fills).toHaveLength(1)

        const market = marketRow(marketId)
        expect(market.totalShares).toBe(10)
        expect(market.totalVolume.toString()).toBe('1000')

        // Solvency: Σ costBasis == totalShares × shareValue.
        expect(totalCostBasis(marketId).toString()).toBe('1000')
        expect(positionOf('alice', outcomeA)!.shares).toBe(10)
        expect(positionOf('bob', outcomeB)!.shares).toBe(10)
    })

    it('gives the taker the price improvement and releases it immediately', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket()
        seedUser('bob', 1000)
        seedUser('alice', 1000)

        // Bob rests at 70, so a share only costs the taker 30 — not the 40 it bid.
        await PredictionOrderService.placeOrder('bob', {
            marketId,
            outcomeId: outcomeB,
            limitPrice: 70,
            quantity: 10,
        })
        const taken = await PredictionOrderService.placeOrder('alice', {
            marketId,
            outcomeId: outcomeA,
            limitPrice: 40,
            quantity: 10,
        })

        expect(taken.fills[0].takerPrice.toString()).toBe('30')
        expect(taken.fills[0].makerPrice.toString()).toBe('70')

        // 400 held, 300 consumed, 100 improvement handed straight back.
        expect(walletOf('alice')).toEqual({ real: '700', bonus: '0' })
        expect(positionOf('alice', outcomeA)!.costBasisReal.toString()).toBe('300')
        expect(positionOf('bob', outcomeB)!.costBasisReal.toString()).toBe('700')
        expect(totalCostBasis(marketId).toString()).toBe('1000')

        const release = db.tables.transaction.find(
            (t) => t.type === 'PREDICTION_ORDER_RELEASE',
        )!
        expect(release.amount.toString()).toBe('100')
    })

    // Since Task 16, a reserve is never split across both accounts at
    // placement — it is funded entirely from wallet.spendAccount. This case
    // used to construct a 200/200 mixed reserve straight from wallet
    // balances; that fixture is no longer reachable (a single account now
    // funds the whole reserve or the order is rejected), so it is replaced
    // with the single-bucket case splitAgainstReserve degrades to: with
    // reservedReal === 0, every split — including the price-improvement
    // release below — comes back 100% bonus, proving the release logic
    // still respects "bonus returns as bonus" without needing its own code
    // change for the single-bucket case.
    it('releases the improvement entirely as bonus when the whole reserve was funded from bonus', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket()
        seedUser('bob', 1000)
        seedUser('alice', 1000, 400, 'PLAYER', 'BONUS')

        await PredictionOrderService.placeOrder('bob', {
            marketId,
            outcomeId: outcomeB,
            limitPrice: 70,
            quantity: 10,
        })
        await PredictionOrderService.placeOrder('alice', {
            marketId,
            outcomeId: outcomeA,
            limitPrice: 40,
            quantity: 10,
        })

        // 400 reserved entirely as bonus; 300 consumed; the 100 improvement
        // comes back entirely as bonus too — real is never touched.
        expect(walletOf('alice')).toEqual({ real: '1000', bonus: '100' })
        const position = positionOf('alice', outcomeA)!
        expect(position.costBasisBonus.toString()).toBe('300')
        expect(position.costBasisReal.toString()).toBe('0')
    })

    it('sweeps several makers best price first and rests the remainder', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket()
        seedUser('bob', 5000)
        seedUser('carol', 5000)
        seedUser('alice', 5000)

        await PredictionOrderService.placeOrder('bob', {
            marketId, outcomeId: outcomeB, limitPrice: 60, quantity: 3,
        })
        await PredictionOrderService.placeOrder('carol', {
            marketId, outcomeId: outcomeB, limitPrice: 70, quantity: 2,
        })

        const taken = await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 45, quantity: 10,
        })

        // Carol at 70 is served before Bob at 60 — highest maker price first.
        expect(taken.fills.map((f) => [f.makerPrice.toString(), f.quantity])).toEqual([
            ['70', 2],
            ['60', 3],
        ])
        expect(taken.order.status).toBe('PARTIALLY_FILLED')
        expect(taken.order.filledQuantity).toBe(5)
        // The unfilled 5 stay funded at the taker's own limit.
        expect(D(taken.order.reservedReal).plus(taken.order.reservedBonus).toString()).toBe('225')
        expect(totalCostBasis(marketId).toString()).toBe('500')
        expect(marketRow(marketId).totalShares).toBe(5)
    })

    it('serves the older order first at an equal price', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket()
        seedUser('bob', 5000)
        seedUser('carol', 5000)
        seedUser('alice', 5000)

        const first = await PredictionOrderService.placeOrder('bob', {
            marketId, outcomeId: outcomeB, limitPrice: 65, quantity: 1,
        })
        await PredictionOrderService.placeOrder('carol', {
            marketId, outcomeId: outcomeB, limitPrice: 65, quantity: 1,
        })

        const taken = await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 35, quantity: 1,
        })

        expect(taken.fills).toHaveLength(1)
        expect(taken.fills[0].makerOrderId).toBe(first.order.id)
        expect(taken.fills[0].makerUserId).toBe('bob')
    })

    it('never matches a player against their own resting order', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket()
        seedUser('alice', 5000)

        await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeB, limitPrice: 60, quantity: 5,
        })
        const second = await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 50, quantity: 5,
        })

        expect(second.fills).toHaveLength(0)
        expect(second.order.status).toBe('OPEN')
        expect(marketRow(marketId).totalShares).toBe(0)
        expect(db.tables.predictionPosition).toHaveLength(0)
        // Both orders still fully funded: 300 + 250.
        expect(walletOf('alice')).toEqual({ real: '4450', bonus: '0' })
    })

    it('leaves the order resting when nothing in the book can pay the complement', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket()
        seedUser('bob', 1000)
        seedUser('alice', 1000)

        await PredictionOrderService.placeOrder('bob', {
            marketId, outcomeId: outcomeB, limitPrice: 60, quantity: 5,
        })
        const taken = await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 39, quantity: 5,
        })

        expect(taken.fills).toHaveLength(0)
        expect(taken.order.status).toBe('OPEN')
        // Nothing filled means nothing to improve — the whole reserve stays held.
        expect(walletOf('alice')).toEqual({ real: '805', bonus: '0' })
        expect(
            db.tables.transaction.some((t) => t.type === 'PREDICTION_ORDER_RELEASE'),
        ).toBe(false)
    })

    it('records complementary last prices on both outcomes', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket()
        seedUser('bob', 1000)
        seedUser('alice', 1000)

        await PredictionOrderService.placeOrder('bob', {
            marketId, outcomeId: outcomeB, limitPrice: 65, quantity: 1,
        })
        await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 40, quantity: 1,
        })

        const outcomes = db.tables.predictionOutcome.filter((o) => o.marketId === marketId)
        const a = outcomes.find((o) => o.id === outcomeA)!
        const b = outcomes.find((o) => o.id === outcomeB)!
        expect(a.lastPrice.toString()).toBe('35')
        expect(b.lastPrice.toString()).toBe('65')
        expect(D(a.lastPrice).plus(b.lastPrice).toString()).toBe('100')
    })
})

// ── Share value is market data ────────────────────────────────────────────────

describe('placeOrder — a market that does not trade at 100', () => {
    it('prices, escrows and bounds everything off a 50 ETB share', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket({ shareValue: D(50) })
        seedUser('bob', 1000)
        seedUser('alice', 1000)

        await PredictionOrderService.placeOrder('bob', {
            marketId, outcomeId: outcomeB, limitPrice: 30, quantity: 10,
        })
        const taken = await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 25, quantity: 10,
        })

        expect(taken.fills[0].takerPrice.toString()).toBe('20')
        expect(marketRow(marketId).totalVolume.toString()).toBe('500')
        expect(totalCostBasis(marketId).toString()).toBe('500')
        // 250 reserved, 200 consumed, 50 improvement returned.
        expect(walletOf('alice')).toEqual({ real: '800', bonus: '0' })
    })

    it('accepts 49 and rejects 50 on a 50 ETB share', async () => {
        const { marketId, outcomeA } = seedMarket({ shareValue: D(50) })
        seedUser('alice', 5000)

        await expect(
            PredictionOrderService.placeOrder('alice', {
                marketId, outcomeId: outcomeA, limitPrice: 49, quantity: 1,
            }),
        ).resolves.toBeDefined()

        await expect(
            PredictionOrderService.placeOrder('alice', {
                marketId, outcomeId: outcomeA, limitPrice: 50, quantity: 1,
            }),
        ).rejects.toThrow(/at most 49 ETB/)
    })
})

// ── Guards ────────────────────────────────────────────────────────────────────

describe('placeOrder — guards', () => {
    it('rejects an order arriving one millisecond after closesAt', async () => {
        // The market closed 1ms ago; `now >= closesAt` must reject.
        const { marketId, outcomeA } = seedMarket({ closesAt: new Date(Date.now() - 1) })
        seedUser('alice', 1000)

        await expect(
            PredictionOrderService.placeOrder('alice', {
                marketId, outcomeId: outcomeA, limitPrice: 35, quantity: 1,
            }),
        ).rejects.toMatchObject({ message: 'This market has closed', statusCode: 409 })

        expect(walletOf('alice')).toEqual({ real: '1000', bonus: '0' })
    })

    it('accepts an order while closesAt is still ahead', async () => {
        const { marketId, outcomeA } = seedMarket({ closesAt: new Date(Date.now() + 1000) })
        seedUser('alice', 1000)

        await expect(
            PredictionOrderService.placeOrder('alice', {
                marketId, outcomeId: outcomeA, limitPrice: 35, quantity: 1,
            }),
        ).resolves.toBeDefined()
    })

    it('rejects an off-tick price', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 1000)

        await expect(
            PredictionOrderService.placeOrder('alice', {
                marketId, outcomeId: outcomeA, limitPrice: 35.5, quantity: 1,
            }),
        ).rejects.toMatchObject({ statusCode: 400 })

        expect(db.tables.predictionOrder).toHaveLength(0)
    })

    it('rejects prices at both ends of the range', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 1000)

        for (const limitPrice of [0, 100, 101]) {
            await expect(
                PredictionOrderService.placeOrder('alice', {
                    marketId, outcomeId: outcomeA, limitPrice, quantity: 1,
                }),
            ).rejects.toMatchObject({ statusCode: 400 })
        }

        // 1 and 99 are the extremes that ARE legal.
        for (const limitPrice of [1, 99]) {
            await expect(
                PredictionOrderService.placeOrder('alice', {
                    marketId, outcomeId: outcomeA, limitPrice, quantity: 1,
                }),
            ).resolves.toBeDefined()
        }
    })

    it('rejects a negative price', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 1000)

        await expect(
            PredictionOrderService.placeOrder('alice', {
                marketId, outcomeId: outcomeA, limitPrice: -5, quantity: 1,
            }),
        ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects quantities outside the market bounds', async () => {
        const { marketId, outcomeA } = seedMarket({ minOrderShares: 2, maxOrderShares: 5 })
        seedUser('alice', 100000)

        for (const quantity of [0, 1.5, 1, 6]) {
            await expect(
                PredictionOrderService.placeOrder('alice', {
                    marketId, outcomeId: outcomeA, limitPrice: 10, quantity,
                }),
            ).rejects.toMatchObject({ statusCode: 400 })
        }

        await expect(
            PredictionOrderService.placeOrder('alice', {
                marketId, outcomeId: outcomeA, limitPrice: 10, quantity: 5,
            }),
        ).resolves.toBeDefined()
    })

    it('rejects an order on a market that is not OPEN', async () => {
        seedUser('alice', 1000)

        for (const status of ['DRAFT', 'CLOSED', 'RESOLVING', 'SETTLED', 'VOIDED']) {
            const { marketId, outcomeA } = seedMarket({ status })
            await expect(
                PredictionOrderService.placeOrder('alice', {
                    marketId, outcomeId: outcomeA, limitPrice: 35, quantity: 1,
                }),
            ).rejects.toMatchObject({
                message: 'This market is not open for orders',
                statusCode: 409,
            })
        }
    })

    it('rejects an outcome that belongs to a different market', async () => {
        const first = seedMarket()
        const second = seedMarket()
        seedUser('alice', 1000)

        await expect(
            PredictionOrderService.placeOrder('alice', {
                marketId: first.marketId,
                outcomeId: second.outcomeA,
                limitPrice: 35,
                quantity: 1,
            }),
        ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects an unknown market', async () => {
        seedUser('alice', 1000)

        await expect(
            PredictionOrderService.placeOrder('alice', {
                marketId: 'nope', outcomeId: 'nope-a', limitPrice: 35, quantity: 1,
            }),
        ).rejects.toMatchObject({ statusCode: 404 })
    })
})

// ── Cancellation ──────────────────────────────────────────────────────────────

describe('cancelOrder', () => {
    it('releases exactly the unfilled reserve and never a birr more', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket()
        seedUser('bob', 1000)
        seedUser('alice', 1000)

        const rested = await PredictionOrderService.placeOrder('bob', {
            marketId, outcomeId: outcomeB, limitPrice: 60, quantity: 10,
        })
        // Alice takes 4 of Bob's 10 at 60/40.
        await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 40, quantity: 4,
        })

        const cancelled = await PredictionOrderService.cancelOrder('bob', rested.order.id)

        // 6 unfilled × 60 = 360 back; the 240 already escrowed is a position now.
        expect(cancelled.refunded.toString()).toBe('360')
        expect(cancelled.order.status).toBe('CANCELLED')
        expect(walletOf('bob')).toEqual({ real: '760', bonus: '0' })
        expect(positionOf('bob', outcomeB)!.shares).toBe(4)
        expect(positionOf('bob', outcomeB)!.costBasisReal.toString()).toBe('240')
        expect(totalCostBasis(marketId).toString()).toBe('400')
    })

    it('zeroes the reserve so a second cancel cannot pay again', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 1000)

        const rested = await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 35, quantity: 10,
        })

        await PredictionOrderService.cancelOrder('alice', rested.order.id)
        await expect(
            PredictionOrderService.cancelOrder('alice', rested.order.id),
        ).rejects.toMatchObject({ statusCode: 409 })

        expect(walletOf('alice')).toEqual({ real: '1000', bonus: '0' })
    })

    it('returns bonus-funded reserve to the bonus bucket', async () => {
        // Since Task 16 the whole reserve is funded from a single account —
        // bonus must cover it outright, real is never topped up.
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 100, 400, 'PLAYER', 'BONUS')

        const rested = await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 40, quantity: 10,
        })
        expect(walletOf('alice')).toEqual({ real: '100', bonus: '0' })

        await PredictionOrderService.cancelOrder('alice', rested.order.id)

        // The whole reserve was bonus — refunding it to real would launder it.
        expect(walletOf('alice')).toEqual({ real: '100', bonus: '400' })
    })

    it('restores unfilled bonus reserve to a lot carrying the ORIGINAL expiry', async () => {
        // The hold's expiry comes from `BonusService.spend`'s
        // `soonestExpiryConsumed` (Task 16); the mock above reports whatever
        // `bonusMockState.nextSpendExpiry` says at the time `placeOrder` runs,
        // so this is placed with a known, deliberately-not-fresh expiry and the
        // release must look that exact value back up rather than granting a new
        // window.
        const originalExpiry = new Date(Date.now() + 1_800_000)
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 100, 400, 'PLAYER', 'BONUS')

        bonusMockState.nextSpendExpiry = originalExpiry
        const rested = await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 40, quantity: 10,
        })
        bonusMockState.nextSpendExpiry = null

        vi.mocked(BonusService.restore).mockClear()
        await PredictionOrderService.cancelOrder('alice', rested.order.id)

        expect(walletOf('alice')).toEqual({ real: '100', bonus: '400' })
        expect(BonusService.restore).toHaveBeenCalledTimes(1)
        const [, restoredUserId, restoredAmount, restoredExpiry] = vi.mocked(BonusService.restore).mock.calls[0]
        expect(restoredUserId).toBe('alice')
        expect(new Decimal(restoredAmount as any).toString()).toBe('400')
        expect((restoredExpiry as Date | null)?.getTime()).toBe(originalExpiry.getTime())
    })

    it('looks up the CANCELLED order s own hold, not another order s', async () => {
        // Two bonus-funded orders from the same player, each placed under a
        // different `soonestExpiryConsumed`. Cancelling the second must restore
        // the SECOND order's expiry — proving the lookup is scoped by this
        // order's own id (`note.contains(orderId)`), not just "the first hold
        // this user has on this market".
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 100, 1000, 'PLAYER', 'BONUS')

        const firstExpiry = new Date(Date.now() + 3_600_000)
        bonusMockState.nextSpendExpiry = firstExpiry
        await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 30, quantity: 5, // reserve 150
        })

        const secondExpiry = new Date(Date.now() + 7_200_000)
        bonusMockState.nextSpendExpiry = secondExpiry
        const second = await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 40, quantity: 5, // reserve 200
        })
        bonusMockState.nextSpendExpiry = null

        vi.mocked(BonusService.restore).mockClear()
        await PredictionOrderService.cancelOrder('alice', second.order.id)

        expect(BonusService.restore).toHaveBeenCalledTimes(1)
        const [, , restoredAmount, restoredExpiry] = vi.mocked(BonusService.restore).mock.calls[0]
        expect(new Decimal(restoredAmount as any).toString()).toBe('200')
        expect((restoredExpiry as Date | null)?.getTime()).toBe(secondExpiry.getTime())
    })

    it('refuses to cancel an order that belongs to someone else', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 1000)
        seedUser('carol', 1000)

        const rested = await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 35, quantity: 10,
        })

        await expect(
            PredictionOrderService.cancelOrder('carol', rested.order.id),
        ).rejects.toMatchObject({ message: 'This order is not yours', statusCode: 403 })

        expect(walletOf('carol')).toEqual({ real: '1000', bonus: '0' })
        expect(walletOf('alice')).toEqual({ real: '650', bonus: '0' })
        expect(db.tables.predictionOrder[0].status).toBe('OPEN')
    })

    it('refuses to cancel a fully filled order', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket()
        seedUser('bob', 1000)
        seedUser('alice', 1000)

        const rested = await PredictionOrderService.placeOrder('bob', {
            marketId, outcomeId: outcomeB, limitPrice: 65, quantity: 5,
        })
        await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 35, quantity: 5,
        })

        await expect(
            PredictionOrderService.cancelOrder('bob', rested.order.id),
        ).rejects.toMatchObject({ statusCode: 409 })
    })

    it('refuses to cancel while the market is no longer open', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 1000)

        const rested = await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 35, quantity: 10,
        })
        marketRow(marketId).status = 'CLOSED'

        await expect(
            PredictionOrderService.cancelOrder('alice', rested.order.id),
        ).rejects.toMatchObject({ statusCode: 409 })
    })

    it('404s on an unknown order', async () => {
        seedUser('alice', 1000)

        await expect(
            PredictionOrderService.cancelOrder('alice', 'nope'),
        ).rejects.toMatchObject({ statusCode: 404 })
    })
})

// ── Listing ───────────────────────────────────────────────────────────────────

describe('order listing', () => {
    it('returns a player s own orders, newest first', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 5000)
        seedUser('bob', 5000)

        await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 10, quantity: 1,
        })
        const second = await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 11, quantity: 1,
        })
        await PredictionOrderService.placeOrder('bob', {
            marketId, outcomeId: outcomeA, limitPrice: 12, quantity: 1,
        })

        const mine = await PredictionOrderService.listUserOrders('alice')
        expect(mine.orders).toHaveLength(2)
        expect(mine.orders[0].id).toBe(second.order.id)
        expect(mine.orders.every((o: any) => o.userId === 'alice')).toBe(true)

        const all = await PredictionOrderService.listMarketOrders(marketId)
        expect(all.orders).toHaveLength(3)
    })

    it('filters by status', async () => {
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 5000)

        const first = await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 10, quantity: 1,
        })
        await PredictionOrderService.placeOrder('alice', {
            marketId, outcomeId: outcomeA, limitPrice: 11, quantity: 1,
        })
        await PredictionOrderService.cancelOrder('alice', first.order.id)

        const open = await PredictionOrderService.listUserOrders('alice', { status: 'OPEN' as any })
        expect(open.orders).toHaveLength(1)
        expect(open.orders[0].status).toBe('OPEN')
    })
})

// ── Solvency over an arbitrary sequence ───────────────────────────────────────

describe('escrow and solvency across an arbitrary order sequence', () => {
    it('keeps Σ costBasis == totalShares × shareValue and conserves every birr', async () => {
        const { marketId, outcomeA, outcomeB } = seedMarket()
        const players = ['alice', 'bob', 'carol', 'dave']
        for (const player of players) seedUser(player, 50_000, 10_000)

        const opening = moneyInSystem()
        expect(opening.toString()).toBe('240000')

        // Deterministic pseudo-random tape: reproducible if it ever breaks.
        let state = 20260813
        const rand = () => {
            state = (state * 1664525 + 1013904223) >>> 0
            return state / 0x100000000
        }

        const placed: Array<{ userId: string; orderId: string }> = []

        for (let i = 0; i < 60; i += 1) {
            const userId = players[Math.floor(rand() * players.length)]
            const outcomeId = rand() < 0.5 ? outcomeA : outcomeB
            const limitPrice = 1 + Math.floor(rand() * 99)
            const quantity = 1 + Math.floor(rand() * 8)

            const result = await PredictionOrderService.placeOrder(userId, {
                marketId, outcomeId, limitPrice, quantity,
            })
            placed.push({ userId, orderId: result.order.id })

            // Cancel an earlier order every so often, to interleave releases.
            if (rand() < 0.25 && placed.length > 3) {
                const victim = placed[Math.floor(rand() * placed.length)]
                await PredictionOrderService.cancelOrder(victim.userId, victim.orderId)
                    .catch(() => undefined)
            }

            const market = marketRow(marketId)
            const escrow = D(market.shareValue).times(market.totalShares)

            // The book holds exactly what it owes, after every single step.
            expect(totalCostBasis(marketId).toString()).toBe(escrow.toString())
            expect(market.totalVolume.toString()).toBe(escrow.toString())
            // Not a birr created or destroyed anywhere in the system.
            expect(moneyInSystem().toString()).toBe(opening.toString())
        }

        const market = marketRow(marketId)
        expect(market.totalShares).toBeGreaterThan(0)

        // Gross payout to whichever side wins is exactly the total escrow: both
        // sides hold the same number of shares, because every fill issues a pair.
        const sharesOn = (outcomeId: string) =>
            db.tables.predictionPosition
                .filter((p) => p.outcomeId === outcomeId)
                .reduce((acc, p) => acc + p.shares, 0)

        expect(sharesOn(outcomeA)).toBe(market.totalShares)
        expect(sharesOn(outcomeB)).toBe(market.totalShares)
        expect(D(market.shareValue).times(sharesOn(outcomeA)).toString())
            .toBe(totalCostBasis(marketId).toString())

        // No order ever holds more than its unfilled shares are worth.
        for (const order of db.tables.predictionOrder) {
            const held = D(order.reservedReal).plus(order.reservedBonus)
            const unfilled = order.quantity - order.filledQuantity
            expect(held.lessThanOrEqualTo(D(order.limitPrice).times(unfilled))).toBe(true)
            expect(D(order.reservedReal).greaterThanOrEqualTo(0)).toBe(true)
            expect(D(order.reservedBonus).greaterThanOrEqualTo(0)).toBe(true)
        }

        // And nobody's wallet went negative on the way.
        for (const wallet of db.tables.wallet) {
            expect(D(wallet.realBalance).greaterThanOrEqualTo(0)).toBe(true)
            expect(D(wallet.bonusBalance).greaterThanOrEqualTo(0)).toBe(true)
        }
    })
})

// ── Lock release ──────────────────────────────────────────────────────────────

describe('the per-market match lock', () => {
    /**
     * redlock@4 — the version this repo pins — returns a `Lock` whose prototype
     * carries exactly `unlock` and `extend`. There is no `Lock#release`; only the
     * Redlock CLIENT has `release`, as an alias of `unlock`. A `finally` block
     * that calls `lock.release()` therefore throws a TypeError AFTER the money
     * has already committed, turning every successful placement into a 500.
     */
    it('releases a lock shaped the way redlock v4 actually shapes it', async () => {
        lockMode.faithful = true
        const { marketId, outcomeA } = seedMarket()
        seedUser('alice', 1000)

        await expect(
            PredictionOrderService.placeOrder('alice', {
                marketId, outcomeId: outcomeA, limitPrice: 35, quantity: 1,
            }),
        ).resolves.toBeDefined()
    })
})
