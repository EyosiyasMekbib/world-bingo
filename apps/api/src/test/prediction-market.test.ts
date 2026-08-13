import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'

/**
 * Market lifecycle and admin CRUD.
 *
 *   DRAFT → OPEN → CLOSED → RESOLVING → SETTLED,  any non-terminal → VOIDED
 *
 * Three things this file exists to pin down, all of them the difference between
 * an honest book and a riggable one:
 *
 *   1. `shareValue` and `feePct` are SNAPSHOTTED onto the row at creation, from
 *      `SiteSetting` or an explicit override, and never read live afterwards;
 *   2. once the market is OPEN those terms — and the outcome labels — are frozen,
 *      because changing them while money is escrowed is indistinguishable from
 *      moving the goalposts;
 *   3. `disputeUntil` is STAMPED at resolve time, so editing the setting later
 *      cannot move a payout that is already scheduled.
 *
 * The refund machinery belongs to the settlement service and is mocked here; it
 * has its own suite.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

const queueMock = vi.hoisted(() => ({
    add: vi.fn().mockResolvedValue({}),
    getJob: vi.fn().mockResolvedValue(null),
    addBulk: vi.fn().mockResolvedValue([]),
}))

vi.mock('../lib/queue.js', () => ({
    getQueue: () => queueMock,
    QUEUE_NAMES: { PREDICTION: 'prediction', NOTIFICATION: 'notification' },
}))

vi.mock('../lib/sentry.js', () => ({ reportError: vi.fn() }))

const gatewayMock = vi.hoisted(() => ({
    emitBook: vi.fn(),
    emitTrade: vi.fn(),
    emitStatus: vi.fn(),
    emitSettled: vi.fn(),
}))
vi.mock('../gateways/prediction.gateway.js', () => gatewayMock)

const settlementMock = vi.hoisted(() => ({
    PredictionSettlementService: {
        voidMarket: vi.fn(),
        settleMarket: vi.fn(),
        /**
         * Faithful stand-in for the real helper: it runs `fn` under the settle
         * lock and reports whether it got the lock at all. `lockHeld` lets a case
         * simulate a payout already in flight.
         */
        withSettleLock: vi.fn(async (_marketId: string, fn: () => Promise<any>) => {
            if (settlementMock.lockHeld) return { acquired: false }
            return { acquired: true, result: await fn() }
        }),
    },
    lockHeld: false,
}))
vi.mock('../services/prediction/settlement.service.js', () => settlementMock)

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

