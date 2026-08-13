import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import {
    PredictionMatchingService,
    predictionOrderStatusFor,
    splitAgainstReserve,
    type PredictionRestingOrder,
} from '../services/prediction/matching.service.js'

/**
 * The matching engine.
 *
 * `planFills` is pure — no prisma, no clock, no mocks. It is tested directly and
 * exhaustively because every birr in the feature is priced here.
 *
 * The two properties the whole design rests on, restated as assertions:
 *
 *   1. a pair matches only when `makerPrice + takerPrice >= shareValue`, and the
 *      pair then escrows EXACTLY `shareValue` per share — never more (the book
 *      would owe money it does not hold) and never less (the house would be
 *      funding the gap, i.e. taking a position);
 *   2. the taker keeps the price improvement: the maker pays its own limit, the
 *      taker pays `shareValue - makerPrice`, which is at or below its own limit.
 *
 * `shareValue` is per-market data. Every case below is parameterised on it and
 * the suite runs the invariants at 50 as well as 100 so nothing can quietly
 * hardcode the default.
 */

const D = (value: number | string) => new Decimal(value)

const SHARE_100 = D(100)
const SHARE_50 = D(50)

let seq = 0

function resting(
    price: number,
    quantity: number,
    overrides: Partial<PredictionRestingOrder> = {},
): PredictionRestingOrder {
    seq += 1
    return {
        id: overrides.id ?? `maker-${seq}`,
        userId: overrides.userId ?? `maker-user-${seq}`,
        limitPrice: D(price),
        quantity,
        filledQuantity: overrides.filledQuantity ?? 0,
    }
}

// ── planFills — eligibility ───────────────────────────────────────────────────

describe('planFills — when a pair may match at all', () => {
    it('produces no fills against an empty book and leaves the whole order resting', () => {
        const plan = PredictionMatchingService.planFills(SHARE_100, D(35), 10, 'taker', [])

        expect(plan.fills).toEqual([])
        expect(plan.filledQuantity).toBe(0)
        expect(plan.unfilledQuantity).toBe(10)
    })

    it('produces no fills when every resting price is too low to cover a share', () => {
        // 60 + 30 = 90 and 50 + 30 = 80; neither pair funds a 100 ETB share.
        const book = [resting(60, 5), resting(50, 5)]

        const plan = PredictionMatchingService.planFills(SHARE_100, D(30), 5, 'taker', book)

        expect(plan.fills).toEqual([])
        expect(plan.unfilledQuantity).toBe(5)
    })

    it('matches when the two limits sum to exactly shareValue', () => {
        const plan = PredictionMatchingService.planFills(SHARE_100, D(35), 4, 'taker', [
            resting(65, 4),
        ])

        expect(plan.fills).toHaveLength(1)
        expect(plan.fills[0].quantity).toBe(4)
        expect(plan.fills[0].makerPrice.toString()).toBe('65')
        expect(plan.fills[0].takerPrice.toString()).toBe('35')
        expect(plan.unfilledQuantity).toBe(0)
    })

    it('refuses to match one birr short of a whole share', () => {
        // 64 + 35 = 99. Filling this would escrow 99 against a 100 ETB obligation.
        const plan = PredictionMatchingService.planFills(SHARE_100, D(35), 4, 'taker', [
            resting(64, 4),
        ])

        expect(plan.fills).toEqual([])
        expect(plan.filledQuantity).toBe(0)
    })

    it('stops at the first ineligible maker instead of scanning the rest of the book', () => {
        // Sorted DESC, so once one maker cannot pay the complement none below it can.
        const book = [resting(70, 1), resting(60, 1), resting(59, 1), resting(10, 1)]

        const plan = PredictionMatchingService.planFills(SHARE_100, D(40), 10, 'taker', book)

        expect(plan.fills.map((f) => f.makerPrice.toString())).toEqual(['70', '60'])
        expect(plan.unfilledQuantity).toBe(8)
    })
})

// ── planFills — pricing ───────────────────────────────────────────────────────

