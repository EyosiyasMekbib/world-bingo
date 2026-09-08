import { describe, it, expect, vi, beforeEach } from 'vitest'

// PalaceWalletService must hand every committed bet and win to the PostHog
// emitters, and nothing to them when the bet was refused — the emitter runs
// post-commit, so a rejected bet must never look like spend.

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
const { emitProviderBet, emitProviderWin } = vi.hoisted(() => ({
    emitProviderBet: vi.fn(),
    emitProviderWin: vi.fn(),
}))
vi.mock('../lib/posthog-events.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/posthog-events.js')>()
    return { ...actual, emitProviderBet, emitProviderWin }
})

import prisma from '../lib/prisma.js'
const p = prisma as any

function walletTx(realBalance: string, spendAccount = 'REAL') {
    return {
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance, bonusBalance: '0.00', spendAccount }]),
        wallet: { update: vi.fn() },
        thirdPartyTransaction: { create: vi.fn() },
        transaction: { create: vi.fn() },
    }
}

describe('PalaceWalletService → PostHog', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
    })

    it('processBet emits provider_bet after the ledger rows commit', async () => {
        const tx = walletTx('100.00')
        p.$transaction.mockImplementation((cb: any) => cb(tx))
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        const res = await PalaceWalletService.processBet({
            trans_guid: 'g1', account: 'alice', gplay_id: 'p1', round_id: 'r1', game_code: 'aviator', amount: 25,
        })

        expect(res.result).toBe(0)
        expect(emitProviderBet).toHaveBeenCalledWith('uid1', {
            providerCode: 'palace',
            gameCode: 'aviator',
            roundId: 'r1',
            betId: 'p1',
            amount: 25,
            spendAccount: 'REAL',
        })
    })

    it('processBet emits nothing when the bet is refused for balance', async () => {
        const tx = walletTx('10.00')
        p.$transaction.mockImplementation((cb: any) => cb(tx))
        p.wallet.findUnique.mockResolvedValue({ realBalance: '10.00', bonusBalance: '0.00', spendAccount: 'REAL' })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        const res = await PalaceWalletService.processBet({
            trans_guid: 'g2', account: 'alice', gplay_id: 'p2', round_id: 'r2', game_code: 'aviator', amount: 500,
        })

        expect(res.status).toBe('BALANCE_NOT_ENOUGH')
        expect(emitProviderBet).not.toHaveBeenCalled()
    })

    it('processBet emits nothing on a replayed trans_guid', async () => {
        p.thirdPartyTransaction.findUnique.mockResolvedValue({ status: 'COMPLETED', balanceAfter: '75.00' })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '75.00', bonusBalance: '0.00', spendAccount: 'REAL' })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        await PalaceWalletService.processBet({
            trans_guid: 'g1', account: 'alice', gplay_id: 'p1', round_id: 'r1', game_code: 'aviator', amount: 25,
        })

        expect(emitProviderBet).not.toHaveBeenCalled()
    })

    it('processWin emits provider_win with the round stake after commit', async () => {
        const tx = walletTx('75.00')
        p.$transaction.mockImplementation((cb: any) => cb(tx))
        p.thirdPartyTransaction.aggregate.mockResolvedValue({ _sum: { betAmount: 25 }, _count: 1 })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        const res = await PalaceWalletService.processWin({
            trans_guid: 'g3', account: 'alice', gplay_id: 'p1', round_id: 'r1', game_code: 'aviator', amount: 60, type: 1,
        })

        expect(res.result).toBe(0)
        expect(emitProviderWin).toHaveBeenCalledWith('uid1', {
            providerCode: 'palace',
            gameCode: 'aviator',
            roundId: 'r1',
            betId: 'p1',
            amount: 60,
            roundStake: 25,
        })
    })
})
