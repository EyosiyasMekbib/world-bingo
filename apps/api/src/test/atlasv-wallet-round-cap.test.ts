import { describe, it, expect, vi, beforeEach } from 'vitest'

// Per-round cumulative cap on the Atlas-V credit paths that take no stake in the
// same call: result (one settlement per bet already, but a round can carry many
// bets), freespin and jackpot (no bet at all). Same shape of guard as the Palace
// fix for the 2026-10-22 chicken-road replay.

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
vi.mock('../services/account-status.service.js', () => ({ AccountStatusService: { restrict: vi.fn() } }))

import prisma from '../lib/prisma.js'
import { AccountStatusService } from '../services/account-status.service.js'
const p = prisma as any
const restrict = AccountStatusService.restrict as ReturnType<typeof vi.fn>

const PLAYER_ID = 'a'.repeat(32)
const SETTLEABLE_BET = { id: 'bet1', type: 'BET', status: 'COMPLETED', betAmount: '10.00', amount: '-10.00', rawResponse: null }

/** A locked-wallet transaction whose round has already been credited `credits` times for `credited` ETB. */
function roundTx(credits: number, credited: string | null, staked: string | null) {
    return {
        $queryRaw: vi.fn().mockResolvedValue([{ id: 'w1', realBalance: '90.00', bonusBalance: '0', spendAccount: 'REAL' }]),
        wallet: { update: vi.fn() },
        thirdPartyTransaction: {
            findUnique: vi.fn().mockResolvedValue(SETTLEABLE_BET),
            create: vi.fn(),
            update: vi.fn(),
            aggregate: vi.fn(async (args: any) =>
                args.where.type.in.includes('BET')
                    ? { _sum: { betAmount: staked } }
                    : { _sum: { amount: credited }, _count: credits },
            ),
        },
        transaction: { create: vi.fn() },
    }
}

describe('AtlasVWalletService per-round cumulative cap', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        p.gameProvider.findUnique.mockResolvedValue({ id: 'pid1' })
        p.user.findUnique.mockResolvedValue({ id: 'uid1', accountStatus: 'ACTIVE' })
        p.thirdPartyTransaction.findUnique.mockResolvedValue(null) // no transaction_id replay
    })

    it('processResult still settles a bet while its round is inside the caps', async () => {
        const tx = roundTx(1, '30.00', '20.00')
        p.$transaction.mockImplementation((cb: any) => cb(tx))
        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')

        const res = await AtlasVWalletService.processResult({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'rocketstar',
            transaction_id: 'res1', bet_transaction_id: 't1', amount: 30,
        })

        expect(res).toEqual({ success: true, error: null })
        expect(tx.wallet.update).toHaveBeenCalled()
        expect(restrict).not.toHaveBeenCalled()
    })

    it('processResult refuses a credit once the round has been credited 200 times, and restricts the account', async () => {
        const tx = roundTx(200, '6000.00', '2000.00')
        p.$transaction.mockImplementation((cb: any) => cb(tx))
        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')

        const res = await AtlasVWalletService.processResult({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'rocketstar',
            transaction_id: 'res201', bet_transaction_id: 't201', amount: 30,
        })

        expect(res).toEqual({ error: 'Player Blocked' })
        expect(tx.wallet.update).not.toHaveBeenCalled()
        expect(tx.thirdPartyTransaction.update).not.toHaveBeenCalled() // the bet stays unsettled
        expect(tx.thirdPartyTransaction.create).not.toHaveBeenCalled()
        expect(restrict).toHaveBeenCalledWith('uid1', expect.objectContaining({ reason: expect.stringContaining('round r1') }))
    })

    it('processFreespinResult refuses a credit once its round has been credited 200 times', async () => {
        const tx = roundTx(200, '3000.00', null)
        p.$transaction.mockImplementation((cb: any) => cb(tx))
        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')

        const res = await AtlasVWalletService.processFreespinResult({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', transaction_id: 'fs201', amount: 15,
        })

        expect(res).toEqual({ success: false })
        expect(tx.wallet.update).not.toHaveBeenCalled()
        expect(tx.thirdPartyTransaction.create).not.toHaveBeenCalled()
        expect(restrict).toHaveBeenCalledTimes(1)
    })

    it('processJackpot refuses a credit once its round has been credited 200 times', async () => {
        const tx = roundTx(200, '100000.00', null)
        p.$transaction.mockImplementation((cb: any) => cb(tx))
        const { AtlasVWalletService } = await import('../services/atlasv-wallet.service.js')

        const res = await AtlasVWalletService.processJackpot({
            player_id: PLAYER_ID, round_id: 'r1', game_code: 'penalty', transaction_id: 'jp201', amount: 500,
        })

        expect(res).toEqual({ success: false })
        expect(tx.wallet.update).not.toHaveBeenCalled()
        expect(restrict).toHaveBeenCalledTimes(1)
    })
})