describe('planFills — the maker pays its limit and the taker keeps the improvement', () => {
    it('charges the taker shareValue - makerPrice, not its own limit', () => {
        // Taker bid 70 but the best maker only needs 65, so the taker pays 35.
        const plan = PredictionMatchingService.planFills(SHARE_100, D(70), 3, 'taker', [
            resting(65, 3),
        ])

        const fill = plan.fills[0]
        expect(fill.makerPrice.toString()).toBe('65')
        expect(fill.takerPrice.toString()).toBe('35')
        // 70 - 35 = 35 per share of improvement the taker never escrows.
        expect(D(70).minus(fill.takerPrice).times(fill.quantity).toString()).toBe('105')
    })

    it('never charges the taker above its own limit', () => {
        const book = [resting(99, 1), resting(80, 1), resting(66, 1)]

        const plan = PredictionMatchingService.planFills(SHARE_100, D(34), 3, 'taker', book)

        for (const fill of plan.fills) {
            expect(fill.takerPrice.lessThanOrEqualTo(D(34))).toBe(true)
        }
        expect(plan.fills.map((f) => f.takerPrice.toString())).toEqual(['1', '20', '34'])
    })

    it('escrows exactly shareValue per share on every fill', () => {
        const book = [resting(70, 2), resting(65, 2), resting(60, 2)]

        const plan = PredictionMatchingService.planFills(SHARE_100, D(45), 6, 'taker', book)

        let escrowed = D(0)
        for (const fill of plan.fills) {
            expect(fill.makerPrice.plus(fill.takerPrice).equals(SHARE_100)).toBe(true)
            escrowed = escrowed.plus(fill.makerPrice.plus(fill.takerPrice).times(fill.quantity))
        }
        expect(escrowed.equals(SHARE_100.times(plan.filledQuantity))).toBe(true)
        expect(plan.filledQuantity).toBe(6)
    })
})

// ── planFills — priority and partial fills ────────────────────────────────────

describe('planFills — price-time priority', () => {
    it('serves the highest maker price first, which is the cheapest fill for the taker', () => {
        // Given in the order the SQL produces: limitPrice DESC.
        const book = [resting(80, 1), resting(70, 1), resting(65, 1)]

        const plan = PredictionMatchingService.planFills(SHARE_100, D(40), 3, 'taker', book)

        expect(plan.fills.map((f) => f.makerPrice.toString())).toEqual(['80', '70', '65'])
        expect(plan.fills.map((f) => f.takerPrice.toString())).toEqual(['20', '30', '35'])
    })

    it('serves the older order first when two makers rest at the same price', () => {
        // createdAt ASC within a price level: `older` was written first.
        const older = resting(70, 1, { id: 'older', userId: 'u-older' })
        const newer = resting(70, 1, { id: 'newer', userId: 'u-newer' })

        const plan = PredictionMatchingService.planFills(SHARE_100, D(40), 1, 'taker', [
            older,
            newer,
        ])

        expect(plan.fills).toHaveLength(1)
        expect(plan.fills[0].makerOrderId).toBe('older')
    })

    it('sweeps several makers and rests the remainder', () => {
        const book = [resting(65, 2), resting(60, 3)]

        const plan = PredictionMatchingService.planFills(SHARE_100, D(40), 10, 'taker', book)

        expect(plan.fills.map((f) => [f.makerPrice.toString(), f.quantity])).toEqual([
            ['65', 2],
            ['60', 3],
        ])
        expect(plan.filledQuantity).toBe(5)
        expect(plan.unfilledQuantity).toBe(5)
    })

    it('only takes a maker s unfilled remainder', () => {
        const book = [resting(70, 10, { filledQuantity: 7 })]

        const plan = PredictionMatchingService.planFills(SHARE_100, D(40), 10, 'taker', book)

        expect(plan.fills).toHaveLength(1)
        expect(plan.fills[0].quantity).toBe(3)
        expect(plan.unfilledQuantity).toBe(7)
    })

    it('skips a maker that is already fully filled', () => {
        const book = [
            resting(70, 5, { id: 'full', filledQuantity: 5 }),
            resting(65, 5, { id: 'live' }),
        ]

        const plan = PredictionMatchingService.planFills(SHARE_100, D(40), 2, 'taker', book)

        expect(plan.fills).toHaveLength(1)
        expect(plan.fills[0].makerOrderId).toBe('live')
    })

    it('stops walking once the taker is filled', () => {
        const book = [resting(70, 5), resting(69, 5), resting(68, 5)]

        const plan = PredictionMatchingService.planFills(SHARE_100, D(40), 5, 'taker', book)

        expect(plan.fills).toHaveLength(1)
        expect(plan.unfilledQuantity).toBe(0)
    })
})

