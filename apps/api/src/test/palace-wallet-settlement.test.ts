import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'

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
const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../lib/log-context.js', () => ({ getLogger: () => logger }))
vi.mock('../lib/posthog-events.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/posthog-events.js')>()
    return { ...actual, emitProviderBet: vi.fn(), emitProviderWin: vi.fn() }
})

import prisma from '../lib/prisma.js'
const p = prisma as any

function walletTx(realBalance: string) {
    return {
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance, bonusBalance: '0.00', spendAccount: 'REAL' }]),
        wallet: { update: vi.fn() },
        thirdPartyTransaction: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
        transaction: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
    }
}

const WIN = { trans_guid: 'win-1', account: 'alice', gplay_id: 'p1', round_id: 'r1', game_code: 'aviator', amount: 25, type: 2 }
const CANCEL = { trans_guid: 'cancel-1', account: 'alice', gplay_id: 'p1', round_id: 'r1', game_code: 'aviator', amount: 20, cancle_trans_guid: 'bet-1' }
const BET_ROW = { id: 'bet-row', userId: 'uid1', transactionId: 'bet-1', type: 'BET', status: 'COMPLETED', betAmount: '20.00', amount: '-20.00' }

describe('PalaceWalletService settlement for non-ACTIVE accounts', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'SUSPENDED' })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '100.00', bonusBalance: '0.00', spendAccount: 'REAL' })
    })

    it('credits a SUSPENDED player win when the round has a recorded bet', async () => {
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        p.thirdPartyTransaction.aggregate.mockResolvedValue({ _sum: { betAmount: '10.00' }, _count: 1 })
        const tx = walletTx('100.00')
        p.$transaction.mockImplementation((cb: any) => cb(tx))
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        const res = await PalaceWalletService.processWin(WIN)

        expect(res.result).toBe(0)
        expect((tx.wallet.update.mock.calls[0][0].data.realBalance as Decimal).toNumber()).toBe(125)
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ component: 'palace-settlement', accountStatus: 'SUSPENDED' }),
            expect.any(String),
        )
    })

    it('still refuses a SUSPENDED player win when the round has no recorded bet', async () => {
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        p.thirdPartyTransaction.aggregate.mockResolvedValue({ _sum: { betAmount: null }, _count: 0 })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        const res = await PalaceWalletService.processWin(WIN)

        expect(res).toEqual({ result: 22, status: 'USER_INACTIVE', data: null })
        expect(p.$transaction).not.toHaveBeenCalled()
    })

    it('refunds a SUSPENDED player recorded bet on cancel', async () => {
        p.thirdPartyTransaction.findUnique
            .mockResolvedValueOnce(null) // no row yet for the cancel's own trans_guid
            .mockResolvedValueOnce(BET_ROW) // pre-check: the original bet is refundable
        const tx = walletTx('100.00')
        tx.thirdPartyTransaction.findUnique.mockResolvedValue(BET_ROW)
        p.$transaction.mockImplementation((cb: any) => cb(tx))
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        const res = await PalaceWalletService.processCancel(CANCEL)

        expect(res.result).toBe(0)
        expect((tx.wallet.update.mock.calls[0][0].data.realBalance as Decimal).toNumber()).toBe(120)
        expect(tx.thirdPartyTransaction.update).toHaveBeenCalledWith({ where: { id: 'bet-row' }, data: { status: 'ROLLED_BACK' } })
    })

    it('still refuses a SUSPENDED player cancel when there is no refundable bet', async () => {
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        const res = await PalaceWalletService.processCancel(CANCEL)

        expect(res).toEqual({ result: 22, status: 'USER_INACTIVE', data: null })
        expect(p.$transaction).not.toHaveBeenCalled()
    })
})

describe('PalaceWalletService trans_guid replays', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '100.00', bonusBalance: '0.00', spendAccount: 'REAL' })
    })

    it('flags a win whose trans_guid is already booked as a BET, without crediting', async () => {
        p.thirdPartyTransaction.findUnique.mockResolvedValue({ ...BET_ROW, transactionId: 'win-1' })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        const res = await PalaceWalletService.processWin(WIN)

        expect(res).toEqual({ result: 0, status: 'OK', data: { balance: 100 } })
        expect(p.$transaction).not.toHaveBeenCalled()
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ component: 'palace-idempotency-mismatch', command: 'win', existingType: 'BET', transGuid: 'win-1' }),
            expect.any(String),
        )
    })

    it('does not flag a genuine win replay', async () => {
        p.thirdPartyTransaction.findUnique.mockResolvedValue({ id: 'w', transactionId: 'win-1', type: 'BET_RESULT', status: 'COMPLETED' })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        await PalaceWalletService.processWin(WIN)

        expect(logger.error).not.toHaveBeenCalled()
    })

    it('flags a bet whose trans_guid is already booked as a win', async () => {
        p.thirdPartyTransaction.findUnique.mockResolvedValue({ id: 'w', transactionId: 'bet-1', type: 'BET_RESULT', status: 'COMPLETED' })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        await PalaceWalletService.processBet({ trans_guid: 'bet-1', account: 'alice', gplay_id: 'p1', round_id: 'r1', game_code: 'aviator', amount: 20 })

        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ component: 'palace-idempotency-mismatch', command: 'bet', existingType: 'BET_RESULT' }),
            expect.any(String),
        )
    })
})
