import { describe, it, expect, vi } from 'vitest'
import { TournamentService } from '../services/tournament.service'
import { BonusService } from '../services/bonus.service'
import { prisma } from './setup'
import { TournamentStatus, TransactionType, PaymentStatus } from '@world-bingo/shared-types'

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
 * `register` spends the entry fee entirely from whichever account
 * wallet.spendAccount selects (Task 29) — no mixing across accounts. A
 * cancellation must therefore return the fee to the bucket it was actually
 * taken from. Refunding a bonus-funded entry into realBalance would convert
 * non-withdrawable promotional credit into withdrawable cash at 100% — the
 * same defect RefundService.refundGame already fixed for regular games by
 * deriving the split from the GAME_ENTRY snapshot.
 */
describe('TournamentService.cancel — refunds to the bucket the fee came from', () => {
    it('returns a fully bonus-funded entry fee to bonusBalance, not realBalance', async () => {
        const user = await createPlayer({ real: 0, bonus: 0, phone: '+251900500001' })
        await prisma.wallet.update({ where: { userId: user.id }, data: { spendAccount: 'BONUS' } })
        // BonusService.spend consumes real bonus_grants lots, not the wallet's
        // cached bonusBalance directly — grant a real lot so the spend has
        // something to draw from.
        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount: 100, source: 'ADMIN' }))
        const tournament = await createTournament(100)

        await TournamentService.register(tournament.id, user.id)
        expect(await walletOf(user.id)).toEqual({ real: 0, bonus: 0 })

        await TournamentService.cancel(tournament.id)

        expect(await walletOf(user.id)).toEqual({ real: 0, bonus: 100 })

        // Verify the restore actually recreated a lot, not just a cached-balance bump.
        const activeLot = await prisma.bonusGrant.findFirstOrThrow({
            where: { userId: user.id, status: 'ACTIVE' },
        })
        expect(Number(activeLot.remaining)).toBe(100)
    })

    it('spends entirely from realBalance by default (spendAccount defaults to REAL), leaving bonusBalance untouched even when bonus funds exist', async () => {
        const user = await createPlayer({ real: 100, bonus: 60, phone: '+251900500002' })
        const tournament = await createTournament(100)

        // spendAccount defaults to REAL — the whole fee comes from real, bonus
        // is never consulted (no more bonus-first mixing).
        await TournamentService.register(tournament.id, user.id)
        expect(await walletOf(user.id)).toEqual({ real: 0, bonus: 60 })

        await TournamentService.cancel(tournament.id)

        expect(await walletOf(user.id)).toEqual({ real: 100, bonus: 60 })
    })
})

/**
 * Task 15 fixed the equivalent bug in GameService.leaveGame/RefundService.refundGame:
 * the bonus portion of a refund must be restored under its ORIGINAL expiry (via
 * BonusService.restore), not a fresh window — otherwise a cancel-then-rejoin
 * cycle launders an about-to-expire bonus into a brand-new one.
 */