// ── planFills — self-match ────────────────────────────────────────────────────

describe('planFills — self-match', () => {
    it('skips the taker s own resting orders', () => {
        const book = [resting(70, 5, { id: 'mine', userId: 'taker' })]

        const plan = PredictionMatchingService.planFills(SHARE_100, D(40), 5, 'taker', book)

        expect(plan.fills).toEqual([])
        expect(plan.unfilledQuantity).toBe(5)
    })

    it('steps over its own order and keeps filling against the rest of the book', () => {
        // `continue`, not `break` — a self-order at the top of the book must not
        // block the taker from the genuine counterparty behind it.
        const book = [
            resting(70, 5, { id: 'mine', userId: 'taker' }),
            resting(65, 5, { id: 'theirs', userId: 'other' }),
        ]

        const plan = PredictionMatchingService.planFills(SHARE_100, D(40), 5, 'taker', book)

        expect(plan.fills).toHaveLength(1)
        expect(plan.fills[0].makerOrderId).toBe('theirs')
        expect(plan.fills[0].makerUserId).toBe('other')
    })
})

// ── planFills — a share value that is not 100 ─────────────────────────────────

describe('planFills — shareValue is market data, never a constant', () => {
    it('matches on a 50 ETB share and prices the complement against 50', () => {
        // 30 + 25 = 55 >= 50, so the taker pays 50 - 30 = 20 and keeps 5.
        const plan = PredictionMatchingService.planFills(SHARE_50, D(25), 4, 'taker', [
            resting(30, 4),
        ])

        expect(plan.fills).toHaveLength(1)
        expect(plan.fills[0].makerPrice.toString()).toBe('30')
        expect(plan.fills[0].takerPrice.toString()).toBe('20')
        expect(plan.fills[0].makerPrice.plus(plan.fills[0].takerPrice).toString()).toBe('50')
    })

    it('rejects a pair that would match at a 100 ETB share but not at 50', () => {
        // 20 + 25 = 45: enough for nothing at a 50 ETB share.
        const plan = PredictionMatchingService.planFills(SHARE_50, D(25), 4, 'taker', [
            resting(20, 4),
        ])

        expect(plan.fills).toEqual([])
    })

    it('treats a maker at 60 as valid at share 100 and corrupt at share 50', () => {
        const book = [resting(60, 1)]

        expect(PredictionMatchingService.planFills(SHARE_100, D(40), 1, 'taker', book).fills)
            .toHaveLength(1)

        expect(() =>
            PredictionMatchingService.planFills(SHARE_50, D(40), 1, 'taker', [resting(60, 1)]),
        ).toThrow(/outside \(0, 50.00\)/)
    })
})

// ── planFills — refusals ──────────────────────────────────────────────────────

describe('planFills — refuses to price a corrupt book', () => {
    it('throws when a resting order sits at or above shareValue', () => {
        expect(() =>
            PredictionMatchingService.planFills(SHARE_100, D(50), 1, 'taker', [resting(100, 1)]),
        ).toThrow(/outside \(0, 100.00\)/)
    })

    it('throws on a fractional taker quantity', () => {
        expect(() =>
            PredictionMatchingService.planFills(SHARE_100, D(35), 1.5, 'taker', []),
        ).toThrow(/whole/)
    })

    it('returns an empty plan for a non-positive quantity', () => {
        const plan = PredictionMatchingService.planFills(SHARE_100, D(35), 0, 'taker', [
            resting(70, 5),
        ])

        expect(plan).toEqual({ fills: [], filledQuantity: 0, unfilledQuantity: 0 })
    })
})

