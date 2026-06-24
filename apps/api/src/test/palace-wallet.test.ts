import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma.js', () => ({
    default: {
        gameProvider: { findUnique: vi.fn() },
        wallet: { findUnique: vi.fn(), update: vi.fn() },
        thirdPartyTransaction: { findUnique: vi.fn(), create: vi.fn() },
        transaction: { create: vi.fn() },
        user: { findUnique: vi.fn() },
        $transaction: vi.fn(),
        $queryRaw: vi.fn(),
    },
}))

vi.mock('../lib/redis.js', () => ({ default: { get: vi.fn().mockResolvedValue(null), setex: vi.fn() } }))

import prisma from '../lib/prisma.js'
const p = prisma as any

describe('PalaceWalletService', () => {
    beforeEach(() => vi.clearAllMocks())

    it('getBalance returns USER_NOT_FOUND for unknown account', async () => {
        p.user.findUnique.mockResolvedValue(null)
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.getBalance('nobody')
        expect(res).toEqual({ result: 21, status: 'USER_NOT_FOUND', data: null })
    })

    it('getBalance returns USER_INACTIVE for inactive user', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: false })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.getBalance('alice')
        expect(res).toEqual({ result: 22, status: 'USER_INACTIVE', data: null })
    })

    it('getBalance returns balance for known active user', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '100.00', bonusBalance: '50.00' })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.getBalance('alice')
        expect(res.result).toBe(0)
        expect(res.status).toBe('OK')
        expect((res.data as any).balance).toBe(150)
    })

    it('processBet is idempotent on duplicate trans_guid (COMPLETED)', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue({
            status: 'COMPLETED', balanceAfter: '90.00',
        })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.processBet({
            trans_guid: 'tg1', account: 'alice', gplay_id: 'gp1',
            round_id: 'r1', game_code: 'game1', amount: 10,
        })
        expect(res.result).toBe(0)
        expect((res.data as any).balance).toBe(90)
        expect(p.$transaction).not.toHaveBeenCalled()
    })

    it('processBet returns BALANCE_NOT_ENOUGH when $transaction throws it', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        p.$transaction.mockRejectedValue({ code: 'BALANCE_NOT_ENOUGH' })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '5.00', bonusBalance: '0.00' })
        p.thirdPartyTransaction.create.mockResolvedValue({})
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.processBet({
            trans_guid: 'tg1', account: 'alice', gplay_id: 'gp1',
            round_id: 'r1', game_code: 'game1', amount: 100,
        })
        expect(res).toEqual({ result: 31, status: 'BALANCE_NOT_ENOUGH', data: { balance: 5 } })
    })

    it('getStatus returns NOT_FOUND when trans_guid does not exist', async () => {
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.getStatus('alice', 'unknown-guid')
        expect(res.result).toBe(0)
        expect((res.data as any).trans_status).toBe('NOT_FOUND')
    })

    it('getStatus returns OK when trans_guid exists', async () => {
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue({ id: 'some-tx' })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.getStatus('alice', 'tg-exists')
        expect(res.result).toBe(0)
        expect((res.data as any).trans_status).toBe('OK')
    })
})
