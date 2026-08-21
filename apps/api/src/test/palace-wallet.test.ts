import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'

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

// `BonusService.spend` is production code with its own dedicated real-DB coverage
// (bonus.service.test.ts) — soonest-expiry-first lot consumption against
// `bonus_grants`, a table this flat prisma double does not model. What
// `processBet` needs verified HERE is only its own contract with it: called only
// when BONUS is selected and only after the pre-check passes, and its
// `bonusBalanceAfter` becomes the reported balance. Mocked the same way
// prediction-order.test.ts mocks it against the same underlying module.
vi.mock('../services/bonus.service.js', () => ({
    BonusService: { spend: vi.fn() },
}))

import prisma from '../lib/prisma.js'
import { BonusService } from '../services/bonus.service.js'
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

    it('getBalance returns the REAL balance for a user on the REAL spend account', async () => {
        // Task 18: getBalance now reports only the selected account, not real+bonus
        // combined — a wallet with no explicit spendAccount defaults to REAL
        // (schema default), so only realBalance should be reported here.
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '100.00', bonusBalance: '50.00', spendAccount: 'REAL' })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.getBalance('alice')
        expect(res.result).toBe(0)
        expect(res.status).toBe('OK')
        expect((res.data as any).balance).toBe(100)
    })

    it('authenticate/getBalance report only the selected account balance, not the combined total', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '1000.00', bonusBalance: '40.00', spendAccount: 'BONUS' })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        const authResult = await PalaceWalletService.authenticate('alice')
        expect(authResult.result).toBe(0)
        expect((authResult.data as any).balance).toBe(40)

        const balResult = await PalaceWalletService.getBalance('alice')
        expect(balResult.result).toBe(0)
        expect((balResult.data as any).balance).toBe(40)
    })

    it('processBet spends entirely from BONUS when selected, and rejects rather than dipping into real', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        // Catch-block fallback read (on rejection) hits `prisma.wallet.findUnique` directly.
        p.wallet.findUnique.mockResolvedValue({ realBalance: '1000.00', bonusBalance: '10.00', spendAccount: 'BONUS' })

        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '1000.00', bonusBalance: '10.00', spendAccount: 'BONUS' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: { create: vi.fn() },
            transaction: { create: vi.fn() },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))

        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')

        // Over-bet: BONUS balance (10) can't cover a 50 stake. Must reject outright,
        // never silently draw the shortfall from the untouched 1000 real balance.
        const overBet = await PalaceWalletService.processBet({
            trans_guid: 'g1', account: 'alice', gplay_id: 'p1', round_id: 'r1', game_code: 'c1', amount: 50,
        })
        expect(overBet.result).not.toBe(0)
        expect(overBet.status).toBe('BALANCE_NOT_ENOUGH')
        expect((overBet.data as any).balance).toBe(10) // reports the BONUS account, not the 1000 real balance
        expect(fakeTx.wallet.update).not.toHaveBeenCalled() // real balance never written
        expect(BonusService.spend).not.toHaveBeenCalled()

        // Valid bet: spends entirely out of BONUS via BonusService.spend.
        vi.mocked(BonusService.spend).mockResolvedValue({
            spent: new Decimal(6),
            bonusBalanceBefore: new Decimal(10),
            bonusBalanceAfter: new Decimal(4),
            soonestExpiryConsumed: null,
        } as any)
        const okBet = await PalaceWalletService.processBet({
            trans_guid: 'g2', account: 'alice', gplay_id: 'p2', round_id: 'r2', game_code: 'c1', amount: 6,
        })
        expect(okBet.result).toBe(0)
        expect((okBet.data as any).balance).toBe(4)
        expect(BonusService.spend).toHaveBeenCalledWith(fakeTx, 'uid1', expect.anything())
        expect(fakeTx.wallet.update).not.toHaveBeenCalled() // BONUS branch: BonusService.spend owns the wallet write
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

    it('getStatus returns 21 when user does not exist', async () => {
        p.user.findUnique.mockResolvedValue(null)
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.getStatus('nobody', 'any-guid')
        expect(res).toEqual({ result: 21, status: 'USER_NOT_FOUND', data: null })
    })

    it('getStatus returns 42 when trans_guid does not exist', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.getStatus('alice', 'unknown-guid')
        expect(res).toEqual({ result: 42, status: 'TRANS_ID_NOT_FOUND', data: null })
    })

    it('getStatus returns OK with account/trans_guid/trans_status when tx exists', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue({ id: 'some-tx' })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '100.00', bonusBalance: '0.00' })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.getStatus('alice', 'tg-exists')
        expect(res.result).toBe(0)
        expect(res.status).toBe('OK')
        expect((res.data as any).trans_guid).toBe('tg-exists')
        expect((res.data as any).trans_status).toBe('OK')
    })

    it('dispatch emits a structured outcome line with masked account + result code', async () => {
        p.user.findUnique.mockResolvedValue(null) // unknown user → result 21
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const { runWithLogger } = await import('../lib/log-context.js')
        const spy = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() }
        const res = await runWithLogger(spy as any, () =>
            PalaceWalletService.dispatch('balance', { account: 'h00a053c60814bd4f569313abf1c3fa3d63' }),
        )
        expect(res.result).toBe(21)
        expect(spy.info).toHaveBeenCalledWith(
            expect.objectContaining({
                component: 'palace-wallet',
                command: 'balance',
                account: 'h00a05…3d63',
                resultCode: 21,
            }),
            expect.any(String),
        )
    })
})