// ── planFills — property sweep ────────────────────────────────────────────────

/**
 * A deterministic pseudo-random generator. Seeded so a failure is reproducible;
 * `Math.random` would make a solvency break unrepeatable, which is the one class
 * of bug that must never be hard to reproduce.
 */
function lcg(seed: number) {
    let state = seed >>> 0
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0
        return state / 0x100000000
    }
}

describe('planFills — escrow holds across arbitrary fill sequences', () => {
    for (const share of [100, 50]) {
        it(`escrows exactly ${share} per filled share over 400 random books`, () => {
            const rand = lcg(0x5eed + share)
            const shareValue = D(share)
            let sequencesWithFills = 0

            for (let run = 0; run < 400; run += 1) {
                const takerPrice = 1 + Math.floor(rand() * (share - 1))
                const takerQuantity = 1 + Math.floor(rand() * 25)
                const depth = Math.floor(rand() * 8)

                const book: PredictionRestingOrder[] = []
                for (let i = 0; i < depth; i += 1) {
                    const quantity = 1 + Math.floor(rand() * 12)
                    book.push({
                        id: `m${run}-${i}`,
                        // A third of the book belongs to the taker, to keep the
                        // self-match branch on the hot path of this sweep.
                        userId: rand() < 0.33 ? 'taker' : `u${run}-${i}`,
                        limitPrice: D(1 + Math.floor(rand() * (share - 1))),
                        quantity,
                        filledQuantity: Math.floor(rand() * quantity),
                    })
                }
                // The engine is handed a book already ordered limitPrice DESC.
                book.sort((a, b) => b.limitPrice.comparedTo(a.limitPrice))

                const plan = PredictionMatchingService.planFills(
                    shareValue,
                    D(takerPrice),
                    takerQuantity,
                    'taker',
                    book,
                )

                let escrow = D(0)
                let filled = 0
                const takenFrom = new Map<string, number>()

                for (const fill of plan.fills) {
                    // Invariant 1: the pair funds exactly one share.
                    expect(fill.makerPrice.plus(fill.takerPrice).equals(shareValue)).toBe(true)
                    // Invariant 2: the taker is never charged above its bid.
                    expect(fill.takerPrice.lessThanOrEqualTo(D(takerPrice))).toBe(true)
                    // The house is never the counterparty.
                    expect(fill.makerUserId).not.toBe('taker')
                    expect(fill.quantity).toBeGreaterThan(0)

                    escrow = escrow.plus(fill.makerPrice.plus(fill.takerPrice).times(fill.quantity))
                    filled += fill.quantity
                    takenFrom.set(
                        fill.makerOrderId,
                        (takenFrom.get(fill.makerOrderId) ?? 0) + fill.quantity,
                    )
                }

                // No maker is oversold beyond its own unfilled remainder.
                for (const [orderId, quantity] of takenFrom) {
                    const maker = book.find((o) => o.id === orderId)!
                    expect(quantity).toBeLessThanOrEqual(maker.quantity - maker.filledQuantity)
                }

                expect(filled).toBe(plan.filledQuantity)
                expect(plan.filledQuantity + plan.unfilledQuantity).toBe(takerQuantity)
                expect(escrow.equals(shareValue.times(plan.filledQuantity))).toBe(true)

                if (plan.filledQuantity > 0) sequencesWithFills += 1
            }

            // Guard against a sweep that proves nothing because it never matched.
            expect(sequencesWithFills).toBeGreaterThan(100)
        })
    }
})

// ── splitAgainstReserve ───────────────────────────────────────────────────────