import { PredictionMarketService } from '../services/prediction/market.service.js'

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

    const OPS = new Set(['equals', 'in', 'notIn', 'not', 'gt', 'gte', 'lt', 'lte', 'mode'])

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
            const value = row[key]
            if (isOpNode(cond)) {
                for (const [op, operand] of Object.entries(cond as Row)) {
                    if (op === 'equals' && !eq(value, operand)) return false
                    if (op === 'in' && !(operand as any[]).some((v) => eq(value, v))) return false
                    if (op === 'notIn' && (operand as any[]).some((v) => eq(value, v))) return false
                    if (op === 'not' && eq(value, operand)) return false
                    if (op === 'gt' && !(cmp(value, operand) > 0)) return false
                    if (op === 'gte' && !(cmp(value, operand) >= 0)) return false
                    if (op === 'lt' && !(cmp(value, operand) < 0)) return false
                    if (op === 'lte' && !(cmp(value, operand) <= 0)) return false
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

    const tables: Record<string, Row[]> = {
        user: [],
        auditLog: [],
        siteSetting: [],
        predictionMarket: [],
        predictionOutcome: [],
    }

    const defaults: Record<string, Row> = {
        user: {},
        auditLog: {},
        siteSetting: {},
        predictionMarket: {
            status: 'DRAFT',
            shareValue: dec(100),
            feePct: dec(15),
            minOrderShares: 1,
            maxOrderShares: 10000,
            totalShares: 0,
            totalVolume: dec(0),
            description: null,
            imageUrl: null,
            resolvesAt: null,
            winningOutcomeId: null,
            resolvedById: null,
            resolvedAt: null,
            disputeUntil: null,
            settledAt: null,
            voidReason: null,
            createdById: null,
        },
        predictionOutcome: { lastPrice: null },
    }

    let ids = 0
    let clock = 0
    const nextId = (model: string) => `${model}-${(ids += 1)}`
    const nextTime = () => new Date(1_800_000_000_000 + (clock += 1))

    function project(model: string, row: Row | null, args: any): any {
        if (!row) return null
        const out: Row = { ...row }
        if (args?.include?.outcomes && model === 'predictionMarket') {
            out.outcomes = sortRows(
                tables.predictionOutcome.filter((o) => o.marketId === row.id),
                { sortOrder: 'asc' },
            ).map((o) => ({ ...o }))
        }
        if (args?.select) {
            const picked: Row = {}
            for (const [key, want] of Object.entries(args.select)) {
                if (want) picked[key] = out[key]
            }
            return picked
        }
        return out
    }

    function model(name: string) {
        const rows = () => tables[name]
        const find = (where: any) => rows().find((r) => matches(r, where)) ?? null

        return {
            findUnique: async (args: any) => project(name, find(args.where), args),
            findFirst: async (args: any = {}) =>
                project(name, sortRows(rows().filter((r) => matches(r, args.where)),
                    args.orderBy)[0] ?? null, args),
            findMany: async (args: any = {}) => {
                let list = sortRows(rows().filter((r) => matches(r, args.where)), args.orderBy)
                if (args.cursor) {
                    const at = list.findIndex((r) => matches(r, args.cursor))
                    if (at >= 0) list = list.slice(at + (args.skip ?? 0))
                }
                if (args.take !== undefined) list = list.slice(0, args.take)
                return list.map((r) => project(name, r, args))
            },
            create: async (args: any) => {
                const nested: Row[] = []
                const data: Row = {}
                for (const [key, value] of Object.entries(args.data)) {
                    if (key === 'outcomes' && value && (value as Row).create) {
                        nested.push(...(value as Row).create)
                        continue
                    }
                    data[key] = value
                }
                const row: Row = {
                    id: nextId(name),
                    ...defaults[name],
                    ...data,
                    createdAt: nextTime(),
                    updatedAt: nextTime(),
                }
                rows().push(row)
                for (const child of nested) {
                    tables.predictionOutcome.push({
                        id: nextId('predictionOutcome'),
                        ...defaults.predictionOutcome,
                        ...child,
                        marketId: row.id,
                    })
                }
                return project(name, row, args)
            },
            update: async (args: any) => {
                const row = find(args.where)
                if (!row) throw new Error(`${name} not found`)
                Object.assign(row, args.data, { updatedAt: new Date() })
                return project(name, row, args)
            },
            updateMany: async (args: any) => {
                const list = rows().filter((r) => matches(r, args.where))
                for (const row of list) Object.assign(row, args.data, { updatedAt: new Date() })
                return { count: list.length }
            },
        }
    }

    const client: Row = {}
    for (const name of Object.keys(tables)) client[name] = model(name)

    const snapshot = () =>
        Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))

    client.$transaction = async (arg: any) => {
        if (Array.isArray(arg)) return Promise.all(arg)
        const snap = snapshot()
        try {
            return await arg(client)
        } catch (err) {
            for (const [k, v] of Object.entries(snap)) tables[k] = v
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

const HOUR = 3_600_000
const MINUTE = 60_000

const outcomes = [
    { label: 'Sedo', sortOrder: 0 },
    { label: 'Johnny', sortOrder: 1 },
]

function baseInput(overrides: Record<string, any> = {}) {
    return {
        eventName: 'ETFC Fight Night',
        question: 'Sedo vs Johnny — who wins?',
        closesAt: new Date(Date.now() + 24 * HOUR).toISOString(),
        outcomes,
        ...overrides,
    }
}

function setSetting(key: string, value: string) {
    db.tables.siteSetting.push({ key, value })
}

function marketRow(id: string) {
    return db.tables.predictionMarket.find((m) => m.id === id)!
}

function auditFor(id: string) {
    return db.tables.auditLog.filter((a) => a.target === `prediction_market:${id}`)
}

/** Create a market and drive it to `status` without going through the API. */
async function makeMarket(status: string, overrides: Record<string, any> = {}) {
    const market = await PredictionMarketService.createMarket(baseInput() as any, 'admin-1')
    const row = marketRow(market.id)
    Object.assign(row, { status }, overrides)
    return { id: market.id, outcomeA: market.outcomes[0].id, outcomeB: market.outcomes[1].id }
}

beforeEach(() => {
    db.reset()
    vi.clearAllMocks()
    settlementMock.lockHeld = false
    db.tables.user.push({ id: 'admin-1', username: 'adminka' })
    settlementMock.PredictionSettlementService.voidMarket.mockResolvedValue({
        marketId: 'x',
        voided: true,
        ordersRefunded: 2,
        positionsRefunded: 3,
        totalRefunded: new Decimal(1200),
    })
})

// ── createMarket ──────────────────────────────────────────────────────────────

describe('createMarket', () => {
    it('creates a DRAFT with both outcomes and the default terms snapshotted', async () => {
        const market = await PredictionMarketService.createMarket(baseInput() as any, 'admin-1')

        expect(market.status).toBe('DRAFT')
        expect(market.shareValue.toString()).toBe('100')
        expect(market.feePct.toString()).toBe('15')
        expect(market.outcomes.map((o: any) => [o.sortOrder, o.label])).toEqual([
            [0, 'Sedo'],
            [1, 'Johnny'],
        ])
        expect(market.createdById).toBe('admin-1')
    })

    it('snapshots shareValue and feePct from SiteSetting at creation time', async () => {
        setSetting('prediction_share_value', '50')
        setSetting('prediction_fee_pct', '7.5')

        const market = await PredictionMarketService.createMarket(baseInput() as any, 'admin-1')

        expect(market.shareValue.toString()).toBe('50')
        expect(market.feePct.toString()).toBe('7.5')

        // Moving the setting afterwards must not move this market's terms.
        db.tables.siteSetting.find((s) => s.key === 'prediction_share_value')!.value = '200'
        expect(marketRow(market.id).shareValue.toString()).toBe('50')
    })

    it('prefers an explicit override to the setting', async () => {
        setSetting('prediction_share_value', '50')

        const market = await PredictionMarketService.createMarket(
            baseInput({ shareValue: 100, feePct: '12.25' }) as any,
            'admin-1',
        )

        expect(market.shareValue.toString()).toBe('100')
        expect(market.feePct.toString()).toBe('12.25')
    })

    it('falls back to the defaults when a setting is unusable', async () => {
        setSetting('prediction_share_value', 'not-a-number')
        setSetting('prediction_fee_pct', '900')

        const market = await PredictionMarketService.createMarket(baseInput() as any, 'admin-1')

        expect(market.shareValue.toString()).toBe('100')
        expect(market.feePct.toString()).toBe('15')
    })

    it('rejects a share value that has no legal price grid', async () => {
        // 100.50 is not a whole number of ticks; 1 leaves no price between 1 and 0.
        for (const shareValue of ['100.50', 1, 0]) {
            await expect(
                PredictionMarketService.createMarket(baseInput({ shareValue }) as any, 'admin-1'),
            ).rejects.toMatchObject({ statusCode: 400 })
        }

        await expect(
            PredictionMarketService.createMarket(baseInput({ shareValue: 2 }) as any, 'admin-1'),
        ).resolves.toBeDefined()
    })

    it('rejects an impossible fee percentage', async () => {
        for (const feePct of ['101', '15.005', '-1', 'abc']) {
            await expect(
                PredictionMarketService.createMarket(baseInput({ feePct }) as any, 'admin-1'),
            ).rejects.toMatchObject({ statusCode: 400 })
        }
    })

    it('rejects a closesAt that is already in the past', async () => {
        await expect(
            PredictionMarketService.createMarket(
                baseInput({ closesAt: new Date(Date.now() - 1000).toISOString() }) as any,
                'admin-1',
            ),
        ).rejects.toThrow('closesAt must be in the future')
    })

    it('insists on exactly two distinct outcomes at sortOrder 0 and 1', async () => {
        const bad = [
            [{ label: 'Sedo', sortOrder: 0 }],
            [
                { label: 'Sedo', sortOrder: 0 },
                { label: 'Johnny', sortOrder: 1 },
                { label: 'Draw', sortOrder: 2 },
            ],
            [
                { label: 'Sedo', sortOrder: 0 },
                { label: 'Sedo', sortOrder: 1 },
            ],
            [
                { label: 'Sedo', sortOrder: 0 },
                { label: 'Johnny', sortOrder: 0 },
            ],
            [
                { label: 'Sedo', sortOrder: 1 },
                { label: 'Johnny', sortOrder: 2 },
            ],
        ]

        for (const outcomeSet of bad) {
            await expect(
                PredictionMarketService.createMarket(
                    baseInput({ outcomes: outcomeSet }) as any,
                    'admin-1',
                ),
            ).rejects.toMatchObject({ statusCode: 400 })
        }

        expect(db.tables.predictionMarket).toHaveLength(0)
    })

    it('rejects an order-size range that cannot be satisfied', async () => {
        await expect(
            PredictionMarketService.createMarket(
                baseInput({ minOrderShares: 10, maxOrderShares: 5 }) as any,
                'admin-1',
            ),
        ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('writes an audit entry targeting the market', async () => {
        const market = await PredictionMarketService.createMarket(baseInput() as any, 'admin-1')

        const [entry] = auditFor(market.id)
        expect(entry.action).toBe('prediction.create')
        expect(entry.actorId).toBe('admin-1')
        expect(entry.actorName).toBe('adminka')
        expect(entry.detail.shareValue).toBe('100')
    })
})

// ── publish / close ───────────────────────────────────────────────────────────

describe('publishMarket', () => {
    it('takes a DRAFT to OPEN and broadcasts the transition', async () => {
        const { id } = await makeMarket('DRAFT')

        const published = await PredictionMarketService.publishMarket(id, 'admin-1')

        expect(published.status).toBe('OPEN')
        expect(gatewayMock.emitStatus).toHaveBeenCalledWith(id)
        expect(auditFor(id).some((a) => a.action === 'prediction.publish')).toBe(true)
    })

    it('refuses anything that is not a draft', async () => {
        for (const status of ['OPEN', 'CLOSED', 'RESOLVING', 'SETTLED', 'VOIDED']) {
            const { id } = await makeMarket(status)
            await expect(
                PredictionMarketService.publishMarket(id, 'admin-1'),
            ).rejects.toMatchObject({ statusCode: 409 })
            expect(marketRow(id).status).toBe(status)
        }
    })

    it('refuses to publish a market whose closesAt has already passed', async () => {
        const { id } = await makeMarket('DRAFT', { closesAt: new Date(Date.now() - 1000) })

        await expect(PredictionMarketService.publishMarket(id, 'admin-1'))
            .rejects.toThrow(/closesAt is in the past/)
    })

    it('refuses to publish a market that lost an outcome', async () => {
        const { id, outcomeB } = await makeMarket('DRAFT')
        db.tables.predictionOutcome = db.tables.predictionOutcome.filter((o) => o.id !== outcomeB)

        await expect(PredictionMarketService.publishMarket(id, 'admin-1'))
            .rejects.toThrow('A binary market needs exactly 2 outcomes')
    })
})

describe('closeMarket', () => {
    it('takes OPEN to CLOSED', async () => {
        const { id } = await makeMarket('OPEN')

        const closed = await PredictionMarketService.closeMarket(id, 'admin-1')

        expect(closed.status).toBe('CLOSED')
        expect(auditFor(id).some((a) => a.action === 'prediction.close')).toBe(true)
    })

    it('is idempotent — closing a CLOSED market is a no-op, not an error', async () => {
        const { id } = await makeMarket('OPEN')

        await PredictionMarketService.closeMarket(id, 'admin-1')
        const again = await PredictionMarketService.closeMarket(id, 'admin-1')

        expect(again.status).toBe('CLOSED')
        expect(auditFor(id).filter((a) => a.action === 'prediction.close')).toHaveLength(1)
    })

    it('refuses to close a market that was never open', async () => {
        for (const status of ['DRAFT', 'RESOLVING', 'SETTLED', 'VOIDED']) {
            const { id } = await makeMarket(status)
            await expect(PredictionMarketService.closeMarket(id, 'admin-1'))
                .rejects.toMatchObject({ statusCode: 409 })
        }
    })
})

describe('closeDueMarkets', () => {
    it('closes only the OPEN markets past their closesAt', async () => {
        const due = await makeMarket('OPEN', { closesAt: new Date(Date.now() - 1000) })
        const early = await makeMarket('OPEN', { closesAt: new Date(Date.now() + HOUR) })
        const draft = await makeMarket('DRAFT', { closesAt: new Date(Date.now() - 1000) })

        const closed = await PredictionMarketService.closeDueMarkets()

        expect(closed).toEqual([due.id])
        expect(marketRow(due.id).status).toBe('CLOSED')
        expect(marketRow(early.id).status).toBe('OPEN')
        expect(marketRow(draft.id).status).toBe('DRAFT')
        expect(gatewayMock.emitStatus).toHaveBeenCalledWith(due.id)
    })

    it('reports nothing on a second pass', async () => {
        await makeMarket('OPEN', { closesAt: new Date(Date.now() - 1000) })

        await PredictionMarketService.closeDueMarkets()
        expect(await PredictionMarketService.closeDueMarkets()).toEqual([])
    })
})

// ── resolve / unresolve ───────────────────────────────────────────────────────

describe('resolveMarket', () => {
    it('takes CLOSED to RESOLVING, stamps the dispute window and schedules the payout', async () => {
        setSetting('prediction_dispute_minutes', '45')
        const { id, outcomeA } = await makeMarket('CLOSED')

        const before = Date.now()
        const resolved = await PredictionMarketService.resolveMarket(id, outcomeA, 'admin-1')

        expect(resolved.status).toBe('RESOLVING')
        expect(resolved.winningOutcomeId).toBe(outcomeA)
        expect(resolved.resolvedById).toBe('admin-1')

        const window = resolved.disputeUntil!.getTime() - before
        expect(window).toBeGreaterThanOrEqual(45 * MINUTE - 5000)
        expect(window).toBeLessThanOrEqual(45 * MINUTE + 5000)

        const [name, payload, options] = queueMock.add.mock.calls[0]
        expect(name).toBe('settle-market')
        expect(payload).toEqual({ marketId: id })
        // The id carries `resolvedAt`, so a later resolution of the same market
        // cannot collide with this one's key and be silently dropped by BullMQ.
        expect(options.jobId).toBe(`settle:${id}:${resolved.resolvedAt!.getTime()}`)
        expect(options.delay).toBeGreaterThan(44 * MINUTE)
    })

    it('gives a re-resolve its own job id rather than reusing the first one', async () => {
        const { id, outcomeA, outcomeB } = await makeMarket('CLOSED')

        const first = await PredictionMarketService.resolveMarket(id, outcomeA, 'admin-1')
        // Reverse it and call the other side. BullMQ ignores an `add` whose jobId
        // already exists — including a completed one — so a shared id would leave
        // the second resolution with no payout scheduled at all.
        queueMock.getJob.mockResolvedValue({ remove: vi.fn() })
        await PredictionMarketService.unresolveMarket(id, 'admin-1')
        // The id is stamped to the millisecond; a human never resolves twice
        // inside one, but this loop would.
        await new Promise((resolve) => setTimeout(resolve, 2))
        const second = await PredictionMarketService.resolveMarket(id, outcomeB, 'admin-1')

        const ids = queueMock.add.mock.calls.map((call: any[]) => call[2].jobId)
        expect(ids).toEqual([
            `settle:${id}:${first.resolvedAt!.getTime()}`,
            `settle:${id}:${second.resolvedAt!.getTime()}`,
        ])
        expect(new Set(ids).size).toBe(2)
    })

    it('uses the default 30 minute window when the setting is absent or junk', async () => {
        setSetting('prediction_dispute_minutes', 'soon')
        const { id, outcomeA } = await makeMarket('CLOSED')

        const before = Date.now()
        const resolved = await PredictionMarketService.resolveMarket(id, outcomeA, 'admin-1')

        expect(resolved.disputeUntil!.getTime() - before).toBeGreaterThanOrEqual(30 * MINUTE - 5000)
    })

    it('leaves disputeUntil where it was stamped when the setting changes later', async () => {
        setSetting('prediction_dispute_minutes', '45')
        const { id, outcomeA } = await makeMarket('CLOSED')

        const resolved = await PredictionMarketService.resolveMarket(id, outcomeA, 'admin-1')
        const stamped = resolved.disputeUntil!.getTime()

        db.tables.siteSetting.find((s) => s.key === 'prediction_dispute_minutes')!.value = '1'

        expect(marketRow(id).disputeUntil.getTime()).toBe(stamped)
    })

    it('refuses to resolve a market that is not CLOSED', async () => {
        for (const status of ['DRAFT', 'OPEN', 'RESOLVING', 'SETTLED', 'VOIDED']) {
            const { id, outcomeA } = await makeMarket(status)
            await expect(
                PredictionMarketService.resolveMarket(id, outcomeA, 'admin-1'),
            ).rejects.toMatchObject({
                message: 'Only a closed market can be resolved',
                statusCode: 409,
            })
            expect(marketRow(id).winningOutcomeId).toBeNull()
        }

        expect(queueMock.add).not.toHaveBeenCalled()
    })

    it('refuses an outcome from another market', async () => {
        const { id } = await makeMarket('CLOSED')
        const other = await makeMarket('CLOSED')

        await expect(
            PredictionMarketService.resolveMarket(id, other.outcomeA, 'admin-1'),
        ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('records the call in the audit trail', async () => {
        const { id, outcomeA } = await makeMarket('CLOSED')

        await PredictionMarketService.resolveMarket(id, outcomeA, 'admin-1')

        const entry = auditFor(id).find((a) => a.action === 'prediction.resolve')!
        expect(entry.detail.winningOutcomeId).toBe(outcomeA)
        expect(entry.detail.winningLabel).toBe('Sedo')
    })
})

describe('unresolveMarket', () => {
    it('reverses a resolve inside the dispute window and pulls the settle job', async () => {
        const remove = vi.fn().mockResolvedValue(undefined)
        queueMock.getJob.mockResolvedValue({ remove })

        const resolvedAt = new Date()
        const { id, outcomeA } = await makeMarket('RESOLVING', {
            winningOutcomeId: 'placeholder',
            resolvedAt,
            disputeUntil: new Date(Date.now() + 20 * MINUTE),
        })
        marketRow(id).winningOutcomeId = outcomeA

        const reversed = await PredictionMarketService.unresolveMarket(id, 'admin-1')

        expect(reversed.status).toBe('CLOSED')
        expect(reversed.winningOutcomeId).toBeNull()
        expect(reversed.disputeUntil).toBeNull()
        expect(reversed.resolvedAt).toBeNull()
        expect(queueMock.getJob).toHaveBeenCalledWith(`settle:${id}:${resolvedAt.getTime()}`)
        expect(remove).toHaveBeenCalled()
    })

    it('refuses to reverse a market whose payout already holds the settle lock', async () => {
        settlementMock.lockHeld = true

        const { id, outcomeA } = await makeMarket('RESOLVING', {
            winningOutcomeId: 'placeholder',
            resolvedAt: new Date(),
            disputeUntil: new Date(Date.now() + 20 * MINUTE),
        })
        marketRow(id).winningOutcomeId = outcomeA

        await expect(PredictionMarketService.unresolveMarket(id, 'admin-1'))
            .rejects.toMatchObject({ statusCode: 409 })

        // Nothing moved: settlement is mid-payout and reversing under it would
        // leave the market CLOSED with its winners already paid.
        expect(marketRow(id).status).toBe('RESOLVING')
        expect(marketRow(id).winningOutcomeId).toBe(outcomeA)
    })

    it('refuses once the dispute window has closed', async () => {
        const { id, outcomeA } = await makeMarket('RESOLVING', {
            winningOutcomeId: 'placeholder',
            disputeUntil: new Date(Date.now() - 1),
        })
        marketRow(id).winningOutcomeId = outcomeA

        await expect(PredictionMarketService.unresolveMarket(id, 'admin-1'))
            .rejects.toMatchObject({
                message: 'The dispute window has closed — resolve it correctly instead',
                statusCode: 409,
            })

        // Still RESOLVING, still pointing at the winner — the payout stands.
        expect(marketRow(id).status).toBe('RESOLVING')
        expect(marketRow(id).winningOutcomeId).toBe(outcomeA)
    })

    it('refuses a market that is not awaiting settlement', async () => {
        for (const status of ['DRAFT', 'OPEN', 'CLOSED', 'SETTLED', 'VOIDED']) {
            const { id } = await makeMarket(status, {
                disputeUntil: new Date(Date.now() + HOUR),
            })
            await expect(PredictionMarketService.unresolveMarket(id, 'admin-1'))
                .rejects.toMatchObject({ statusCode: 409 })
        }
    })

    it('round-trips: resolve, unresolve, resolve the other way', async () => {
        queueMock.getJob.mockResolvedValue({ remove: vi.fn() })
        const { id, outcomeA, outcomeB } = await makeMarket('CLOSED')

        await PredictionMarketService.resolveMarket(id, outcomeA, 'admin-1')
        await PredictionMarketService.unresolveMarket(id, 'admin-1')
        const second = await PredictionMarketService.resolveMarket(id, outcomeB, 'admin-1')

        expect(second.status).toBe('RESOLVING')
        expect(second.winningOutcomeId).toBe(outcomeB)
    })
})

// ── updateMarket ──────────────────────────────────────────────────────────────

describe('updateMarket — everything is editable while DRAFT', () => {
    it('edits terms, dates and outcome labels', async () => {
        const { id } = await makeMarket('DRAFT')

        const updated = await PredictionMarketService.updateMarket(
            id,
            {
                question: 'Sedo vs Johnny — main event',
                shareValue: 50,
                feePct: '10',
                description: 'Heavyweight, 5 rounds',
                outcomes: [
                    { label: 'The Beast', sortOrder: 0 },
                    { label: 'Jiu-Jitsu', sortOrder: 1 },
                ],
            },
            'admin-1',
        )

        expect(updated.question).toBe('Sedo vs Johnny — main event')
        expect(updated.shareValue.toString()).toBe('50')
        expect(updated.feePct.toString()).toBe('10')
        expect(updated.outcomes.map((o: any) => o.label)).toEqual(['The Beast', 'Jiu-Jitsu'])
    })

    it('lets a draft closesAt move in either direction, but not into the past', async () => {
        const { id } = await makeMarket('DRAFT')

        const earlier = await PredictionMarketService.updateMarket(
            id,
            { closesAt: new Date(Date.now() + HOUR).toISOString() },
            'admin-1',
        )
        expect(earlier.closesAt.getTime()).toBeGreaterThan(Date.now())

        await expect(
            PredictionMarketService.updateMarket(
                id,
                { closesAt: new Date(Date.now() - 1000).toISOString() },
                'admin-1',
            ),
        ).rejects.toThrow('closesAt must be in the future')
    })
})

describe('updateMarket — the freeze once a market is published', () => {
    it('rejects a change to any field that carries value', async () => {
        const frozen: Array<[string, Record<string, any>]> = [
            ['question', { question: 'Something else entirely' }],
            ['shareValue', { shareValue: 50 }],
            ['feePct', { feePct: '30' }],
            ['eventName', { eventName: 'Another card' }],
            ['minOrderShares', { minOrderShares: 5 }],
            ['maxOrderShares', { maxOrderShares: 50 }],
            ['outcome labels', {
                outcomes: [
                    { label: 'Renamed', sortOrder: 0 },
                    { label: 'Johnny', sortOrder: 1 },
                ],
            }],
        ]

        for (const [field, patch] of frozen) {
            const { id } = await makeMarket('OPEN')
            await expect(
                PredictionMarketService.updateMarket(id, patch as any, 'admin-1'),
            ).rejects.toMatchObject({
                message: `Cannot change ${field} once a market is published`,
                statusCode: 409,
            })
        }
    })

    it('still allows presentation edits', async () => {
        const { id } = await makeMarket('OPEN')

        const updated = await PredictionMarketService.updateMarket(
            id,
            { description: 'Main event, 5 rounds', imageUrl: 'https://cdn.invalid/sedo.jpg' },
            'admin-1',
        )

        expect(updated.description).toBe('Main event, 5 rounds')
        expect(updated.imageUrl).toBe('https://cdn.invalid/sedo.jpg')
    })

    it('lets closesAt be extended but never pulled in', async () => {
        const { id } = await makeMarket('OPEN')
        const original = marketRow(id).closesAt.getTime()

        const extended = await PredictionMarketService.updateMarket(
            id,
            { closesAt: new Date(original + HOUR).toISOString() },
            'admin-1',
        )
        expect(extended.closesAt.getTime()).toBe(original + HOUR)

        await expect(
            PredictionMarketService.updateMarket(
                id,
                { closesAt: new Date(original).toISOString() },
                'admin-1',
            ),
        ).rejects.toThrow('closesAt can only be extended once a market is published')
    })

    it('treats a full form post of unchanged frozen fields as no edit at all', async () => {
        const { id } = await makeMarket('OPEN')
        const market = marketRow(id)

        const updated = await PredictionMarketService.updateMarket(
            id,
            {
                eventName: market.eventName,
                question: market.question,
                shareValue: 100,
                feePct: '15',
                outcomes,
                description: 'Now with a blurb',
            },
            'admin-1',
        )

        expect(updated.description).toBe('Now with a blurb')
        expect(updated.question).toBe(market.question)
    })

    it('refuses to edit a terminal market at all', async () => {
        for (const status of ['SETTLED', 'VOIDED']) {
            const { id } = await makeMarket(status)
            await expect(
                PredictionMarketService.updateMarket(id, { description: 'nope' }, 'admin-1'),
            ).rejects.toMatchObject({ statusCode: 409 })
        }
    })

    it('404s on a market that does not exist', async () => {
        await expect(
            PredictionMarketService.updateMarket('nope', { description: 'x' }, 'admin-1'),
        ).rejects.toMatchObject({ statusCode: 404 })
    })
})

// ── void ──────────────────────────────────────────────────────────────────────

describe('voidMarket', () => {
    it('delegates the refunds to settlement and audits the reason', async () => {
        const { id } = await makeMarket('OPEN')

        await PredictionMarketService.voidMarket(id, 'Draw', 'admin-1')

        expect(settlementMock.PredictionSettlementService.voidMarket)
            .toHaveBeenCalledWith(id, 'Draw')

        const entry = auditFor(id).find((a) => a.action === 'prediction.void')!
        expect(entry.detail.reason).toBe('Draw')
        expect(entry.detail.previousStatus).toBe('OPEN')
        expect(entry.detail.totalRefunded).toBe('1200')
    })

    it('pulls a pending settle job before unwinding a RESOLVING market', async () => {
        const remove = vi.fn()
        queueMock.getJob.mockResolvedValue({ remove })
        const resolvedAt = new Date()
        const { id } = await makeMarket('RESOLVING', {
            resolvedAt,
            disputeUntil: new Date(Date.now() + HOUR),
        })

        await PredictionMarketService.voidMarket(id, 'No contest', 'admin-1')

        expect(queueMock.getJob).toHaveBeenCalledWith(`settle:${id}:${resolvedAt.getTime()}`)
        expect(remove).toHaveBeenCalled()
    })

    it('refuses a terminal market and never calls settlement', async () => {
        for (const status of ['SETTLED', 'VOIDED']) {
            const { id } = await makeMarket(status)
            await expect(
                PredictionMarketService.voidMarket(id, 'Draw', 'admin-1'),
            ).rejects.toMatchObject({ statusCode: 409 })
        }

        expect(settlementMock.PredictionSettlementService.voidMarket).not.toHaveBeenCalled()
    })

    it('requires a reason', async () => {
        const { id } = await makeMarket('OPEN')

        await expect(
            PredictionMarketService.voidMarket(id, '   ', 'admin-1'),
        ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('surfaces a settlement that could not take the lock as a retryable 409', async () => {
        settlementMock.PredictionSettlementService.voidMarket.mockResolvedValue({
            voided: false,
            reason: 'lock_not_acquired',
        })
        const { id } = await makeMarket('OPEN')

        await expect(
            PredictionMarketService.voidMarket(id, 'Draw', 'admin-1'),
        ).rejects.toMatchObject({ statusCode: 409 })
    })
})

// ── reads ─────────────────────────────────────────────────────────────────────

describe('listMarkets / getMarket', () => {
    it('orders by closesAt and can hide drafts from players', async () => {
        const late = await makeMarket('OPEN', { closesAt: new Date(Date.now() + 3 * HOUR) })
        const soon = await makeMarket('OPEN', { closesAt: new Date(Date.now() + HOUR) })
        const draft = await makeMarket('DRAFT', { closesAt: new Date(Date.now() + 2 * HOUR) })

        const all = await PredictionMarketService.listMarkets()
        expect(all.markets.map((m) => m.id)).toEqual([soon.id, draft.id, late.id])

        const players = await PredictionMarketService.listMarkets({ excludeDrafts: true })
        expect(players.markets.map((m) => m.id)).toEqual([soon.id, late.id])
    })

    it('filters by status and paginates with a cursor', async () => {
        await makeMarket('OPEN', { closesAt: new Date(Date.now() + HOUR) })
        await makeMarket('OPEN', { closesAt: new Date(Date.now() + 2 * HOUR) })
        await makeMarket('CLOSED', { closesAt: new Date(Date.now() + 3 * HOUR) })

        const open = await PredictionMarketService.listMarkets({ status: 'OPEN' as any })
        expect(open.markets).toHaveLength(2)

        const firstPage = await PredictionMarketService.listMarkets({ limit: 1 })
        expect(firstPage.markets).toHaveLength(1)
        expect(firstPage.nextCursor).toBe(firstPage.markets[0].id)

        const secondPage = await PredictionMarketService.listMarkets({
            limit: 1,
            cursor: firstPage.nextCursor!,
        })
        expect(secondPage.markets[0].id).not.toBe(firstPage.markets[0].id)
    })

    it('returns one market with its outcomes in sortOrder, and 404s otherwise', async () => {
        const { id } = await makeMarket('OPEN')

        const market = await PredictionMarketService.getMarket(id)
        expect(market.outcomes.map((o: any) => o.sortOrder)).toEqual([0, 1])

        await expect(PredictionMarketService.getMarket('nope'))
            .rejects.toMatchObject({ statusCode: 404 })
    })
})
