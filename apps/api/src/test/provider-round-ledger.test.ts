import { describe, it, expect, beforeEach } from 'vitest'
import { prisma } from './setup'
import {
    withReadOnlyLedger,
    fetchGameLedgerRows,
    fetchRoundLedgerRows,
    fetchLedgerIntegrity,
    fetchPalaceUserMap,
} from '../lib/provider-round-ledger'

const IN_WINDOW = new Date('2026-09-10T12:00:00.000Z')
const WINDOW = { provider: 'palace', since: new Date('2026-09-10T00:00:00.000Z'), until: new Date('2026-09-11T00:00:00.000Z') }

let providerId: string
let otherProviderId: string
let u1: string
let u2: string
let seq = 0

async function tpt(o: {
    userId: string
    gameCode: string
    roundId: string
    type: 'BET' | 'BET_RESULT' | 'ROLLBACK'
    status?: 'COMPLETED' | 'ROLLED_BACK' | 'FAILED'
    betAmount?: number
    winAmount?: number
    amount?: number
    createdAt?: Date
    providerOverride?: string
}): Promise<string> {
    const transactionId = `ledger-tx-${++seq}`
    await prisma.thirdPartyTransaction.create({
        data: {
            providerId: o.providerOverride ?? providerId,
            userId: o.userId,
            transactionId,
            roundId: o.roundId,
            gameCode: o.gameCode,
            type: o.type,
            status: o.status ?? 'COMPLETED',
            betAmount: o.betAmount,
            winAmount: o.winAmount,
            amount: o.amount ?? o.winAmount ?? -(o.betAmount ?? 0),
            balanceBefore: 0,
            balanceAfter: 0,
            createdAt: o.createdAt ?? IN_WINDOW,
        },
    })
    return transactionId
}

async function booked(userId: string, type: 'TP_BET' | 'TP_WIN', referenceId: string, amount: number) {
    await prisma.transaction.create({ data: { userId, type, amount, status: 'APPROVED', referenceId, createdAt: IN_WINDOW } })
}

beforeEach(async () => {
    await prisma.gameProvider.deleteMany({ where: { code: { in: ['palace', 'ledger-other'] } } })
    providerId = (await prisma.gameProvider.create({ data: { code: 'palace', name: 'Palace', apiBaseUrl: 'https://palace.test' } })).id
    otherProviderId = (await prisma.gameProvider.create({ data: { code: 'ledger-other', name: 'Other', apiBaseUrl: 'https://other.test' } })).id
    u1 = (await prisma.user.create({ data: { username: 'ledger-u1', phone: '+251900000801', passwordHash: 'x' } })).id
    u2 = (await prisma.user.create({ data: { username: 'ledger-u2', phone: '+251900000802', passwordHash: 'x' } })).id

    const r1Bet = await tpt({ userId: u1, gameCode: 'aviator', roundId: 'r1', type: 'BET', betAmount: 100 })
    const r1Win = await tpt({ userId: u1, gameCode: 'aviator', roundId: 'r1', type: 'BET_RESULT', winAmount: 150 })
    await tpt({ userId: u1, gameCode: 'aviator', roundId: 'r2', type: 'BET', betAmount: 50 }) // no Transaction row
    const r2Win = await tpt({ userId: u1, gameCode: 'aviator', roundId: 'r2', type: 'BET_RESULT', winAmount: 0 })
    const r3Bet = await tpt({ userId: u2, gameCode: 'aviator', roundId: 'r3', type: 'BET', betAmount: 200 })
    const r4Bet = await tpt({ userId: u2, gameCode: 'aviator', roundId: 'r4', type: 'BET', status: 'ROLLED_BACK', betAmount: 30 })
    await tpt({ userId: u2, gameCode: 'aviator', roundId: 'r4', type: 'ROLLBACK', amount: 30 })
    await tpt({ userId: u2, gameCode: 'aviator', roundId: 'r5', type: 'BET', status: 'FAILED', betAmount: 10, amount: 0 })
    const cBet = await tpt({ userId: u1, gameCode: 'chicken-road', roundId: 'c1', type: 'BET', betAmount: 20 })
    const cWin = await tpt({ userId: u1, gameCode: 'chicken-road', roundId: 'c1', type: 'BET_RESULT', winAmount: 22 })
    await tpt({ userId: u1, gameCode: 'aviator', roundId: 'old', type: 'BET', betAmount: 999, createdAt: new Date('2026-09-01T00:00:00.000Z') })
    await tpt({ userId: u1, gameCode: 'aviator', roundId: 'o1', type: 'BET', betAmount: 777, providerOverride: otherProviderId })

    await booked(u1, 'TP_BET', r1Bet, 100)
    await booked(u1, 'TP_WIN', r1Win, 150)
    await booked(u1, 'TP_WIN', r2Win, 5) // books 5 against a 0 win
    await booked(u2, 'TP_BET', r3Bet, 200)
    await booked(u2, 'TP_BET', r4Bet, 30)
    await booked(u1, 'TP_BET', cBet, 20)
    await booked(u1, 'TP_WIN', cWin, 22)

    await prisma.providerUserAccount.create({ data: { providerId, userId: u1, externalUserCode: '9001' } })
})

