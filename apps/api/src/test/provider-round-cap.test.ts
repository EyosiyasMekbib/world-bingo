import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'

vi.mock('../lib/prisma.js', () => ({ default: { user: { findUnique: vi.fn() } } }))
vi.mock('../services/account-status.service.js', () => ({ AccountStatusService: { restrict: vi.fn() } }))
const { logger } = vi.hoisted(() => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../lib/log-context.js', () => ({ getLogger: () => logger }))

import prisma from '../lib/prisma.js'
import { AccountStatusService } from '../services/account-status.service.js'
import { checkRoundCap, roundCapLimits, restrictAfterRoundCap } from '../lib/provider-round-cap.js'
const p = prisma as any
const restrict = AccountStatusService.restrict as ReturnType<typeof vi.fn>

const LIMITS = { maxCredits: 200, maxMultiple: 2_000 }

/** A transaction whose round has already been credited `credits` times for `credited` ETB, against `staked` ETB of bets. */
function roundTx(credits: number, credited: string | null, staked: string | null) {
    return {
        thirdPartyTransaction: {
            aggregate: vi.fn(async (args: any) =>
                args.where.type.in.includes('BET')
                    ? { _sum: { betAmount: staked } }
                    : { _sum: { amount: credited }, _count: credits },
            ),
        },
    } as any
}

const base = { providerId: 'pid1', userId: 'uid1', roundId: 'r1', limits: LIMITS }

describe('checkRoundCap', () => {
    it('lets a credit through while the round is inside both caps', async () => {
        const tx = roundTx(20, '1550.00', '50.00')
        expect(await checkRoundCap(tx, { ...base, credit: new Decimal(77.5) })).toBeNull()
        expect(tx.thirdPartyTransaction.aggregate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ providerId: 'pid1', userId: 'uid1', roundId: 'r1', amount: { gt: 0 } }),
            }),
        )
    })

    it('flags the credit after the round has already been credited maxCredits times', async () => {
        const breach = await checkRoundCap(roundTx(200, '15500.00', '50.00'), { ...base, credit: new Decimal(77.5) })
        expect(breach).toEqual(expect.objectContaining({ credits: 200, overCount: true, overTotal: false }))
    })

    it('flags the credit that would take the round past its stake multiple', async () => {
        // 50 x 2,000 = 100,000; 99,950 already credited + 77.50 crosses it.
        const breach = await checkRoundCap(roundTx(3, '99950.00', '50.00'), { ...base, credit: new Decimal(77.5) })
        expect(breach).toEqual(expect.objectContaining({ stake: 50, credited: 100027.5, overCount: false, overTotal: true }))
    })

    it('uses a stake the caller already knows when the round itself has no recorded bet', async () => {
        // GASea can post the bet without a roundId; its result names the round.
        const breach = await checkRoundCap(roundTx(1, '9995.00', null), { ...base, credit: new Decimal(10), knownStake: new Decimal(5) })
        expect(breach).toEqual(expect.objectContaining({ stake: 5, overTotal: true }))
    })

    it('applies only the count cap to a round with no stake at all', async () => {
        expect(await checkRoundCap(roundTx(5, '900000.00', null), { ...base, credit: new Decimal(1000) })).toBeNull()
        expect(await checkRoundCap(roundTx(200, '900000.00', null), { ...base, credit: new Decimal(1000) })).toEqual(
            expect.objectContaining({ overCount: true, overTotal: false }),
        )
    })

    it('never caps a zero credit or a callback without a round', async () => {
        const tx = roundTx(500, '1.00', '1.00')
        expect(await checkRoundCap(tx, { ...base, credit: new Decimal(0) })).toBeNull()
        expect(await checkRoundCap(tx, { ...base, roundId: undefined, credit: new Decimal(10) })).toBeNull()
        expect(tx.thirdPartyTransaction.aggregate).not.toHaveBeenCalled()
    })
})

describe('roundCapLimits', () => {
    afterEach(() => {
        delete process.env.TESTPROV_MAX_ROUND_WINS
        delete process.env.TESTPROV_MAX_ROUND_WIN_MULTIPLE
    })

    it('defaults to 200 credits and 2,000x, and reads <PREFIX>_ overrides at call time', () => {
        expect(roundCapLimits('TESTPROV')).toEqual({ maxCredits: 200, maxMultiple: 2_000 })
        process.env.TESTPROV_MAX_ROUND_WINS = '0'
        process.env.TESTPROV_MAX_ROUND_WIN_MULTIPLE = '500'
        expect(roundCapLimits('TESTPROV')).toEqual({ maxCredits: 0, maxMultiple: 500 })
    })

    it('treats 0 as "cap disabled"', async () => {
        const breach = await checkRoundCap(roundTx(10_000, '1000000.00', '1.00'), {
            ...base,
            credit: new Decimal(1),
            limits: { maxCredits: 0, maxMultiple: 0 },
        })
        expect(breach).toBeNull()
    })
})

describe('restrictAfterRoundCap', () => {
    beforeEach(() => vi.clearAllMocks())

    it('restricts an ACTIVE account with a reason naming the provider and round', async () => {
        p.user.findUnique.mockResolvedValue({ accountStatus: 'ACTIVE' })
        await restrictAfterRoundCap('uid1', 'Atlas-V', 'r1', 'rocketstar')
        expect(restrict).toHaveBeenCalledWith(
            'uid1',
            expect.objectContaining({ reason: expect.stringMatching(/Atlas-V round r1 \(rocketstar\)/), category: 'OTHER' }),
        )
    })

    it('never weakens a stricter status', async () => {
        p.user.findUnique.mockResolvedValue({ accountStatus: 'SUSPENDED' })
        await restrictAfterRoundCap('uid1', 'Atlas-V', 'r1', 'rocketstar')
        expect(restrict).not.toHaveBeenCalled()
    })

    it('logs and swallows a failure rather than failing the callback', async () => {
        p.user.findUnique.mockResolvedValue({ accountStatus: 'ACTIVE' })
        restrict.mockRejectedValueOnce(new Error('db down'))
        await expect(restrictAfterRoundCap('uid1', 'GASea', 'r1', undefined)).resolves.toBeUndefined()
        expect(logger.error).toHaveBeenCalled()
    })
})
