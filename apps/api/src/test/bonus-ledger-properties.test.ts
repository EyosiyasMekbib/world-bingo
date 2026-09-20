/**
 * Property coverage for the bonus ledger, as opposed to the example coverage the
 * rest of the suite provides.
 *
 * The hand-written tests each pin one sequence somebody thought of. The
 * invariant they all lean on — `wallet.bonusBalance` equals the sum of ACTIVE
 * lot remainders — has to survive sequences nobody thought of, because that is
 * what production is. So this drives a long random mix of grants, spends,
 * clamped reductions, refund restores and expiry sweeps at one wallet and
 * re-checks the ledger after EVERY step, which is what makes a failure
 * bisectable: the step that broke it is named rather than inferred.
 *
 * Seeded and deterministic. A failure reproduces exactly, and the seed is in the
 * message. Not a substitute for the example tests: it proves the ledger cannot
 * drift, not that any particular rule is right.
 */
import { describe, it, expect } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { prisma } from './setup'
import { BonusService, InsufficientBonusBalanceError } from '../services/bonus.service'

/** mulberry32 — a small deterministic PRNG, so a failing run is reproducible. */
function rng(seed: number) {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const SOURCES = ['FIRST_DEPOSIT', 'DAILY_DEPOSIT', 'CASHBACK', 'CAMPAIGN', 'ADMIN'] as const

let userSeq = 0
async function makeWallet() {
    userSeq += 1
    const user = await prisma.user.create({
        data: {
            username: `ledgerprop_${Date.now()}_${userSeq}`,
            phone: `+2519111${String(30000 + userSeq).padStart(5, '0')}`,
            passwordHash: 'x',
            role: 'PLAYER',
            wallet: { create: { bonusBalance: 0, realBalance: 0 } },
        },
    })
    return user.id
}

/** The invariant, read fresh: wallet balance vs the lots that justify it. */
async function ledgerState(userId: string) {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } })
    const lots = await prisma.bonusGrant.findMany({ where: { userId } })
    const activeSum = lots
        .filter((l) => l.status === 'ACTIVE')
        .reduce((sum, l) => sum.plus(new Decimal(l.remaining)), new Decimal(0))
    return { balance: new Decimal(wallet.bonusBalance), activeSum, lots }
}

async function expectLedgerSound(userId: string, where: string) {
    const { balance, activeSum, lots } = await ledgerState(userId)

    expect(balance.toFixed(2), `${where}: wallet vs active lots`).toBe(activeSum.toFixed(2))
    expect(balance.isNegative(), `${where}: wallet went negative`).toBe(false)

    for (const lot of lots) {
        const remaining = new Decimal(lot.remaining)
        expect(remaining.isNegative(), `${where}: lot ${lot.id} remaining negative`).toBe(false)
        // A lot may never hand back more than it was granted, however it was
        // spent, refunded or reduced along the way.
        expect(
            remaining.lte(new Decimal(lot.amount)),
            `${where}: lot ${lot.id} remaining ${remaining} exceeds granted ${lot.amount}`,
        ).toBe(true)
        // Status and remainder have to agree, or a drained lot keeps getting
        // picked as a spend candidate and a live one is skipped.
        if (lot.status === 'ACTIVE') {
            expect(remaining.gt(0), `${where}: ACTIVE lot ${lot.id} has nothing left`).toBe(true)
        } else {
            expect(remaining.toFixed(2), `${where}: closed lot ${lot.id} still holds value`).toBe('0.00')
        }
    }
}

describe('bonus ledger — invariants hold across random operation sequences', () => {
    // Several seeds, so one unlucky path is not the whole guarantee.
    for (const seed of [1, 7, 42, 1337]) {
        it(`survives 60 mixed operations (seed ${seed})`, async () => {
            const rand = rng(seed)
            const userId = await makeWallet()
            const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]
            // Two decimal places, which is what the lot column holds.
            const money = () => Math.round((rand() * 200 + 0.01) * 100) / 100

            for (let step = 0; step < 60; step++) {
                const op = pick(['grant', 'grant', 'spend', 'reduce', 'restore', 'expire'] as const)
                const where = `seed ${seed} step ${step} (${op})`

                try {
                    await prisma.$transaction(async (tx) => {
                        // Every caller must hold the wallet lock first — that is the
                        // contract these methods document, and taking it here is part
                        // of what is under test.
                        await tx.$queryRaw`SELECT "bonusBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE`

                        if (op === 'grant') {
                            // A mix of expiring and never-expiring lots, some already
                            // past due so the sweep has something to find.
                            const offset = pick([-3600_000, 3600_000, 7 * 86_400_000, null])
                            await BonusService.grant(tx, {
                                userId,
                                amount: money(),
                                source: pick(SOURCES),
                                expiresAt: offset === null ? null : new Date(Date.now() + offset),
                            })
                        } else if (op === 'spend') {
                            await BonusService.spend(tx, userId, money())
                        } else if (op === 'reduce') {
                            await BonusService.reduce(tx, userId, money())
                        } else if (op === 'restore') {
                            await BonusService.restore(tx, userId, money(), pick([null, new Date(Date.now() + 86_400_000)]))
                        } else {
                            await BonusService.expireForUser(tx, userId, new Date())
                        }
                    })
                } catch (err) {
                    // Only ONE refusal is legitimate here: spending more bonus than
                    // the player holds. Anything else is a real failure, and the
                    // ledger must still be sound after a rolled-back attempt.
                    if (!(err instanceof InsufficientBonusBalanceError)) {
                        await expectLedgerSound(userId, `${where} after unexpected error`)
                        throw new Error(`${where}: unexpected ${(err as Error).name}: ${(err as Error).message}`)
                    }
                }

                await expectLedgerSound(userId, where)
            }

            // The sequence has to have actually exercised something.
            const { lots } = await ledgerState(userId)
            expect(lots.length).toBeGreaterThan(0)
        })
    }

    it('never lets a spend take more than the wallet holds, however many lots back it', async () => {
        const rand = rng(99)
        const userId = await makeWallet()

        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "bonusBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE`
            for (let i = 0; i < 6; i++) {
                await BonusService.grant(tx, {
                    userId,
                    amount: Math.round((rand() * 50 + 1) * 100) / 100,
                    source: 'CASHBACK',
                    expiresAt: new Date(Date.now() + (i + 1) * 3600_000),
                })
            }
        })

        const { balance: held } = await ledgerState(userId)

        // Ask for a hair more than exists. It must refuse outright rather than
        // partially drain the lots — a partial spend would leave the player
        // charged for an entry they never got.
        await expect(
            prisma.$transaction(async (tx) => {
                await tx.$queryRaw`SELECT "bonusBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE`
                return BonusService.spend(tx, userId, held.plus('0.01'))
            }),
        ).rejects.toThrow(InsufficientBonusBalanceError)

        const after = await ledgerState(userId)
        expect(after.balance.toFixed(2)).toBe(held.toFixed(2))
        await expectLedgerSound(userId, 'after a refused over-spend')

        // And the exact balance must still be spendable to the last cent.
        await prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT "bonusBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE`
            return BonusService.spend(tx, userId, held)
        })
        const drained = await ledgerState(userId)
        expect(drained.balance.toFixed(2)).toBe('0.00')
        expect(drained.lots.every((l) => l.status !== 'ACTIVE')).toBe(true)
        await expectLedgerSound(userId, 'after draining to zero')
    })
})