describe('TournamentService.cancel — bonus restore (original expiry)', () => {
    it('restores a bonus-funded entry to a lot carrying the ORIGINAL expiry, not a fresh window', async () => {
        const originalExpiry = new Date(Date.now() + 1800_000)
        const user = await createPlayer({ real: 0, bonus: 0, phone: '+251900500005' })
        await prisma.wallet.update({ where: { userId: user.id }, data: { spendAccount: 'BONUS' } })
        // Grant amount equals the entry fee so the lot is FULLY consumed
        // (status → CONSUMED) by registration — a clean discriminator: pre-fix,
        // cancel never creates a new lot, so there is no ACTIVE lot afterward.
        await prisma.$transaction((tx) =>
            BonusService.grant(tx, { userId: user.id, amount: 100, source: 'ADMIN', expiresAt: originalExpiry }),
        )
        const tournament = await createTournament(100)

        await TournamentService.register(tournament.id, user.id)
        await TournamentService.cancel(tournament.id)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(Number(wallet.bonusBalance)).toBe(100)

        const activeLot = await prisma.bonusGrant.findFirstOrThrow({
            where: { userId: user.id, status: 'ACTIVE' },
        })
        expect(activeLot.expiresAt?.getTime()).toBe(originalExpiry.getTime())
        expect(Number(activeLot.remaining)).toBe(100)
    })

    it('restores using the SOONEST original expiry across multiple GAME_ENTRY transactions for the same tournament, not an arbitrary one', async () => {
        // A player cannot register twice for the same tournament (the
        // tournamentId_userId unique index), so this scenario cannot arise
        // through register() alone today. It is still the exact shared-logic
        // path Task 15's fix hardened in game.service.ts/refund.service.ts —
        // reconstruct it directly (mirroring refund.service.test.ts's own
        // "manually fabricate the GAME_ENTRY transaction" convention) to prove
        // cancel() uses the deterministic minimum-expiry reduce, not an
        // unordered .find() that would return whichever row happens to sort
        // first.
        const laterExpiry = new Date(Date.now() + 3600_000) // 60 min
        const soonExpiry = new Date(Date.now() + 900_000) // 15 min
        const user = await createPlayer({ real: 1000, bonus: 0, phone: '+251900500006' })
        await prisma.wallet.update({ where: { userId: user.id }, data: { spendAccount: 'BONUS' } })
        const tournament = await createTournament(10)

        // Grant + spend the LATER lot first via a normal register() — this
        // GAME_ENTRY transaction is inserted FIRST and stamped with the LATER
        // expiry.
        await prisma.$transaction((tx) =>
            BonusService.grant(tx, { userId: user.id, amount: 10, source: 'ADMIN', expiresAt: laterExpiry }),
        )
        await TournamentService.register(tournament.id, user.id)

        // Fabricate a second GAME_ENTRY transaction for the SAME tournament +
        // user, spent from a SOON-expiring lot, inserted SECOND.
        await prisma.$transaction((tx) =>
            BonusService.grant(tx, { userId: user.id, amount: 10, source: 'ADMIN', expiresAt: soonExpiry }),
        )
        await prisma.$transaction(async (tx) => {
            const spendResult = await BonusService.spend(tx, user.id, 10)
            await tx.transaction.create({
                data: {
                    userId: user.id,
                    type: TransactionType.GAME_ENTRY,
                    amount: 10,
                    status: PaymentStatus.APPROVED,
                    referenceId: tournament.id,
                    balanceBefore: 1000,
                    balanceAfter: 1000,
                    bonusBalanceBefore: spendResult.bonusBalanceBefore,
                    bonusBalanceAfter: spendResult.bonusBalanceAfter,
                    bonusExpiresAtSpend: spendResult.soonestExpiryConsumed,
                },
            })
        })

        // Sanity-check the setup actually produced two different stamped
        // expiries, with the later one inserted first — otherwise this test
        // proves nothing.
        const entryTxns = await prisma.transaction.findMany({
            where: { userId: user.id, type: TransactionType.GAME_ENTRY, referenceId: tournament.id },
            orderBy: { createdAt: 'asc' },
        })
        expect(entryTxns).toHaveLength(2)
        expect(entryTxns[0].bonusExpiresAtSpend?.getTime()).toBe(laterExpiry.getTime())
        expect(entryTxns[1].bonusExpiresAtSpend?.getTime()).toBe(soonExpiry.getTime())

        await TournamentService.cancel(tournament.id)

        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: user.id } })
        expect(Number(wallet.bonusBalance)).toBe(20)
        expect(Number(wallet.realBalance)).toBe(1000) // untouched — both entries were bonus-funded

        const activeLot = await prisma.bonusGrant.findFirstOrThrow({
            where: { userId: user.id, status: 'ACTIVE' },
        })
        // Must be the SOONER of the two — not the later one, and not whichever
        // an unordered query happened to return first.
        expect(activeLot.expiresAt?.getTime()).toBe(soonExpiry.getTime())
        expect(Number(activeLot.remaining)).toBe(20)
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
