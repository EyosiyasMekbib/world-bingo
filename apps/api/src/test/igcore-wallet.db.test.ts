import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Redis is not running in this environment. `resolveUser` reads/writes the
// `tp:user:igcore:` cache through it; mock it like
// palace-wallet-settlement.db.test.ts so every lookup falls through to the DB.
vi.mock('../lib/redis.js', () => ({ default: { get: vi.fn().mockResolvedValue(null), setex: vi.fn() } }))
vi.mock('../lib/posthog-events.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/posthog-events.js')>()),
    emitProviderBet: vi.fn(),
    emitProviderWin: vi.fn(),
}))

import { randomBytes } from 'node:crypto'
import { prisma, expectInvariantClean } from './setup'
import { BonusService } from '../services/bonus.service'
import { NotificationService } from '../services/notification.service'
import { emitProviderBet } from '../lib/posthog-events.js'
import { IgcoreWalletService, getIgcoreProviderId, type IgcoreCallbackBody } from '../services/igcore-wallet.service.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────
// `setup.ts` wipes users/wallets/bonus lots/thirdPartyTransactions/
// transactions after every test, but NOT gameProviders, so the `igcore`
// provider row the service upserts on first use persists across tests.

let seq = 0

async function createPlayer(opts: {
    real: number
    bonus?: number
    spendAccount?: 'REAL' | 'BONUS'
    status?: 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED'
}) {
    seq += 1
    const user = await prisma.user.create({
        data: {
            username: `igc-${seq}`,
            phone: `+2517${String(10_000_000 + seq)}`,
            passwordHash: 'x',
            accountStatus: opts.status ?? 'ACTIVE',
            wallet: { create: { realBalance: opts.real } },
        },
    })
    if (opts.bonus) {
        const amount = opts.bonus
        await prisma.$transaction((tx) => BonusService.grant(tx, { userId: user.id, amount, source: 'ADMIN' }))
    }
    if (opts.spendAccount) {
        await prisma.wallet.update({ where: { userId: user.id }, data: { spendAccount: opts.spendAccount } })
    }
    return user
}

/** The bare 32-hex player id IGCORE knows the player by. */
function pid(user: { id: string }): string {
    return user.id.replace(/-/g, '')
}

function bet(user: { id: string }, transactionId: string, amount: number, ticketId: number): IgcoreCallbackBody {
    return { transaction_id: transactionId, action: 'bet', user_id: pid(user), currency: 'ETB', amount, info: { ticketId } }
}

async function walletOf(userId: string) {
    return prisma.wallet.findUniqueOrThrow({ where: { userId } })
}

async function rowsFor(transactionId: string) {
    const providerId = await getIgcoreProviderId()
    return prisma.thirdPartyTransaction.findMany({ where: { providerId, transactionId } })
}

async function betTxnsFor(userId: string) {
    return prisma.transaction.findMany({ where: { userId, type: 'TP_BET' } })
}