describe('splitAgainstReserve — consumption keeps the original funding mix', () => {
    it('consumes bonus and real in the proportion they are held', () => {
        const split = splitAgainstReserve(D(50), D(40), D(60))

        expect(split.bonus.toString()).toBe('30')
        expect(split.real.toString()).toBe('20')
    })

    it('hands back the exact reserve when the whole thing is consumed', () => {
        const split = splitAgainstReserve(D(100), D(40), D(60))

        expect(split.real.toString()).toBe('40')
        expect(split.bonus.toString()).toBe('60')
    })

    it('never lets the real leg exceed what is actually held', () => {
        const split = splitAgainstReserve(D(33), D(1), D(99))

        expect(split.real.lessThanOrEqualTo(D(1))).toBe(true)
        expect(split.real.plus(split.bonus).equals(D(33))).toBe(true)
    })

    it('preserves bonus across a chain of partial consumptions', () => {
        // Whatever rounding does, consumed + remaining must equal the reserve to
        // the cent in BOTH buckets — otherwise bonus leaks out as real cash.
        let real = D(37)
        let bonus = D(63)
        let consumedBonus = D(0)
        let consumedReal = D(0)

        for (const amount of [7, 11, 13, 29, 40]) {
            const split = splitAgainstReserve(D(amount), real, bonus)
            real = real.minus(split.real)
            bonus = bonus.minus(split.bonus)
            consumedReal = consumedReal.plus(split.real)
            consumedBonus = consumedBonus.plus(split.bonus)
            expect(real.greaterThanOrEqualTo(0)).toBe(true)
            expect(bonus.greaterThanOrEqualTo(0)).toBe(true)
        }

        expect(consumedReal.plus(real).equals(D(37))).toBe(true)
        expect(consumedBonus.plus(bonus).equals(D(63))).toBe(true)
    })

    it('returns nothing for a non-positive amount', () => {
        const split = splitAgainstReserve(D(0), D(10), D(10))

        expect(split.real.toString()).toBe('0')
        expect(split.bonus.toString()).toBe('0')
    })

    it('refuses to consume more than the order holds', () => {
        expect(() => splitAgainstReserve(D(101), D(40), D(60))).toThrow(/reserve is short/)
    })
})

describe('predictionOrderStatusFor', () => {
    it('reports OPEN, PARTIALLY_FILLED and FILLED from the counts', () => {
        expect(predictionOrderStatusFor(0, 5)).toBe('OPEN')
        expect(predictionOrderStatusFor(2, 5)).toBe('PARTIALLY_FILLED')
        expect(predictionOrderStatusFor(5, 5)).toBe('FILLED')
    })
})

// ── matchOrder ────────────────────────────────────────────────────────────────

/**
 * `matchOrder` never reads back anything it writes, so a recording double is a
 * faithful stand-in for the transaction client and keeps these cases about the
 * engine rather than about a fake query planner.
 */
function makeTx(options: {
    outcomes?: Array<{ id: string }>
    resting?: any[]
} = {}) {
    const outcomes = options.outcomes ?? [{ id: 'outcome-a' }, { id: 'outcome-b' }]
    const restingRows = options.resting ?? []

    return {
        predictionOutcome: {
            findMany: vi.fn().mockResolvedValue(outcomes),
            update: vi.fn().mockResolvedValue({}),
        },
        predictionOrder: {
            findMany: vi.fn().mockResolvedValue(restingRows),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            update: vi.fn().mockResolvedValue({}),
        },
        predictionFill: { createMany: vi.fn().mockResolvedValue({ count: restingRows.length }) },
        predictionPosition: { upsert: vi.fn().mockResolvedValue({}) },
        predictionMarket: { update: vi.fn().mockResolvedValue({}) },
        wallet: { update: vi.fn(), findUnique: vi.fn() },
    }
}

function makerRow(overrides: Record<string, any> = {}) {
    return {
        id: 'maker-order',
        marketId: 'market-1',
        outcomeId: 'outcome-b',
        userId: 'bob',
        limitPrice: D(65),
        quantity: 2,
        filledQuantity: 0,
        reservedReal: D(130),
        reservedBonus: D(0),
        ...overrides,
    }
}

function takerRow(overrides: Record<string, any> = {}) {
    return {
        id: 'taker-order',
        marketId: 'market-1',
        outcomeId: 'outcome-a',
        userId: 'alice',
        limitPrice: D(40),
        quantity: 2,
        filledQuantity: 0,
        reservedReal: D(80),
        reservedBonus: D(0),
        ...overrides,
    }
}

