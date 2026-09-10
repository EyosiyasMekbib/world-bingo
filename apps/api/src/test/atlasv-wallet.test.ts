import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('../lib/prisma.js', () => ({
    default: {
        gameProvider: { findUnique: vi.fn() },
        wallet: { findUnique: vi.fn(), update: vi.fn() },
        thirdPartyTransaction: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
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

import prisma from '../lib/prisma.js'
import { BonusService } from '../services/bonus.service.js'
const p = prisma as any

const PLAYER_ID = 'a'.repeat(32)

describe('AtlasVWalletService', () => {
    beforeEach(() => vi.clearAllMocks())

    it('getAccount returns balance for an active user', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '100.00', bonusBalance: '0', spendAccount: 'REAL' })
        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.getAccount({ player_id: PLAYER_ID })
        expect(res).toEqual({ player_id: PLAYER_ID, balance: 100 })
    })

    it('getAccount fails for an unknown user', async () => {
        p.user.findUnique.mockResolvedValue(null)
        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.getAccount({ player_id: PLAYER_ID })
        expect(res).toEqual({ success: false })
    })

    it('processBet debits the wallet and records a BET ledger row', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '100.00', bonusBalance: '0', spendAccount: 'REAL' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: { create: vi.fn() },
            transaction: { create: vi.fn() },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processBet({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', transaction_id: 't1', amount: 10,
        })

        expect(res).toEqual({ player_id: PLAYER_ID, balance: 90 })
        expect(fakeTx.wallet.update).toHaveBeenCalledWith({ where: { userId: 'uid1' }, data: { realBalance: expect.anything() } })
        expect(fakeTx.thirdPartyTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ type: 'BET', transactionId: 't1' }),
        }))
    })

    it('processBet rejects when the real balance is insufficient', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        p.wallet.findUnique.mockResolvedValue({ realBalance: '5.00', bonusBalance: '0', spendAccount: 'REAL' })
        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '5.00', bonusBalance: '0', spendAccount: 'REAL' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: { create: vi.fn() },
            transaction: { create: vi.fn() },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processBet({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', transaction_id: 't1', amount: 10,
        })

        expect(res).toEqual({ success: false })
        expect(fakeTx.wallet.update).not.toHaveBeenCalled()
    })

    it('processBet replays idempotently — returns current balance without re-debiting', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue({ id: 'existing', status: 'COMPLETED' })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '90.00', bonusBalance: '0', spendAccount: 'REAL' })

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processBet({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', transaction_id: 't1', amount: 10,
        })

        expect(res).toEqual({ player_id: PLAYER_ID, balance: 90 })
        expect(p.$transaction).not.toHaveBeenCalled()
    })

    it('processRollback refunds exactly the recorded bet amount, once', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique
            .mockResolvedValueOnce(null) // findExisting(cancelTxId) — not a replay
        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '90.00', bonusBalance: '0', spendAccount: 'REAL' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: {
                findUnique: vi.fn().mockResolvedValue({ id: 'bet1', betAmount: '10.00', amount: '-10.00', type: 'BET', status: 'COMPLETED', transactionId: 't1' }),
                update: vi.fn(),
                create: vi.fn(),
            },
            transaction: { create: vi.fn(), findFirst: vi.fn().mockResolvedValue(null) },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processRollback({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', bet_transaction_id: 't1',
        })

        expect(res).toEqual({ success: true })
        expect(fakeTx.wallet.update).toHaveBeenCalledWith({ where: { userId: 'uid1' }, data: { realBalance: expect.anything() } })
        expect(fakeTx.thirdPartyTransaction.update).toHaveBeenCalledWith({ where: { id: 'bet1' }, data: { status: 'ROLLED_BACK' } })
    })

    it('processRollback does not credit anything when no matching completed bet exists', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValueOnce(null)
        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '90.00', bonusBalance: '0', spendAccount: 'REAL' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn(), create: vi.fn() },
            transaction: { create: vi.fn(), findFirst: vi.fn() },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))

        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')
        const res = await AtlasVWalletService.processRollback({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', bet_transaction_id: 'nonexistent',
        })

        expect(res).toEqual({ success: true })
        expect(fakeTx.wallet.update).not.toHaveBeenCalled()
        expect(fakeTx.thirdPartyTransaction.update).not.toHaveBeenCalled()
    })
})