describe('IgcoreWalletService bets (real DB)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await expectInvariantClean()
    })

    it('bet debits the selected REAL balance once', async () => {
        const push = vi.spyOn(NotificationService, 'pushWalletUpdate')
        const user = await createPlayer({ real: 100 })

        const out = await IgcoreWalletService.processBet(bet(user, 'bet-real-1', 25, 1))

        expect(out.kind).toBe('ok')
        const rows = await rowsFor('bet-real-1')
        expect(rows).toHaveLength(1)
        expect(out).toEqual({ kind: 'ok', transactionId: rows[0].id, userId: user.id })
        expect(rows[0]).toMatchObject({ userId: user.id, type: 'BET', status: 'COMPLETED', betId: '1', roundId: '1', gameCode: 'sportsbook' })
        expect(rows[0].amount.toNumber()).toBe(-25)
        expect(rows[0].betAmount!.toNumber()).toBe(25)
        expect(rows[0].balanceBefore.toNumber()).toBe(100)
        expect(rows[0].balanceAfter.toNumber()).toBe(75)
        expect(rows[0].rawRequest).toMatchObject({ transaction_id: 'bet-real-1', action: 'bet', amount: 25 })

        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(75)

        const txns = await betTxnsFor(user.id)
        expect(txns).toHaveLength(1)
        expect(txns[0]).toMatchObject({ referenceId: 'bet-real-1', status: 'APPROVED', note: 'IGCORE sports bet: ticket 1' })
        expect(txns[0].amount.toNumber()).toBe(25)
        expect(txns[0].balanceBefore!.toNumber()).toBe(100)
        expect(txns[0].balanceAfter!.toNumber()).toBe(75)

        expect(emitProviderBet).toHaveBeenCalledWith(user.id, {
            providerCode: 'igcore', gameCode: 'sportsbook', roundId: '1', betId: '1', amount: 25, spendAccount: 'REAL',
        })
        await vi.waitFor(() => expect(push).toHaveBeenCalledWith(user.id, 75, 0))
    })

    it('bet spends bonus when the toggle says BONUS', async () => {
        const user = await createPlayer({ real: 100, bonus: 50, spendAccount: 'BONUS' })

        const out = await IgcoreWalletService.processBet(bet(user, 'bet-bonus-1', 20, 2))

        expect(out.kind).toBe('ok')
        const wallet = await walletOf(user.id)
        expect(wallet.bonusBalance.toNumber()).toBe(30)
        expect(wallet.realBalance.toNumber()).toBe(100)

        const [txn] = await betTxnsFor(user.id)
        expect(txn.bonusBalanceBefore!.toNumber()).toBe(50)
        expect(txn.bonusBalanceAfter!.toNumber()).toBe(30)
        expect(txn.bonusExpiresAtSpend).toBeNull() // the ADMIN lot has no expiry
        expect(emitProviderBet).toHaveBeenCalledWith(user.id, expect.objectContaining({ spendAccount: 'BONUS', amount: 20 }))
    })

    it('a BONUS stake larger than the bonus balance is refused even when real covers it', async () => {
        const user = await createPlayer({ real: 100, bonus: 10, spendAccount: 'BONUS' })

        const out = await IgcoreWalletService.processBet(bet(user, 'bet-bonus-short', 25, 3))

        expect(out).toEqual({ kind: 'reject', error: 'INSUFFICIENT_FUNDS' })
        const wallet = await walletOf(user.id)
        expect(wallet.bonusBalance.toNumber()).toBe(10)
        expect(wallet.realBalance.toNumber()).toBe(100)
    })

    it('insufficient funds rejects and leaves the balance', async () => {
        const user = await createPlayer({ real: 10 })

        const out = await IgcoreWalletService.processBet(bet(user, 'bet-short-1', 25, 4))

        expect(out).toEqual({ kind: 'reject', error: 'INSUFFICIENT_FUNDS' })
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(10)
        const rows = await rowsFor('bet-short-1')
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ type: 'BET', status: 'FAILED', rawResponse: { error: 'INSUFFICIENT_FUNDS' } })
        expect(rows[0].amount.toNumber()).toBe(0)
        expect(rows[0].betAmount!.toNumber()).toBe(25)

        const again = await IgcoreWalletService.processBet(bet(user, 'bet-short-1', 25, 4))

        expect(again).toEqual({ kind: 'reject', error: 'INSUFFICIENT_FUNDS' })
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(10)
        expect(await rowsFor('bet-short-1')).toHaveLength(1)
        expect(await betTxnsFor(user.id)).toHaveLength(0)
        expect(emitProviderBet).not.toHaveBeenCalled()
    })

    it('unknown player rejects without a record', async () => {
        const body = bet({ id: randomBytes(16).toString('hex') }, 'bet-ghost-1', 25, 5)

        const out = await IgcoreWalletService.processBet(body)

        expect(out).toEqual({ kind: 'reject', error: 'PLAYER_NOT_FOUND' })
        expect(await prisma.thirdPartyTransaction.count()).toBe(0)
    })

    it('restricted and wrong-currency players are rejected', async () => {
        const restricted = await createPlayer({ real: 100, status: 'RESTRICTED' })
        const active = await createPlayer({ real: 100 })

        const blocked = await IgcoreWalletService.processBet(bet(restricted, 'bet-restricted-1', 25, 6))
        const euro = await IgcoreWalletService.processBet({ ...bet(active, 'bet-eur-1', 25, 7), currency: 'EUR' })

        expect(blocked).toEqual({ kind: 'reject', error: 'ACCOUNT_RESTRICTED' })
        expect(euro).toEqual({ kind: 'reject', error: 'CURRENCY_NOT_SUPPORTED' })
        expect((await walletOf(restricted.id)).realBalance.toNumber()).toBe(100)
        expect((await walletOf(active.id)).realBalance.toNumber()).toBe(100)
        expect(await prisma.thirdPartyTransaction.count()).toBe(0)
    })

    it('duplicate bet answers the same id and moves nothing', async () => {
        const user = await createPlayer({ real: 100 })
        const first = await IgcoreWalletService.processBet(bet(user, 'bet-dup-1', 25, 8))

        const second = await IgcoreWalletService.processBet(bet(user, 'bet-dup-1', 25, 8))

        expect(first.kind).toBe('ok')
        expect(second).toEqual(first)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(75)
        expect(await rowsFor('bet-dup-1')).toHaveLength(1)
        expect(await betTxnsFor(user.id)).toHaveLength(1)
        expect(emitProviderBet).toHaveBeenCalledTimes(1)
    })

    it('a replayed bet keeps its answer after the player is restricted', async () => {
        // A stake already taken must keep answering success: answering the
        // replay ACCOUNT_RESTRICTED would tell IGCORE the ticket never placed
        // while the money stays debited.
        const user = await createPlayer({ real: 100 })
        const first = await IgcoreWalletService.processBet(bet(user, 'bet-replay-1', 25, 9))
        await prisma.user.update({ where: { id: user.id }, data: { accountStatus: 'RESTRICTED' } })

        const replay = await IgcoreWalletService.processBet(bet(user, 'bet-replay-1', 25, 9))

        expect(replay).toEqual(first)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(75)
    })

    it('concurrent bets for one player serialise', async () => {
        const user = await createPlayer({ real: 100 })

        const outs = await Promise.all([
            IgcoreWalletService.processBet(bet(user, 'bet-conc-a', 60, 10)),
            IgcoreWalletService.processBet(bet(user, 'bet-conc-b', 60, 11)),
        ])

        expect(outs.filter((o) => o.kind === 'ok')).toHaveLength(1)
        expect(outs.filter((o) => o.kind === 'reject' && o.error === 'INSUFFICIENT_FUNDS')).toHaveLength(1)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(40)
        expect(await betTxnsFor(user.id)).toHaveLength(1)
    })

    it('racing identical bets apply once', async () => {
        const user = await createPlayer({ real: 100 })
        const body = bet(user, 'bet-race-1', 25, 12)

        const [a, b] = await Promise.all([IgcoreWalletService.processBet(body), IgcoreWalletService.processBet(body)])

        expect(a.kind).toBe('ok')
        expect(b).toEqual(a)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(75)
        expect(await rowsFor('bet-race-1')).toHaveLength(1)
        expect(await betTxnsFor(user.id)).toHaveLength(1)
    })

    it('a racer that inserts the key first is answered as a duplicate, and our debit is rolled back', async () => {
        // Forces the P2002 path deterministically. A separate transaction
        // inserts the row for this transaction_id and holds it uncommitted, so
        // neither the pre-check nor the re-check under the wallet lock can see
        // it. The service debits, then its insert blocks on the uncommitted
        // key; once the racer commits, the insert fails with P2002, which must
        // roll back the debit and answer with the racer's row.
        const user = await createPlayer({ real: 100 })
        const providerId = await getIgcoreProviderId()
        let inserted!: () => void
        let release!: () => void
        const insertedSignal = new Promise<void>((r) => { inserted = r })
        const releaseSignal = new Promise<void>((r) => { release = r })

        const racer = prisma.$transaction(async (tx) => {
            const row = await tx.thirdPartyTransaction.create({
                data: {
                    providerId, userId: user.id, transactionId: 'bet-p2002-1', type: 'BET', status: 'COMPLETED',
                    betAmount: 25, amount: -25, balanceBefore: 100, balanceAfter: 100, roundId: '13', gameCode: 'sportsbook',
                },
            })
            inserted()
            await releaseSignal
            return row
        }, { timeout: 15_000 })
        await insertedSignal

        const pending = IgcoreWalletService.processBet(bet(user, 'bet-p2002-1', 25, 13))
        await vi.waitFor(async () => {
            const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
                SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted
            `
            expect(n).toBeGreaterThan(0)
        }, { timeout: 4_000, interval: 25 })
        release()
        const racerRow = await racer

        const out = await pending

        expect(out).toEqual({ kind: 'ok', transactionId: racerRow.id, userId: user.id })
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(100)
        expect(await rowsFor('bet-p2002-1')).toHaveLength(1)
        expect(await betTxnsFor(user.id)).toHaveLength(0)
        expect(emitProviderBet).not.toHaveBeenCalled()
    })

    it('a transaction_id already used by another player is not answered as theirs', async () => {
        const owner = await createPlayer({ real: 100 })
        const other = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(owner, 'bet-shared-1', 25, 14))

        const out = await IgcoreWalletService.processBet(bet(other, 'bet-shared-1', 25, 14))

        expect(out.kind).toBe('retry')
        expect((await walletOf(other.id)).realBalance.toNumber()).toBe(100)
        expect((await walletOf(owner.id)).realBalance.toNumber()).toBe(75)
    })

    it('freebet is refused', async () => {
        const user = await createPlayer({ real: 100 })

        const out = await IgcoreWalletService.processFreebet({ ...bet(user, 'freebet-1', 25, 15), action: 'freebet' })

        expect(out).toEqual({ kind: 'reject', error: 'FREEBETS_NOT_ENABLED' })
        expect(await prisma.thirdPartyTransaction.count()).toBe(0)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(100)
    })

    it('dispatch routes each endpoint and action pairing', async () => {
        const user = await createPlayer({ real: 100 })

        const placed = await IgcoreWalletService.dispatch('transaction', bet(user, 'bet-dispatch-1', 25, 16))
        const freebet = await IgcoreWalletService.dispatch('transaction', { ...bet(user, 'fb-dispatch-1', 25, 17), action: 'freebet' })
        const rollbackOnTransaction = await IgcoreWalletService.dispatch('transaction', { ...bet(user, 'rb-dispatch-1', 25, 18), action: 'rollback' })
        const betOnRollback = await IgcoreWalletService.dispatch('transaction-rollback', bet(user, 'bet-dispatch-2', 25, 19))

        expect(placed.kind).toBe('ok')
        expect(freebet).toEqual({ kind: 'reject', error: 'FREEBETS_NOT_ENABLED' })
        expect(rollbackOnTransaction).toEqual({ kind: 'reject', error: 'UNKNOWN_ACTION' })
        expect(betOnRollback).toEqual({ kind: 'reject', error: 'UNKNOWN_ACTION' })
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(75)
    })

    it('getIgcoreProviderId keeps the provider row INACTIVE and out of the lobby', async () => {
        const id = await getIgcoreProviderId()

        const row = await prisma.gameProvider.findUniqueOrThrow({ where: { code: 'igcore' } })
        expect(row.id).toBe(id)
        expect(row).toMatchObject({ name: 'IGCORE Sportsbook', status: 'INACTIVE', currency: 'ETB', config: { kind: 'sportsbook' } })
        expect(await getIgcoreProviderId()).toBe(id)
    })
})