describe('provider-round-ledger', () => {
    it('totals each game inside the window for the provider only', async () => {
        const rows = await withReadOnlyLedger(prisma, (db) => fetchGameLedgerRows(db, WINDOW))
        expect(rows).toHaveLength(2)
        const aviator = rows.find((r) => r.gameCode === 'aviator')!
        expect({
            ...aviator,
            wagered: Number(aviator.wagered),
            rolledBackStake: Number(aviator.rolledBackStake),
            paid: Number(aviator.paid),
            refunded: Number(aviator.refunded),
        }).toEqual({
            gameCode: 'aviator',
            bets: 3,
            wagered: 350,
            rolledBackBets: 1,
            rolledBackStake: 30,
            failedBets: 1,
            wins: 2,
            nonzeroWins: 1,
            paid: 150,
            refunded: 30,
        })
        const chicken = rows.find((r) => r.gameCode === 'chicken-road')!
        expect([chicken.bets, Number(chicken.wagered), Number(chicken.paid)]).toEqual([1, 20, 22])
    })

    it('returns one row per player-round for one game', async () => {
        const rows = await withReadOnlyLedger(prisma, (db) => fetchRoundLedgerRows(db, WINDOW, 'aviator'))
        const byRound = Object.fromEntries(rows.map((r) => [r.roundId, r]))
        expect(Object.keys(byRound).sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5'])
        expect([byRound.r1.bets, Number(byRound.r1.wagered), byRound.r1.wins, Number(byRound.r1.paid)]).toEqual([1, 100, 1, 150])
        expect([byRound.r4.bets, byRound.r4.rolledBackBets, Number(byRound.r4.rolledBackStake)]).toEqual([0, 1, 30])
        expect(byRound.r3.userId).toBe(u2)
    })

    it('counts ledger rows with a missing or different Transaction row', async () => {
        const rows = await withReadOnlyLedger(prisma, (db) => fetchLedgerIntegrity(db, WINDOW, 'aviator'))
        expect(rows.sort((a, b) => a.type.localeCompare(b.type))).toEqual([
            { type: 'BET', missing: 1, amountMismatch: 0 },
            { type: 'BET_RESULT', missing: 0, amountMismatch: 1 },
        ])
    })

    it('maps Palace user codes to users', async () => {
        const rows = await withReadOnlyLedger(prisma, (db) => fetchPalaceUserMap(db, 'palace'))
        expect(rows).toEqual([{ externalUserCode: '9001', userId: u1 }])
    })

    it('refuses to write inside the read-only transaction', async () => {
        await expect(
            withReadOnlyLedger(prisma, (db) => db.$executeRawUnsafe(`UPDATE game_providers SET name = 'changed' WHERE code = 'palace'`)),
        ).rejects.toThrow(/read-only transaction/)
        expect((await prisma.gameProvider.findUniqueOrThrow({ where: { code: 'palace' } })).name).toBe('Palace')
    })
})
