import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'

// Regression for the 2026-10-22 chicken-road replay on Winner: one 50 ETB bet on
// round 107051 was followed by 2,844 distinct win callbacks of 77.50 each
// (220,410 ETB). Every one passed the per-win caps; nothing bounded what the
// round had paid in total.

vi.mock('../lib/prisma.js', () => ({
    default: {
        gameProvider: { findUnique: vi.fn() },
        wallet: { findUnique: vi.fn(), update: vi.fn() },
        thirdPartyTransaction: { findUnique: vi.fn(), create: vi.fn(), aggregate: vi.fn() },
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
vi.mock('../services/account-status.service.js', () => ({ AccountStatusService: { restrict: vi.fn() } }))
const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../lib/log-context.js', () => ({ getLogger: () => logger }))
vi.mock('../lib/posthog-events.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/posthog-events.js')>()
    return { ...actual, emitProviderBet: vi.fn(), emitProviderWin: vi.fn() }
})

import prisma from '../lib/prisma.js'
import { AccountStatusService } from '../services/account-status.service.js'
const p = prisma as any
const restrict = AccountStatusService.restrict as ReturnType<typeof vi.fn>

/** A locked-wallet transaction whose round has already paid `wins` callbacks totalling `won`. */
function walletTx(realBalance: string, prior: { wins: number; won: string | null }) {
    return {
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance, bonusBalance: '0.00', spendAccount: 'REAL' }]),
        wallet: { update: vi.fn() },
        thirdPartyTransaction: {
            create: vi.fn(),
            findUnique: vi.fn(),
            update: vi.fn(),
            aggregate: vi.fn().mockResolvedValue({ _sum: { winAmount: prior.won }, _count: prior.wins }),
        },
        transaction: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    }
}

const WIN = {
    trans_guid: 'win-replay',
    account: 'alice',
    gplay_id: 'p1',
    round_id: '107051',
    game_code: 'chicken-road',
    amount: 77.5,
    type: 2,
}

describe('PalaceWalletService per-round cumulative win cap', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        // One 50 ETB bet recorded on the round.
        p.thirdPartyTransaction.aggregate.mockResolvedValue({ _sum: { betAmount: '50.00' }, _count: 1 })
    })

    it('credits a win while the round is inside both caps', async () => {
        const tx = walletTx('100.00', { wins: 20, won: '1550.00' })
        p.$transaction.mockImplementation((cb: any) => cb(tx))
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        const res = await PalaceWalletService.processWin(WIN)

        expect(res.result).toBe(0)
        expect((tx.wallet.update.mock.calls[0][0].data.realBalance as Decimal).toNumber()).toBe(177.5)
        expect(tx.thirdPartyTransaction.aggregate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ userId: 'uid1', roundId: '107051', type: 'BET_RESULT' }),
            }),
        )
        expect(restrict).not.toHaveBeenCalled()
    })

    it('refuses the win that would exceed the per-round win count, and restricts the account', async () => {
        const tx = walletTx('100.00', { wins: 200, won: '15500.00' })
        p.$transaction.mockImplementation((cb: any) => cb(tx))
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        const res = await PalaceWalletService.processWin(WIN)

        expect(res).toEqual({ result: 42, status: 'TRANS_ID_NOT_FOUND', data: null })
        expect(tx.wallet.update).not.toHaveBeenCalled()
        expect(tx.thirdPartyTransaction.create).not.toHaveBeenCalled()
        expect(tx.transaction.create).not.toHaveBeenCalled()
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ component: 'palace-fraud-flag', overRoundCount: true, roundWins: 200 }),
            expect.any(String),
        )
        expect(restrict).toHaveBeenCalledWith('uid1', expect.objectContaining({ reason: expect.stringContaining('107051') }))
    })

    it('refuses the win that would take the round past its stake multiple, and restricts the account', async () => {
        // 50 ETB stake x 2,000 = 100,000 ETB ceiling; 99,950 already paid + 77.50 crosses it.
        const tx = walletTx('100.00', { wins: 3, won: '99950.00' })
        p.$transaction.mockImplementation((cb: any) => cb(tx))
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        const res = await PalaceWalletService.processWin(WIN)

        expect(res).toEqual({ result: 42, status: 'TRANS_ID_NOT_FOUND', data: null })
        expect(tx.wallet.update).not.toHaveBeenCalled()
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ component: 'palace-fraud-flag', overRoundTotal: true }),
            expect.any(String),
        )
        expect(restrict).toHaveBeenCalledTimes(1)
    })

    it('does not downgrade an account that is already SUSPENDED when the cap trips', async () => {
        // resolveUser's view (possibly a cached one) still says ACTIVE; the database says SUSPENDED.
        p.user.findUnique
            .mockResolvedValueOnce({ id: 'uid1', accountStatus: 'ACTIVE' })
            .mockResolvedValue({ accountStatus: 'SUSPENDED' })
        const tx = walletTx('100.00', { wins: 200, won: '15500.00' })
        p.$transaction.mockImplementation((cb: any) => cb(tx))
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        const res = await PalaceWalletService.processWin(WIN)

        expect(res.result).toBe(42)
        expect(restrict).not.toHaveBeenCalled()
    })
})