describe('matchOrder — reading the book', () => {
    beforeEach(() => vi.clearAllMocks())

    it('queries the OPPOSITE outcome, price-time ordered, excluding the taker', async () => {
        const tx = makeTx()

        await PredictionMatchingService.matchOrder(tx as any, takerRow(), SHARE_100)

        const args = tx.predictionOrder.findMany.mock.calls[0][0]
        expect(args.where.outcomeId).toBe('outcome-b')
        expect(args.where.marketId).toBe('market-1')
        expect(args.where.status).toEqual({ in: ['OPEN', 'PARTIALLY_FILLED'] })
        expect(args.where.userId).toEqual({ not: 'alice' })
        // makerPrice >= shareValue - takerPrice, pushed into SQL.
        expect(args.where.limitPrice.gte.toString()).toBe('60')
        expect(args.orderBy).toEqual([{ limitPrice: 'desc' }, { createdAt: 'asc' }])
    })

    it('derives the eligibility bound from the market s own shareValue', async () => {
        const tx = makeTx()

        await PredictionMatchingService.matchOrder(
            tx as any,
            takerRow({ limitPrice: D(25) }),
            SHARE_50,
        )

        expect(tx.predictionOrder.findMany.mock.calls[0][0].where.limitPrice.gte.toString())
            .toBe('25')
    })

    it('does nothing when the book is empty', async () => {
        const tx = makeTx()

        const result = await PredictionMatchingService.matchOrder(tx as any, takerRow(), SHARE_100)

        expect(result.filledQuantity).toBe(0)
        expect(tx.predictionFill.createMany).not.toHaveBeenCalled()
        expect(tx.predictionMarket.update).not.toHaveBeenCalled()
    })

    it('refuses to match a market that is not binary', async () => {
        const tx = makeTx({ outcomes: [{ id: 'outcome-a' }, { id: 'outcome-b' }, { id: 'c' }] })

        await expect(
            PredictionMatchingService.matchOrder(tx as any, takerRow(), SHARE_100),
        ).rejects.toThrow(/matching is binary/)
    })

    it('refuses an order whose outcome is not on the market', async () => {
        const tx = makeTx({ outcomes: [{ id: 'other-a' }, { id: 'other-b' }] })

        await expect(
            PredictionMatchingService.matchOrder(tx as any, takerRow(), SHARE_100),
        ).rejects.toThrow(/not on market/)
    })
})

