import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('../lib/prisma.js', () => ({
    default: {
        gameProvider: { findUnique: vi.fn() },
        wallet: { findUnique: vi.fn(), update: vi.fn() },
        thirdPartyTransaction: { findUnique: vi.fn(), create: vi.fn() },
        transaction: { create: vi.fn(), findFirst: vi.fn() },
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
    BonusService: { spend: vi.fn(), restore: vi.fn() },
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

    it('processBet is idempotent on duplicate trans_guid (COMPLETED), reporting the live selected-account balance', async () => {
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue({
            status: 'COMPLETED', balanceAfter: '90.00', // stale combined-total ledger value — must NOT be echoed back
        })
        // The replay branch re-reads the live wallet rather than trusting the ledger's
        // `balanceAfter`; this is deliberately a different number than 90 to prove that.
        p.wallet.findUnique.mockResolvedValue({ realBalance: '77.00', bonusBalance: '0.00', spendAccount: 'REAL' })
        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.processBet({
            trans_guid: 'tg1', account: 'alice', gplay_id: 'gp1',
            round_id: 'r1', game_code: 'game1', amount: 10,
        })
        expect(res.result).toBe(0)
        expect((res.data as any).balance).toBe(77)
        expect(p.$transaction).not.toHaveBeenCalled()
    })

    it('processBet replay (same trans_guid) reports the live selected-account balance, not the stale combined total', async () => {
        // Regression test: Palace can time out waiting for our response and retry with
        // the same trans_guid (see apps/api/src/routes/palace/callback.ts). The retry
        // must report the same single-account balance the original response did — not
        // the ThirdPartyTransaction ledger's combined real+bonus total, which is what
        // the pre-Task-18 code (and a naive fix that only touched the fresh-compute path)
        // would echo back.
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })

        // First call: fresh bet. Wallet starts real=1000, bonus=10, spendAccount=BONUS;
        // bet of 6 spends entirely out of bonus, leaving bonus=4.
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)
        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '1000.00', bonusBalance: '10.00', spendAccount: 'BONUS' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: { create: vi.fn() },
            transaction: { create: vi.fn() },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))
        vi.mocked(BonusService.spend).mockResolvedValue({
            spent: new Decimal(6),
            bonusBalanceBefore: new Decimal(10),
            bonusBalanceAfter: new Decimal(4),
            soonestExpiryConsumed: null,
        } as any)

        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const first = await PalaceWalletService.processBet({
            trans_guid: 'replay-1', account: 'alice', gplay_id: 'p1', round_id: 'r1', game_code: 'c1', amount: 6,
        })
        expect(first.result).toBe(0)
        expect((first.data as any).balance).toBe(4) // bonus-only

        // Simulate Palace not receiving that response and retrying with the same
        // trans_guid. The ledger legitimately recorded the combined total (1000 real +
        // 4 bonus = 1004) for audit purposes — the replay must not parrot that back.
        p.thirdPartyTransaction.findUnique.mockResolvedValue({
            status: 'COMPLETED',
            balanceAfter: '1004.00',
        })
        p.wallet.findUnique.mockResolvedValue({ realBalance: '1000.00', bonusBalance: '4.00', spendAccount: 'BONUS' })

        const replay = await PalaceWalletService.processBet({
            trans_guid: 'replay-1', account: 'alice', gplay_id: 'p1', round_id: 'r1', game_code: 'c1', amount: 6,
        })
        expect(replay.result).toBe(0)
        expect((replay.data as any).balance).toBe(4) // live bonus balance — matches `first`, not the stale 1004 total
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

    it('processCancel restores a bonus-funded bet to bonus, not real', async () => {
        // Original bet spent 15 entirely out of bonus (bonus 20 -> 5); the cancel
        // must restore that 15 back into bonus, not mint it into real.
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null) // no existing rollback row for this cancel id

        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '1000.00', bonusBalance: '5.00', spendAccount: 'BONUS' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: {
                // The original bet, re-read under the wallet lock (R5 guard).
                findUnique: vi.fn().mockResolvedValue({
                    id: 'bet-tx-1',
                    transactionId: 'g3',
                    type: 'BET',
                    status: 'COMPLETED',
                    betAmount: '15.00',
                    amount: '-15.00',
                }),
                create: vi.fn(),
                update: vi.fn(),
            },
            transaction: {
                create: vi.fn(),
                // The paired Transaction row processBet wrote alongside the bet.
                findFirst: vi.fn().mockResolvedValue({ bonusBalanceBefore: '20.00', bonusBalanceAfter: '5.00' }),
            },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))
        vi.mocked(BonusService.restore).mockResolvedValue({
            granted: true,
            grantId: 'grant-1',
            amount: new Decimal(15),
            bonusBalanceBefore: new Decimal(5),
            bonusBalanceAfter: new Decimal(20),
        } as any)

        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.processCancel({
            trans_guid: 'g3cancel', account: 'alice', gplay_id: 'p3', round_id: 'r3', game_code: 'c1',
            amount: 15, cancle_trans_guid: 'g3',
        } as any)

        expect(res.result).toBe(0)
        expect((res.data as any).balance).toBe(1020) // real 1000 (untouched) + bonus 20 (5 + 15 restored)

        // Restored through BonusService.restore (a new BonusGrant lot), never-expiring.
        expect(BonusService.restore).toHaveBeenCalledTimes(1)
        const [restoreTx, restoreUserId, restoreAmount, restoreExpiry] = vi.mocked(BonusService.restore).mock.calls[0]
        expect(restoreTx).toBe(fakeTx)
        expect(restoreUserId).toBe('uid1')
        expect((restoreAmount as Decimal).toNumber()).toBe(15)
        expect(restoreExpiry).toBeNull()

        // Real balance untouched — no raw wallet.update for the real side.
        expect(fakeTx.wallet.update).not.toHaveBeenCalled()

        // Looked up the paired bet Transaction row by TP_BET + the original bet's
        // own trans_guid as referenceId (the field processBet actually wrote it under).
        expect(fakeTx.transaction.findFirst).toHaveBeenCalledWith({
            where: { userId: 'uid1', type: 'TP_BET', referenceId: 'g3' },
            select: { bonusBalanceBefore: true, bonusBalanceAfter: true },
        })

        // Original bet settled so it cannot be cancelled twice (R5 guard intact).
        expect(fakeTx.thirdPartyTransaction.update).toHaveBeenCalledWith({
            where: { id: 'bet-tx-1' },
            data: { status: 'ROLLED_BACK' },
        })
    })

    it('processCancel restores a real-funded bet to real, unchanged from before', async () => {
        // Original bet spent 15 out of real (bonus never touched); the cancel must
        // still restore it to real, exactly as before this fix — no regression.
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)

        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '985.00', bonusBalance: '20.00', spendAccount: 'REAL' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: {
                findUnique: vi.fn().mockResolvedValue({
                    id: 'bet-tx-2',
                    transactionId: 'g4',
                    type: 'BET',
                    status: 'COMPLETED',
                    betAmount: '15.00',
                    amount: '-15.00',
                }),
                create: vi.fn(),
                update: vi.fn(),
            },
            transaction: {
                create: vi.fn(),
                // Bonus untouched at bet time — real-funded bet.
                findFirst: vi.fn().mockResolvedValue({ bonusBalanceBefore: '20.00', bonusBalanceAfter: '20.00' }),
            },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))

        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.processCancel({
            trans_guid: 'g4cancel', account: 'alice', gplay_id: 'p4', round_id: 'r4', game_code: 'c1',
            amount: 15, cancle_trans_guid: 'g4',
        } as any)

        expect(res.result).toBe(0)
        expect((res.data as any).balance).toBe(1020) // real 985 + 15 restored, bonus 20 untouched

        expect(fakeTx.wallet.update).toHaveBeenCalledTimes(1)
        const realUpdateArg = (fakeTx.wallet.update as any).mock.calls[0][0]
        expect(realUpdateArg.where).toEqual({ userId: 'uid1' })
        expect((realUpdateArg.data.realBalance as Decimal).toNumber()).toBe(1000)

        expect(BonusService.restore).not.toHaveBeenCalled()
        expect(fakeTx.thirdPartyTransaction.update).toHaveBeenCalledWith({
            where: { id: 'bet-tx-2' },
            data: { status: 'ROLLED_BACK' },
        })
    })

    it('processCancel R5 guard: no matching completed bet credits nothing and settles nothing', async () => {
        // Forged/unmatched cancel — the fraud guard this fix builds on top of must
        // still reject crediting anything, regardless of the real/bonus split logic.
        p.user.findUnique.mockResolvedValue({ id: 'uid1', isActive: true })
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null)

        const fakeTx = {
            $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '1000.00', bonusBalance: '20.00', spendAccount: 'REAL' }]),
            wallet: { update: vi.fn() },
            thirdPartyTransaction: {
                findUnique: vi.fn().mockResolvedValue(null), // no original bet found under the lock
                create: vi.fn(),
                update: vi.fn(),
            },
            transaction: { create: vi.fn(), findFirst: vi.fn() },
        }
        p.$transaction.mockImplementation((cb: any) => cb(fakeTx))

        const { PalaceWalletService } = await import('../services/palace-wallet.service.js')
        const res = await PalaceWalletService.processCancel({
            trans_guid: 'forged-cancel', account: 'alice', gplay_id: 'p9', round_id: 'r9', game_code: 'c1',
            amount: 999, cancle_trans_guid: 'never-happened',
        } as any)

        expect(res.result).toBe(0)
        expect((res.data as any).balance).toBe(1020) // unchanged combined total — forged amount not minted
        expect(fakeTx.wallet.update).not.toHaveBeenCalled()
        expect(BonusService.restore).not.toHaveBeenCalled()
        expect(fakeTx.transaction.findFirst).not.toHaveBeenCalled() // split lookup never reached — nothing to split
        expect(fakeTx.thirdPartyTransaction.update).not.toHaveBeenCalled() // nothing to settle
        expect(fakeTx.transaction.create).not.toHaveBeenCalled() // no TP_ROLLBACK ledger row for a non-credit
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
