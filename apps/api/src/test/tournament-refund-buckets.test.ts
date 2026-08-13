import { describe, it, expect, vi } from 'vitest'
import { TournamentService } from '../services/tournament.service'
import { prisma } from './setup'
import { TournamentStatus } from '@world-bingo/shared-types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../lib/socket', () => ({
    getIo: () => ({
        to: () => ({ emit: vi.fn() }),
        emit: vi.fn(),
    }),
}))

vi.mock('../services/notification.service', () => ({
    NotificationService: {
        create: vi.fn().mockResolvedValue({ id: 'notif-1' }),
        pushWalletUpdate: vi.fn(),
    },
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createPlayer(opts: { real: number; bonus: number; phone: string }) {
    return prisma.user.create({
        data: {
            username: `refund_${opts.phone.slice(-4)}`,
            phone: opts.phone,
            passwordHash: 'hashed:pass',
            wallet: { create: { realBalance: opts.real, bonusBalance: opts.bonus } },
        },
    })
}

async function createTournament(entryFee: number) {
    return prisma.tournament.create({
        data: {
            title: 'Refund Bucket Tournament',
            entryFee,
            maxPlayers: 4,
            status: TournamentStatus.REGISTRATION,
            houseEdgePct: 10,
        },
    })
}

async function walletOf(userId: string) {
    const w = await prisma.wallet.findUnique({ where: { userId } })
    return { real: Number(w!.realBalance), bonus: Number(w!.bonusBalance) }
}

/**
 * `register` deducts the entry fee bonus-first. A cancellation must therefore
 * return each birr to the bucket it was taken from. Refunding bonus-funded
 * entries into realBalance converts non-withdrawable promotional credit into
 * withdrawable cash at 100% — the same defect RefundService.refundGame already
 * fixed for regular games by deriving the split from the GAME_ENTRY snapshot.
 */
describe('TournamentService.cancel — refunds to the bucket the fee came from', () => {
    it('returns a fully bonus-funded entry fee to bonusBalance, not realBalance', async () => {
        const user = await createPlayer({ real: 0, bonus: 100, phone: '+251900500001' })
        const tournament = await createTournament(100)

        await TournamentService.register(tournament.id, user.id)
        expect(await walletOf(user.id)).toEqual({ real: 0, bonus: 0 })

        await TournamentService.cancel(tournament.id)

        expect(await walletOf(user.id)).toEqual({ real: 0, bonus: 100 })
    })

    it('splits a mixed-funded entry fee back to both buckets in the original proportion', async () => {
        const user = await createPlayer({ real: 40, bonus: 60, phone: '+251900500002' })
        const tournament = await createTournament(100)

        // bonus-first: 60 bonus + 40 real
        await TournamentService.register(tournament.id, user.id)
        expect(await walletOf(user.id)).toEqual({ real: 0, bonus: 0 })

        await TournamentService.cancel(tournament.id)

        expect(await walletOf(user.id)).toEqual({ real: 40, bonus: 60 })
    })
})

/**
 * The only status guard is `status === COMPLETED`, so a CANCELLED tournament can
 * be cancelled again — refunding every entrant a second time. RefundService
 * guards this with a findFirst on an existing REFUND for the same referenceId.
 */
describe('TournamentService.cancel — idempotency', () => {
    it('refunds only once when cancel is called twice', async () => {
        const user = await createPlayer({ real: 500, bonus: 0, phone: '+251900500003' })
        const tournament = await createTournament(100)

        await TournamentService.register(tournament.id, user.id)
        expect(await walletOf(user.id)).toEqual({ real: 400, bonus: 0 })

        await TournamentService.cancel(tournament.id)
        await TournamentService.cancel(tournament.id).catch(() => {
            // A second cancel may legitimately reject once claimed; what must NOT
            // happen is a second payout.
        })

        expect(await walletOf(user.id)).toEqual({ real: 500, bonus: 0 })

        const refunds = await prisma.transaction.findMany({
            where: { userId: user.id, type: 'REFUND', referenceId: tournament.id },
        })
        expect(refunds).toHaveLength(1)
    })

    it('refunds only once when two cancels race', async () => {
        const user = await createPlayer({ real: 500, bonus: 0, phone: '+251900500004' })
        const tournament = await createTournament(100)

        await TournamentService.register(tournament.id, user.id)

        await Promise.allSettled([
            TournamentService.cancel(tournament.id),
            TournamentService.cancel(tournament.id),
        ])

        expect(await walletOf(user.id)).toEqual({ real: 500, bonus: 0 })

        const refunds = await prisma.transaction.findMany({
            where: { userId: user.id, type: 'REFUND', referenceId: tournament.id },
        })
        expect(refunds).toHaveLength(1)
    })
})
