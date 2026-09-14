import { describe, it, expect, vi, beforeAll } from 'vitest'

// Redis is not running in this environment. `resolveUser` reads/writes a
// cache key through it; mock it the same way the existing (mocked) Palace
// test files do so every lookup falls through to the real DB below.
vi.mock('../lib/redis.js', () => ({ default: { get: vi.fn().mockResolvedValue(null), setex: vi.fn() } }))

import { prisma } from './setup'
import { PalaceWalletService } from '../services/palace-wallet.service.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────
// `setup.ts`'s afterEach wipes users/wallets/thirdPartyTransactions/
// transactions after every test, but NOT gameProviders — so the `palace`
// provider row is created once here and reused; each test builds its own
// fresh user(s)/bet(s) against it.

let seq = 0
function uniq(prefix: string): string {
    seq += 1
    return `${prefix}-${seq}`
}

async function createUser(prefix: string, accountStatus: 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED', realBalance: number) {
    const tag = uniq(prefix)
    const user = await prisma.user.create({
        data: {
            username: `pws-${tag}`,
            phone: `+2519${String(10_000_000 + seq)}`,
            passwordHash: 'x',
            accountStatus,
            wallet: { create: { realBalance } },
        },
    })
    return { id: user.id, username: `pws-${tag}` }
}

async function walletOf(userId: string) {
    return prisma.wallet.findUniqueOrThrow({ where: { userId } })
}

/**
 * Places a real BET through the service while the account is still ACTIVE
 * (processBet refuses non-ACTIVE outright), then flips accountStatus —
 * simulating a player restricted mid-round with a real recorded stake still
 * on the books, which is exactly the scenario A4 fixes settlement for.
 */
async function placeBetThenSetStatus(
    status: 'RESTRICTED' | 'SUSPENDED',
    opts: { prefix?: string; realBalance?: number; betAmount?: number; gameCode?: string } = {},
) {
    const { prefix = 'player', realBalance = 1000, betAmount = 50, gameCode = 'aviator' } = opts
    const { id: userId, username } = await createUser(prefix, 'ACTIVE', realBalance)
    const roundId = uniq('round')
    const betGuid = uniq('bet')

    const betRes = await PalaceWalletService.processBet({
        trans_guid: betGuid,
        account: username,
        gplay_id: 'g1',
        round_id: roundId,
        game_code: gameCode,
        amount: betAmount,
    })
    expect(betRes.result).toBe(0)

    await prisma.user.update({ where: { id: userId }, data: { accountStatus: status } })
    return { userId, username, roundId, betGuid, betAmount, gameCode }
}

beforeAll(async () => {
    await prisma.gameProvider.upsert({
        where: { code: 'palace' },
        update: {},
        create: { code: 'palace', name: 'Palace', apiBaseUrl: 'https://palace.test' },
    })
})