describe('matchOrder — applying the fills', () => {
    beforeEach(() => vi.clearAllMocks())

    it('writes complementary fills, positions and market totals, and no wallet', async () => {
        const tx = makeTx({ resting: [makerRow()] })

        const result = await PredictionMatchingService.matchOrder(
            tx as any,
            takerRow(),
            SHARE_100,
        )

        expect(result.filledQuantity).toBe(2)

        const [fill] = tx.predictionFill.createMany.mock.calls[0][0].data
        expect(fill.makerPrice.toString()).toBe('65')
        expect(fill.takerPrice.toString()).toBe('35')
        expect(fill.makerOutcomeId).toBe('outcome-b')
        expect(fill.takerOutcomeId).toBe('outcome-a')
        expect(fill.quantity).toBe(2)

        // Escrow: 65 + 35 = 100 per share, 2 shares.
        const marketData = tx.predictionMarket.update.mock.calls[0][0].data
        expect(marketData.totalShares).toEqual({ increment: 2 })
        expect(marketData.totalVolume.increment.toString()).toBe('200')

        // Both sides' last price, complementary.
        const prices = tx.predictionOutcome.update.mock.calls.map((c: any[]) => [
            c[0].where.id,
            c[0].data.lastPrice.toString(),
        ])
        expect(prices).toEqual([
            ['outcome-a', '35'],
            ['outcome-b', '65'],
        ])

        // THE rule that makes one wallet lock safe: a maker's wallet is untouched.
        expect(tx.wallet.update).not.toHaveBeenCalled()
        expect(tx.wallet.findUnique).not.toHaveBeenCalled()
    })

    it('moves the maker s reserve into its position without paying it anything', async () => {
        // 65 x 2 reserved as 78 real / 52 bonus — a 60/40 mix.
        const tx = makeTx({ resting: [makerRow({ reservedReal: D(78), reservedBonus: D(52) })] })

        await PredictionMatchingService.matchOrder(
            tx as any,
            takerRow({ quantity: 1, reservedReal: D(40) }),
            SHARE_100,
        )

        // One share consumes 65 of the maker's reserve, in the same 60/40 mix.
        const orderUpdate = tx.predictionOrder.updateMany.mock.calls[0][0]
        expect(orderUpdate.data.filledQuantity).toBe(1)
        expect(orderUpdate.data.status).toBe('PARTIALLY_FILLED')
        expect(orderUpdate.data.reservedReal.toString()).toBe('39')
        expect(orderUpdate.data.reservedBonus.toString()).toBe('26')

        const makerPosition = tx.predictionPosition.upsert.mock.calls[0][0]
        expect(makerPosition.where.marketId_outcomeId_userId.outcomeId).toBe('outcome-b')
        expect(makerPosition.create.costBasisReal.toString()).toBe('39')
        expect(makerPosition.create.costBasisBonus.toString()).toBe('26')
        expect(makerPosition.create.costBasisReal.plus(makerPosition.create.costBasisBonus)
            .toString()).toBe('65')
    })

    it('folds several orders from one maker into a single position write', async () => {
        const tx = makeTx({
            resting: [
                makerRow({ id: 'm1', quantity: 1, reservedReal: D(65) }),
                makerRow({ id: 'm2', quantity: 1, reservedReal: D(65) }),
            ],
        })

        await PredictionMatchingService.matchOrder(tx as any, takerRow(), SHARE_100)

        // Two maker orders, one maker (bob) → two position upserts total: bob + alice.
        expect(tx.predictionPosition.upsert).toHaveBeenCalledTimes(2)
        const bob = tx.predictionPosition.upsert.mock.calls[0][0]
        expect(bob.create.shares).toBe(2)
        expect(bob.create.costBasisReal.toString()).toBe('130')
    })

    it('aborts when a resting order changed underneath the match', async () => {
        const tx = makeTx({ resting: [makerRow()] })
        tx.predictionOrder.updateMany.mockResolvedValue({ count: 0 })

        await expect(
            PredictionMatchingService.matchOrder(tx as any, takerRow(), SHARE_100),
        ).rejects.toThrow(/changed during matching/)
    })

    it('splits the taker s consumption bonus-proportionally and reports it', async () => {
        // Taker bids 40 x 2 = 80, held as 30 real / 50 bonus. It fills at 35, so it
        // consumes 70 — 43.75 bonus / 26.25 real — and 10 is improvement.
        const tx = makeTx({ resting: [makerRow()] })

        const result = await PredictionMatchingService.matchOrder(
            tx as any,
            takerRow({ reservedReal: D(30), reservedBonus: D(50) }),
            SHARE_100,
        )

        expect(result.takerConsumedReal.plus(result.takerConsumedBonus).toString()).toBe('70')
        expect(result.takerConsumedBonus.toString()).toBe('43.75')
        expect(result.takerConsumedReal.toString()).toBe('26.25')

        const takerUpdate = tx.predictionOrder.update.mock.calls[0][0]
        expect(takerUpdate.data.status).toBe('FILLED')
        expect(takerUpdate.data.reservedReal.toString()).toBe('3.75')
        expect(takerUpdate.data.reservedBonus.toString()).toBe('6.25')
    })

    it('works unchanged on a 50 ETB share', async () => {
        const tx = makeTx({
            resting: [makerRow({ limitPrice: D(30), quantity: 2, reservedReal: D(60) })],
        })

        await PredictionMatchingService.matchOrder(
            tx as any,
            takerRow({ limitPrice: D(25), quantity: 2, reservedReal: D(50) }),
            SHARE_50,
        )

        const [fill] = tx.predictionFill.createMany.mock.calls[0][0].data
        expect(fill.makerPrice.toString()).toBe('30')
        expect(fill.takerPrice.toString()).toBe('20')
        expect(tx.predictionMarket.update.mock.calls[0][0].data.totalVolume.increment.toString())
            .toBe('100')
    })
})