describe.each(['RESTRICTED', 'SUSPENDED'] as const)('PalaceWalletService settlement for %s accounts (real DB)', (status) => {
    it('credits a win against the recorded bet, writing BET_RESULT and TP_WIN rows with correct balances', async () => {
        const { userId, username, roundId, gameCode } = await placeBetThenSetStatus(status, { realBalance: 1000, betAmount: 50 })
        const afterBet = await walletOf(userId)
        expect(afterBet.realBalance.toNumber()).toBe(950)

        const winGuid = uniq('win')
        const res = await PalaceWalletService.processWin({
            trans_guid: winGuid,
            account: username,
            gplay_id: 'g1',
            round_id: roundId,
            game_code: gameCode,
            amount: 125,
            type: 2,
        })

        expect(res.result).toBe(0)
        const afterWin = await walletOf(userId)
        expect(afterWin.realBalance.toNumber()).toBe(1075) // 950 + 125

        const winRow = await prisma.thirdPartyTransaction.findFirst({ where: { transactionId: winGuid } })
        expect(winRow).toMatchObject({ userId, type: 'BET_RESULT', status: 'COMPLETED' })
        expect(winRow!.balanceBefore.toNumber()).toBe(950)
        expect(winRow!.balanceAfter.toNumber()).toBe(1075)

        const txnRow = await prisma.transaction.findFirst({ where: { referenceId: winGuid, type: 'TP_WIN' } })
        expect(txnRow).toBeTruthy()
        expect(txnRow!.userId).toBe(userId)
        expect(txnRow!.balanceBefore!.toNumber()).toBe(950)
        expect(txnRow!.balanceAfter!.toNumber()).toBe(1075)
    })

    it('refunds the callers own COMPLETED bet once, writing ROLLBACK and TP_ROLLBACK rows', async () => {
        const { userId, username, roundId, betGuid, betAmount, gameCode } = await placeBetThenSetStatus(status, {
            realBalance: 1000,
            betAmount: 40,
        })
        const afterBet = await walletOf(userId)
        expect(afterBet.realBalance.toNumber()).toBe(960)

        const cancelGuid = uniq('cancel')
        const res = await PalaceWalletService.processCancel({
            trans_guid: cancelGuid,
            account: username,
            gplay_id: 'g1',
            round_id: roundId,
            game_code: gameCode,
            amount: betAmount,
            cancle_trans_guid: betGuid,
        })

        expect(res.result).toBe(0)
        const afterCancel = await walletOf(userId)
        expect(afterCancel.realBalance.toNumber()).toBe(1000) // fully refunded

        const rollbackRow = await prisma.thirdPartyTransaction.findFirst({ where: { transactionId: cancelGuid } })
        expect(rollbackRow).toMatchObject({ userId, type: 'ROLLBACK', status: 'COMPLETED' })
        expect(rollbackRow!.amount.toNumber()).toBe(40)

        const txnRow = await prisma.transaction.findFirst({ where: { referenceId: cancelGuid, type: 'TP_ROLLBACK' } })
        expect(txnRow).toBeTruthy()
        expect(txnRow!.balanceBefore!.toNumber()).toBe(960)
        expect(txnRow!.balanceAfter!.toNumber()).toBe(1000)

        const originalBet = await prisma.thirdPartyTransaction.findFirst({ where: { transactionId: betGuid } })
        expect(originalBet!.status).toBe('ROLLED_BACK')
    })

    it('replaying the same win trans_guid credits once in total', async () => {
        const { userId, username, roundId, gameCode } = await placeBetThenSetStatus(status, { realBalance: 1000, betAmount: 50 })

        const winGuid = uniq('win')
        const winParams = {
            trans_guid: winGuid,
            account: username,
            gplay_id: 'g1',
            round_id: roundId,
            game_code: gameCode,
            amount: 30,
            type: 2,
        }

        const first = await PalaceWalletService.processWin(winParams)
        expect(first.result).toBe(0)
        const afterFirst = await walletOf(userId)
        expect(afterFirst.realBalance.toNumber()).toBe(980) // 950 + 30

        const second = await PalaceWalletService.processWin(winParams)
        expect(second.result).toBe(0)
        const afterSecond = await walletOf(userId)
        expect(afterSecond.realBalance.toNumber()).toBe(980) // unchanged — replay, not a second credit

        const rows = await prisma.thirdPartyTransaction.findMany({ where: { transactionId: winGuid } })
        expect(rows).toHaveLength(1)
    })

    it('a win with no recorded bet credits nothing and writes no rows', async () => {
        const { id: userId, username } = await createUser('nobet', status, 1000)
        const roundId = uniq('round')
        const winGuid = uniq('win')

        const res = await PalaceWalletService.processWin({
            trans_guid: winGuid,
            account: username,
            gplay_id: 'g1',
            round_id: roundId,
            game_code: 'aviator',
            amount: 500,
            type: 2,
        })

        expect(res).toEqual({ result: 22, status: 'USER_INACTIVE', data: null })
        const wallet = await walletOf(userId)
        expect(wallet.realBalance.toNumber()).toBe(1000)
        const rows = await prisma.thirdPartyTransaction.findMany({ where: { transactionId: winGuid } })
        expect(rows).toHaveLength(0)
    })

    it('a cancel naming a bet owned by a different user credits nothing and leaves that bet COMPLETED', async () => {
        const owner = await createUser('owner', 'ACTIVE', 1000)
        const roundId = uniq('round')
        const betGuid = uniq('bet')
        const ownerBetRes = await PalaceWalletService.processBet({
            trans_guid: betGuid,
            account: owner.username,
            gplay_id: 'g1',
            round_id: roundId,
            game_code: 'aviator',
            amount: 60,
        })
        expect(ownerBetRes.result).toBe(0)

        const { id: actorId, username: actorUsername } = await createUser('actor', status, 1000)

        const cancelGuid = uniq('cancel')
        const res = await PalaceWalletService.processCancel({
            trans_guid: cancelGuid,
            account: actorUsername,
            gplay_id: 'g1',
            round_id: roundId,
            game_code: 'aviator',
            amount: 60,
            cancle_trans_guid: betGuid,
        })

        // This is the R1 bug: an unowned bet must never be refunded into the
        // caller's wallet, and the real owner's bet must be left untouched.
        expect(res).toEqual({ result: 22, status: 'USER_INACTIVE', data: null })

        const actorWallet = await walletOf(actorId)
        expect(actorWallet.realBalance.toNumber()).toBe(1000) // unchanged

        const ownerBet = await prisma.thirdPartyTransaction.findFirst({ where: { transactionId: betGuid } })
        expect(ownerBet!.status).toBe('COMPLETED') // never rolled back

        const rollbackRow = await prisma.thirdPartyTransaction.findFirst({ where: { transactionId: cancelGuid } })
        expect(rollbackRow).toBeNull() // the transaction was never opened
    })
})

describe('PalaceWalletService cancel ownership guard (real DB, ACTIVE account)', () => {
    // The ownership check lives in the SAME shared helper the non-ACTIVE gate
    // above uses, so an ACTIVE account naming someone else's bet must be
    // caught too — it was not before this fix.
    it('an ACTIVE account cancel naming a bet owned by a different user credits nothing and leaves that bet COMPLETED', async () => {
        const owner = await createUser('owner2', 'ACTIVE', 1000)
        const roundId = uniq('round')
        const betGuid = uniq('bet')
        const ownerBetRes = await PalaceWalletService.processBet({
            trans_guid: betGuid,
            account: owner.username,
            gplay_id: 'g1',
            round_id: roundId,
            game_code: 'aviator',
            amount: 70,
        })
        expect(ownerBetRes.result).toBe(0)

        const { id: actorId, username: actorUsername } = await createUser('actor2', 'ACTIVE', 1000)

        const cancelGuid = uniq('cancel')
        const res = await PalaceWalletService.processCancel({
            trans_guid: cancelGuid,
            account: actorUsername,
            gplay_id: 'g1',
            round_id: roundId,
            game_code: 'aviator',
            amount: 70,
            cancle_trans_guid: betGuid,
        })

        // ACTIVE accounts are never rejected outright by the R5 fallback path —
        // but must credit nothing and must not touch the other user's bet.
        expect(res.result).toBe(0)
        const actorWallet = await walletOf(actorId)
        expect(actorWallet.realBalance.toNumber()).toBe(1000) // unchanged

        const ownerBet = await prisma.thirdPartyTransaction.findFirst({ where: { transactionId: betGuid } })
        expect(ownerBet!.status).toBe('COMPLETED') // never rolled back
    })
})
