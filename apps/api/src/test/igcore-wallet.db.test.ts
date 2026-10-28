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
import { emitProviderBet, emitProviderWin } from '../lib/posthog-events.js'
import { rootLogger } from '../lib/logger.js'
import { IgcoreWalletService, getIgcoreProviderId, resolveTicketRoot, type IgcoreCallbackBody } from '../services/igcore-wallet.service.js'

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

function result(user: { id: string }, transactionId: string, amount: number, info: IgcoreCallbackBody['info']): IgcoreCallbackBody {
    return { transaction_id: transactionId, action: 'result', user_id: pid(user), currency: 'ETB', amount, info }
}

async function winTxnsFor(userId: string) {
    return prisma.transaction.findMany({ where: { userId, type: 'TP_WIN' } })
}

/** `[igcore-fraud-flag]` lines logged through the root logger (getLogger() outside a request). */
function fraudFlags(warn: { mock: { calls: unknown[][] } }): string[] {
    return warn.mock.calls.map((c) => String(c[1] ?? '')).filter((msg) => msg.includes('[igcore-fraud-flag]'))
}

function rollback(
    user: { id: string },
    transactionId: string,
    original: string,
    opts: { action?: IgcoreCallbackBody['rollback_transaction_action']; ticketId?: number } = {},
): IgcoreCallbackBody {
    return {
        transaction_id: transactionId, action: 'rollback', user_id: pid(user), currency: 'ETB', amount: 0,
        rollback_transaction_id: original,
        ...(opts.action ? { rollback_transaction_action: opts.action } : {}),
        ...(opts.ticketId != null ? { info: { ticketId: opts.ticketId } } : {}),
    }
}

async function rollbackTxnsFor(userId: string) {
    return prisma.transaction.findMany({ where: { userId, type: 'TP_ROLLBACK' } })
}

/** The `[igcore-rollback-shortfall]` log calls, with their context objects. */
function shortfallLogs(warn: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
    return warn.mock.calls
        .filter((c) => String(c[1] ?? '').includes('[igcore-rollback-shortfall]'))
        .map((c) => c[0] as Record<string, unknown>)
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

describe('IgcoreWalletService results (real DB)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        vi.unstubAllEnvs()
        await expectInvariantClean()
    })

    it('result credits real even for a bonus-funded stake', async () => {
        const push = vi.spyOn(NotificationService, 'pushWalletUpdate')
        const user = await createPlayer({ real: 100, bonus: 50, spendAccount: 'BONUS' })
        await IgcoreWalletService.processBet(bet(user, 'res-bonus-bet', 20, 1))

        const out = await IgcoreWalletService.processResult(result(user, 'res-bonus-1', 50, { ticketId: 1 }))

        const rows = await rowsFor('res-bonus-1')
        expect(rows).toHaveLength(1)
        expect(out).toEqual({ kind: 'ok', transactionId: rows[0].id, userId: user.id })
        expect(rows[0]).toMatchObject({
            userId: user.id, type: 'BET_RESULT', status: 'COMPLETED', betId: '1', roundId: '1', gameCode: 'sportsbook', rawResponse: null,
        })
        expect(rows[0].winAmount!.toNumber()).toBe(50)
        expect(rows[0].amount.toNumber()).toBe(50)
        expect(rows[0].balanceBefore.toNumber()).toBe(130)
        expect(rows[0].balanceAfter.toNumber()).toBe(180)
        expect(rows[0].rawRequest).toMatchObject({ transaction_id: 'res-bonus-1', action: 'result', amount: 50 })

        const wallet = await walletOf(user.id)
        expect(wallet.realBalance.toNumber()).toBe(150)
        expect(wallet.bonusBalance.toNumber()).toBe(30)

        const wins = await winTxnsFor(user.id)
        expect(wins).toHaveLength(1)
        expect(wins[0]).toMatchObject({ referenceId: 'res-bonus-1', status: 'APPROVED', note: 'IGCORE sports win: ticket 1' })
        expect(wins[0].amount.toNumber()).toBe(50)
        expect(wins[0].balanceBefore!.toNumber()).toBe(130)
        expect(wins[0].balanceAfter!.toNumber()).toBe(180)
        expect(wins[0].bonusBalanceBefore!.toNumber()).toBe(30)
        expect(wins[0].bonusBalanceAfter!.toNumber()).toBe(30)

        expect(emitProviderWin).toHaveBeenCalledWith(user.id, {
            providerCode: 'igcore', gameCode: 'sportsbook', roundId: '1', betId: '1', amount: 50, roundStake: 20,
        })
        await vi.waitFor(() => expect(push).toHaveBeenCalledWith(user.id, 150, 30))
    })

    it('losing result is recorded and moves nothing', async () => {
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'res-lose-bet', 25, 2))

        const out = await IgcoreWalletService.processResult(result(user, 'res-lose-1', 0, { ticketId: 2 }))

        const rows = await rowsFor('res-lose-1')
        expect(rows).toHaveLength(1)
        expect(out).toEqual({ kind: 'ok', transactionId: rows[0].id, userId: user.id })
        expect(rows[0]).toMatchObject({ type: 'BET_RESULT', status: 'COMPLETED', betId: '2', roundId: '2' })
        expect(rows[0].amount.toNumber()).toBe(0)
        expect(rows[0].winAmount!.toNumber()).toBe(0)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(75)
        expect(await winTxnsFor(user.id)).toHaveLength(0)
        expect(emitProviderWin).not.toHaveBeenCalled()
    })

    it('duplicate result answers the same id', async () => {
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'res-dup-bet', 25, 3))
        const body = result(user, 'res-dup-1', 40, { ticketId: 3 })

        const first = await IgcoreWalletService.processResult(body)
        const second = await IgcoreWalletService.processResult(body)

        expect(first.kind).toBe('ok')
        expect(second).toEqual(first)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(115)
        expect(await rowsFor('res-dup-1')).toHaveLength(1)
        expect(await winTxnsFor(user.id)).toHaveLength(1)
        expect(emitProviderWin).toHaveBeenCalledTimes(1)
    })

    it('racing identical results apply once', async () => {
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'res-race-bet', 25, 4))
        const body = result(user, 'res-race-1', 40, { ticketId: 4 })

        const [a, b] = await Promise.all([IgcoreWalletService.processResult(body), IgcoreWalletService.processResult(body)])

        expect(a.kind).toBe('ok')
        expect(b).toEqual(a)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(115)
        expect(await rowsFor('res-race-1')).toHaveLength(1)
        expect(await winTxnsFor(user.id)).toHaveLength(1)
    })

    it('unknown player asks for a retry', async () => {
        const body = result({ id: randomBytes(16).toString('hex') }, 'res-ghost-1', 40, { ticketId: 5 })

        const out = await IgcoreWalletService.processResult(body)

        expect(out).toMatchObject({ kind: 'retry' })
        expect(await prisma.thirdPartyTransaction.count()).toBe(0)
    })

    it('a result in another currency, or with a malformed payout, asks for a retry', async () => {
        const user = await createPlayer({ real: 100 })

        const euro = await IgcoreWalletService.processResult({ ...result(user, 'res-eur-1', 40, { ticketId: 6 }), currency: 'EUR' })
        const negative = await IgcoreWalletService.processResult(result(user, 'res-neg-1', -5, { ticketId: 6 }))

        expect(euro).toMatchObject({ kind: 'retry' })
        expect(negative).toMatchObject({ kind: 'retry' })
        expect(await prisma.thirdPartyTransaction.count()).toBe(0)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(100)
    })

    it('result for a restricted player still pays', async () => {
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'res-restricted-bet', 25, 7))
        await prisma.user.update({ where: { id: user.id }, data: { accountStatus: 'RESTRICTED' } })

        const out = await IgcoreWalletService.processResult(result(user, 'res-restricted-1', 40, { ticketId: 7 }))

        expect(out.kind).toBe('ok')
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(115)
    })

    it('a result with no recorded bet is still paid and flagged', async () => {
        const warn = vi.spyOn(rootLogger, 'warn')
        const user = await createPlayer({ real: 100 })

        const out = await IgcoreWalletService.processResult(result(user, 'res-nobet-1', 40, { ticketId: 8 }))

        expect(out.kind).toBe('ok')
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(140)
        expect(fraudFlags(warn)).toEqual([expect.stringContaining('result with no recorded bet')])
    })

    it('a result transaction_id already used by another player asks for a retry', async () => {
        const warn = vi.spyOn(rootLogger, 'warn')
        const owner = await createPlayer({ real: 100 })
        const other = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(owner, 'res-shared-bet', 25, 9))
        await IgcoreWalletService.processResult(result(owner, 'res-shared-1', 40, { ticketId: 9 }))

        const out = await IgcoreWalletService.processResult(result(other, 'res-shared-1', 40, { ticketId: 9 }))

        expect(out).toMatchObject({ kind: 'retry' })
        expect((await walletOf(other.id)).realBalance.toNumber()).toBe(100)
        expect((await walletOf(owner.id)).realBalance.toNumber()).toBe(115)
        expect(await rowsFor('res-shared-1')).toHaveLength(1)
        expect(fraudFlags(warn)).toEqual([expect.stringContaining('another player')])
    })

    it('per-callback cap holds the payout', async () => {
        vi.stubEnv('IGCORE_MAX_WIN_AMOUNT', '100')
        const warn = vi.spyOn(rootLogger, 'warn')
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'cap-win-bet', 25, 10))
        const body = result(user, 'cap-win-1', 150, { ticketId: 10 })

        const out = await IgcoreWalletService.processResult(body)

        expect(out).toMatchObject({ kind: 'retry' })
        const rows = await rowsFor('cap-win-1')
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ type: 'BET_RESULT', status: 'FAILED', betId: '10', roundId: '10' })
        expect((rows[0].rawResponse as { held?: unknown }).held).toBe('CAP_EXCEEDED')
        expect(rows[0].amount.toNumber()).toBe(0)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(75)
        expect(fraudFlags(warn)).toHaveLength(1)

        const again = await IgcoreWalletService.processResult(body)

        expect(again).toMatchObject({ kind: 'retry' })
        expect(await rowsFor('cap-win-1')).toHaveLength(1)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(75)
        expect(await winTxnsFor(user.id)).toHaveLength(0)
        expect(emitProviderWin).not.toHaveBeenCalled()
    })

    it('raised cap releases a held payout once', async () => {
        vi.stubEnv('IGCORE_MAX_WIN_AMOUNT', '100')
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'cap-release-bet', 25, 11))
        const body = result(user, 'cap-release-1', 150, { ticketId: 11 })
        expect(await IgcoreWalletService.processResult(body)).toMatchObject({ kind: 'retry' })
        const [held] = await rowsFor('cap-release-1')

        vi.stubEnv('IGCORE_MAX_WIN_AMOUNT', '1000')
        const released = await IgcoreWalletService.processResult(body)

        expect(released).toEqual({ kind: 'ok', transactionId: held.id, userId: user.id })
        const rows = await rowsFor('cap-release-1')
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ id: held.id, type: 'BET_RESULT', status: 'COMPLETED', roundId: '11' })
        expect(rows[0].amount.toNumber()).toBe(150)
        expect(rows[0].winAmount!.toNumber()).toBe(150)
        expect((rows[0].rawResponse as { held?: unknown }).held).toBeUndefined()
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(225)
        expect(await winTxnsFor(user.id)).toHaveLength(1)

        const third = await IgcoreWalletService.processResult(body)

        expect(third).toEqual(released)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(225)
        expect(await rowsFor('cap-release-1')).toHaveLength(1)
        expect(await winTxnsFor(user.id)).toHaveLength(1)
        expect(emitProviderWin).toHaveBeenCalledTimes(1)
    })

    it('per-ticket cap sums across results', async () => {
        vi.stubEnv('IGCORE_MAX_TICKET_PAYOUT', '100')
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'cap-ticket-bet-a', 25, 12))
        await IgcoreWalletService.processBet(bet(user, 'cap-ticket-bet-b', 25, 13))

        const first = await IgcoreWalletService.processResult(result(user, 'cap-ticket-1', 60, { ticketId: 12 }))
        const second = await IgcoreWalletService.processResult(result(user, 'cap-ticket-2', 60, { ticketId: 12 }))
        const otherTicket = await IgcoreWalletService.processResult(result(user, 'cap-ticket-3', 60, { ticketId: 13 }))

        expect(first.kind).toBe('ok')
        expect(second).toMatchObject({ kind: 'retry' })
        expect(otherTicket.kind).toBe('ok')
        const [held] = await rowsFor('cap-ticket-2')
        expect(held).toMatchObject({ status: 'FAILED', roundId: '12' })
        expect((held.rawResponse as { held?: unknown }).held).toBe('CAP_EXCEEDED')
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(170)
    })

    it('a zero cap disables it', async () => {
        vi.stubEnv('IGCORE_MAX_WIN_AMOUNT', '0')
        vi.stubEnv('IGCORE_MAX_TICKET_PAYOUT', '0')
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'cap-off-bet', 25, 14))

        const out = await IgcoreWalletService.processResult(result(user, 'cap-off-1', 2_000_000, { ticketId: 14 }))

        expect(out.kind).toBe('ok')
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(2_000_075)
    })

    it('partial-cashout remainder shares the root', async () => {
        const warn = vi.spyOn(rootLogger, 'warn')
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'lineage-bet', 25, 10))

        const cashout = await IgcoreWalletService.processResult(
            result(user, 'lineage-cashout', 30, { ticketId: 10, newTicket: { id: 11, fromId: 10 } }),
        )
        const settle = await IgcoreWalletService.processResult(
            result(user, 'lineage-settle', 20, { ticketId: 11, ticket: { id: 11, fromId: 10 } }),
        )

        expect(cashout.kind).toBe('ok')
        expect(settle.kind).toBe('ok')
        const [cashoutRow] = await rowsFor('lineage-cashout')
        const [settleRow] = await rowsFor('lineage-settle')
        expect(cashoutRow).toMatchObject({ betId: '10', roundId: '10' })
        expect(settleRow).toMatchObject({ betId: '11', roundId: '10' })
        expect(fraudFlags(warn)).toEqual([])
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(125)
    })

    it('resolveTicketRoot follows a remainder of a remainder and falls back per the brief', async () => {
        const providerId = await getIgcoreProviderId()
        const user = await createPlayer({ real: 100 })
        const other = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'root-bet', 25, 40))
        await IgcoreWalletService.processResult(result(user, 'root-cashout-1', 10, { ticketId: 40, newTicket: { id: 41, fromId: 40 } }))
        await IgcoreWalletService.processResult(
            result(user, 'root-cashout-2', 10, { ticketId: 41, ticket: { id: 41, fromId: 40 }, newTicket: { id: 42, fromId: 41 } }),
        )

        const root = (b: IgcoreCallbackBody) => resolveTicketRoot(prisma, providerId, b)
        expect(await root(result(user, 'q-1', 5, { ticketId: 42, ticket: { id: 42, fromId: 41 } }))).toBe('40')
        expect(await root(result(user, 'q-2', 5, { ticketId: 50, ticket: { id: 50, fromId: 49 } }))).toBe('49')
        expect(await root(result(user, 'q-3', 5, { ticketId: 40 }))).toBe('40')
        expect(await root(result(user, 'q-4', 5, { ticketId: 51 }))).toBe('51')
        expect(await root(result(user, 'q-5', 5, undefined))).toBe('q-5')
        // Another player's rows never feed this player's lineage.
        expect(await root(result(other, 'q-6', 5, { ticketId: 42, ticket: { id: 42, fromId: 41 } }))).toBe('41')
    })

    it('a recorded shortfall is netted before crediting', async () => {
        // Task 5's short rollback writes a ROLLBACK row carrying the
        // shortfall; one is planted here so the netting is pinned now.
        const providerId = await getIgcoreProviderId()
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'net-bet', 25, 30))
        await prisma.thirdPartyTransaction.create({
            data: {
                providerId, userId: user.id, transactionId: 'net-rollback', betId: '30', roundId: '30', gameCode: 'sportsbook',
                type: 'ROLLBACK', status: 'COMPLETED', amount: -10, balanceBefore: 75, balanceAfter: 75,
                rawResponse: { shortfall: '52.5' },
            },
        })

        const corrected = await IgcoreWalletService.processResult(result(user, 'net-result-1', 50, { ticketId: 30 }))

        expect(corrected.kind).toBe('ok')
        const [correctedRow] = await rowsFor('net-result-1')
        expect(correctedRow).toMatchObject({ status: 'COMPLETED', roundId: '30', rawResponse: { netted: '50' } })
        expect(correctedRow.winAmount!.toNumber()).toBe(50)
        expect(correctedRow.amount.toNumber()).toBe(0)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(75)
        expect(await winTxnsFor(user.id)).toHaveLength(0)
        expect(emitProviderWin).not.toHaveBeenCalled()

        const further = await IgcoreWalletService.processResult(result(user, 'net-result-2', 10, { ticketId: 30 }))

        expect(further.kind).toBe('ok')
        const [furtherRow] = await rowsFor('net-result-2')
        expect(furtherRow).toMatchObject({ status: 'COMPLETED', rawResponse: { netted: '2.5' } })
        expect(furtherRow.winAmount!.toNumber()).toBe(10)
        expect(furtherRow.amount.toNumber()).toBe(7.5)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(82.5)
        const wins = await winTxnsFor(user.id)
        expect(wins).toHaveLength(1)
        expect(wins[0].amount.toNumber()).toBe(7.5)
        expect(emitProviderWin).toHaveBeenCalledWith(user.id, expect.objectContaining({ roundId: '30', amount: 7.5 }))
    })

    it('a rolled-back result gives its netted part back to the outstanding shortfall', async () => {
        // The netted part of a result that Task 5 later rolls back was never
        // paid out, so it must stop reducing what the player still owes.
        const providerId = await getIgcoreProviderId()
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'net-rb-bet', 25, 31))
        const planted = { providerId, userId: user.id, betId: '31', roundId: '31', gameCode: 'sportsbook', balanceBefore: 75, balanceAfter: 75 }
        await prisma.thirdPartyTransaction.create({
            data: { ...planted, transactionId: 'net-rb-rollback', type: 'ROLLBACK', status: 'COMPLETED', amount: 0, rawResponse: { shortfall: '30' } },
        })
        await prisma.thirdPartyTransaction.create({
            data: { ...planted, transactionId: 'net-rb-old', type: 'BET_RESULT', status: 'ROLLED_BACK', amount: 0, winAmount: 20, rawResponse: { netted: '20' } },
        })

        await IgcoreWalletService.processResult(result(user, 'net-rb-result', 40, { ticketId: 31 }))

        const [row] = await rowsFor('net-rb-result')
        expect(row).toMatchObject({ rawResponse: { netted: '30' } })
        expect(row.amount.toNumber()).toBe(10)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(85)
    })
})

describe('IgcoreWalletService rollbacks (real DB)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        vi.unstubAllEnvs()
        await expectInvariantClean()
    })

    it('rollback of a bet returns the stake', async () => {
        // No rollback_transaction_action: the kind comes from the stored row.
        const push = vi.spyOn(NotificationService, 'pushWalletUpdate')
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'rb-bet-1', 25, 1))
        const body = rollback(user, 'rb-1', 'rb-bet-1', { ticketId: 1 })

        const out = await IgcoreWalletService.processRollback(body)

        const rows = await rowsFor('rb-1')
        expect(rows).toHaveLength(1)
        expect(out).toEqual({ kind: 'ok', transactionId: rows[0].id, userId: user.id })
        expect(rows[0]).toMatchObject({
            userId: user.id, type: 'ROLLBACK', status: 'COMPLETED', betId: '1', roundId: '1', gameCode: 'sportsbook', rawResponse: null,
        })
        expect(rows[0].amount.toNumber()).toBe(25)
        expect(rows[0].balanceBefore.toNumber()).toBe(75)
        expect(rows[0].balanceAfter.toNumber()).toBe(100)
        expect(rows[0].rawRequest).toMatchObject({ transaction_id: 'rb-1', action: 'rollback', rollback_transaction_id: 'rb-bet-1' })
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(100)
        const [original] = await rowsFor('rb-bet-1')
        expect(original.status).toBe('ROLLED_BACK')

        const refunds = await rollbackTxnsFor(user.id)
        expect(refunds).toHaveLength(1)
        expect(refunds[0]).toMatchObject({ referenceId: 'rb-1', status: 'APPROVED', note: 'IGCORE sports bet rolled back: ticket 1' })
        expect(refunds[0].amount.toNumber()).toBe(25)
        expect(refunds[0].balanceBefore!.toNumber()).toBe(75)
        expect(refunds[0].balanceAfter!.toNumber()).toBe(100)
        await vi.waitFor(() => expect(push).toHaveBeenCalledWith(user.id, 100, 0))

        const again = await IgcoreWalletService.processRollback(body)

        expect(again).toEqual(out)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(100)
        expect(await rowsFor('rb-1')).toHaveLength(1)
        expect(await rollbackTxnsFor(user.id)).toHaveLength(1)
    })

    it('stake goes back to the account it came from', async () => {
        const user = await createPlayer({ real: 100, bonus: 50, spendAccount: 'BONUS' })
        await IgcoreWalletService.processBet(bet(user, 'rb-bonus-bet', 20, 2))
        await prisma.wallet.update({ where: { userId: user.id }, data: { spendAccount: 'REAL' } })

        const out = await IgcoreWalletService.processRollback(rollback(user, 'rb-bonus-1', 'rb-bonus-bet', { action: 'bet', ticketId: 2 }))

        expect(out.kind).toBe('ok')
        const wallet = await walletOf(user.id)
        expect(wallet.bonusBalance.toNumber()).toBe(50)
        expect(wallet.realBalance.toNumber()).toBe(100)
        const [row] = await rowsFor('rb-bonus-1')
        expect(row).toMatchObject({ type: 'ROLLBACK', status: 'COMPLETED', roundId: '2', rawResponse: null })
        expect(row.amount.toNumber()).toBe(20)
        expect(row.balanceBefore.toNumber()).toBe(130)
        expect(row.balanceAfter.toNumber()).toBe(150)
        const [refund] = await rollbackTxnsFor(user.id)
        expect(refund.amount.toNumber()).toBe(20)
        expect(refund.bonusBalanceBefore!.toNumber()).toBe(30)
        expect(refund.bonusBalanceAfter!.toNumber()).toBe(50)
    })

    it('rollback of a result then a corrected result', async () => {
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'rbr-bet', 25, 3))
        await IgcoreWalletService.processResult(result(user, 'rbr-res-1', 62.5, { ticketId: 3 }))
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(137.5)

        const out = await IgcoreWalletService.processRollback(rollback(user, 'rbr-rb-1', 'rbr-res-1', { action: 'result', ticketId: 3 }))

        const [row] = await rowsFor('rbr-rb-1')
        expect(out).toEqual({ kind: 'ok', transactionId: row.id, userId: user.id })
        expect(row).toMatchObject({ type: 'ROLLBACK', status: 'COMPLETED', betId: '3', roundId: '3', rawResponse: null })
        expect(row.amount.toNumber()).toBe(-62.5)
        expect(row.balanceBefore.toNumber()).toBe(137.5)
        expect(row.balanceAfter.toNumber()).toBe(75)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(75)
        const [original] = await rowsFor('rbr-res-1')
        expect(original.status).toBe('ROLLED_BACK')
        const reversals = await rollbackTxnsFor(user.id)
        expect(reversals).toHaveLength(1)
        expect(reversals[0]).toMatchObject({ referenceId: 'rbr-rb-1', status: 'APPROVED', note: 'IGCORE sports win reversed: ticket 3' })
        expect(reversals[0].amount.toNumber()).toBe(62.5)
        expect(reversals[0].balanceBefore!.toNumber()).toBe(137.5)
        expect(reversals[0].balanceAfter!.toNumber()).toBe(75)

        const corrected = await IgcoreWalletService.processResult(result(user, 'rbr-res-2', 50, { ticketId: 3 }))

        expect(corrected.kind).toBe('ok')
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(125)
    })

    it('short rollback records the shortfall and nets the next result', async () => {
        const warn = vi.spyOn(rootLogger, 'warn')
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'rbs-bet', 25, 4))
        await IgcoreWalletService.processResult(result(user, 'rbs-res-1', 62.5, { ticketId: 4 }))
        await prisma.wallet.update({ where: { userId: user.id }, data: { realBalance: 10 } }) // the player withdrew

        const out = await IgcoreWalletService.processRollback(rollback(user, 'rbs-rb-1', 'rbs-res-1', { action: 'result', ticketId: 4 }))

        expect(out.kind).toBe('ok')
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(0)
        const [row] = await rowsFor('rbs-rb-1')
        expect(row).toMatchObject({ type: 'ROLLBACK', status: 'COMPLETED', roundId: '4', rawResponse: { shortfall: '52.5' } })
        expect(row.amount.toNumber()).toBe(-10)
        const [reversal] = await rollbackTxnsFor(user.id)
        expect(reversal.amount.toNumber()).toBe(10)
        expect(shortfallLogs(warn)).toEqual([expect.objectContaining({ shortfall: '52.5', rowId: row.id })])

        const corrected = await IgcoreWalletService.processResult(result(user, 'rbs-res-2', 50, { ticketId: 4 }))

        expect(corrected.kind).toBe('ok')
        const [correctedRow] = await rowsFor('rbs-res-2')
        expect(correctedRow.amount.toNumber()).toBe(0)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(0)

        const further = await IgcoreWalletService.processResult(result(user, 'rbs-res-3', 10, { ticketId: 4 }))

        expect(further.kind).toBe('ok')
        const [furtherRow] = await rowsFor('rbs-res-3')
        expect(furtherRow.amount.toNumber()).toBe(7.5)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(7.5)
    })

    it('a result rollback against an empty real balance takes nothing and records the whole payout as owed', async () => {
        const warn = vi.spyOn(rootLogger, 'warn')
        const user = await createPlayer({ real: 100, bonus: 40 })
        await IgcoreWalletService.processBet(bet(user, 'rbe-bet', 25, 5))
        await IgcoreWalletService.processResult(result(user, 'rbe-res', 30, { ticketId: 5 }))
        await prisma.wallet.update({ where: { userId: user.id }, data: { realBalance: 0 } })

        const out = await IgcoreWalletService.processRollback(rollback(user, 'rbe-rb', 'rbe-res', { action: 'result', ticketId: 5 }))

        expect(out.kind).toBe('ok')
        const wallet = await walletOf(user.id)
        expect(wallet.realBalance.toNumber()).toBe(0)
        expect(wallet.bonusBalance.toNumber()).toBe(40) // never taken from bonus
        const [row] = await rowsFor('rbe-rb')
        expect(row).toMatchObject({ roundId: '5', rawResponse: { shortfall: '30' } })
        expect(row.amount.toNumber()).toBe(0)
        expect(await rollbackTxnsFor(user.id)).toHaveLength(0)
        expect((await rowsFor('rbe-res'))[0].status).toBe('ROLLED_BACK')
        expect(shortfallLogs(warn)).toHaveLength(1)
    })

    it('unknown original writes two records and moves nothing', async () => {
        const user = await createPlayer({ real: 100 })

        const out = await IgcoreWalletService.processRollback(rollback(user, 'rbu-1', 'never-seen', { action: 'bet', ticketId: 6 }))

        const [row] = await rowsFor('rbu-1')
        expect(out).toEqual({ kind: 'ok', transactionId: row.id, userId: user.id })
        expect(row).toMatchObject({ userId: user.id, type: 'ROLLBACK', status: 'COMPLETED', roundId: '6', rawResponse: null })
        expect(row.amount.toNumber()).toBe(0)
        const placeholders = await rowsFor('never-seen')
        expect(placeholders).toHaveLength(1)
        expect(placeholders[0]).toMatchObject({
            userId: user.id, type: 'BET', status: 'ROLLED_BACK', betId: '6', roundId: '6', gameCode: 'sportsbook', rawResponse: { placeholder: true },
        })
        expect(placeholders[0].amount.toNumber()).toBe(0)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(100)
        expect(await rollbackTxnsFor(user.id)).toHaveLength(0)

        const late = await IgcoreWalletService.processBet(bet(user, 'never-seen', 25, 6))

        expect(late).toEqual({ kind: 'ok', transactionId: placeholders[0].id, userId: user.id })
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(100)
        expect(await rowsFor('never-seen')).toHaveLength(1)
        expect(await betTxnsFor(user.id)).toHaveLength(0)
    })

    it('a placeholder takes the type the rollback names, and a late result is not paid', async () => {
        const user = await createPlayer({ real: 100 })

        const asResult = await IgcoreWalletService.dispatch('transaction-rollback', rollback(user, 'rbp-1', 'rbp-orig-1', { action: 'result', ticketId: 7 }))
        await IgcoreWalletService.processRollback(rollback(user, 'rbp-2', 'rbp-orig-2', { ticketId: 7 }))
        await IgcoreWalletService.processRollback(rollback(user, 'rbp-3', 'rbp-orig-3', { action: 'freebet', ticketId: 7 }))

        expect(asResult.kind).toBe('ok')
        expect((await rowsFor('rbp-orig-1'))[0]).toMatchObject({ type: 'BET_RESULT', status: 'ROLLED_BACK' })
        expect((await rowsFor('rbp-orig-2'))[0]).toMatchObject({ type: 'ROLLBACK', status: 'ROLLED_BACK' })
        expect((await rowsFor('rbp-orig-3'))[0]).toMatchObject({ type: 'BET', status: 'ROLLED_BACK' })

        const [placeholder] = await rowsFor('rbp-orig-1')
        const late = await IgcoreWalletService.processResult(result(user, 'rbp-orig-1', 40, { ticketId: 7 }))

        expect(late).toEqual({ kind: 'ok', transactionId: placeholder.id, userId: user.id })
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(100)
        expect(await winTxnsFor(user.id)).toHaveLength(0)
    })

    it('rollback of a held result retires it', async () => {
        vi.stubEnv('IGCORE_MAX_WIN_AMOUNT', '100')
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'rbh-bet', 25, 8))
        const held = result(user, 'rbh-res', 150, { ticketId: 8 })
        expect(await IgcoreWalletService.processResult(held)).toMatchObject({ kind: 'retry' })
        const [heldRow] = await rowsFor('rbh-res')

        const out = await IgcoreWalletService.processRollback(rollback(user, 'rbh-rb', 'rbh-res', { action: 'result', ticketId: 8 }))

        const [row] = await rowsFor('rbh-rb')
        expect(out).toEqual({ kind: 'ok', transactionId: row.id, userId: user.id })
        expect(row.amount.toNumber()).toBe(0)
        expect(row.rawResponse).toBeNull()
        expect((await rowsFor('rbh-res'))[0]).toMatchObject({ id: heldRow.id, status: 'ROLLED_BACK' })
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(75)
        expect(await rollbackTxnsFor(user.id)).toHaveLength(0)

        vi.stubEnv('IGCORE_MAX_WIN_AMOUNT', '1000')
        const resent = await IgcoreWalletService.processResult(held)

        expect(resent).toEqual({ kind: 'ok', transactionId: heldRow.id, userId: user.id })
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(75)
        expect(await winTxnsFor(user.id)).toHaveLength(0)
        expect(emitProviderWin).not.toHaveBeenCalled()
    })

    it('a refused or already rolled-back original moves nothing', async () => {
        const user = await createPlayer({ real: 10 })
        expect(await IgcoreWalletService.processBet(bet(user, 'rbf-bet', 25, 9))).toMatchObject({ kind: 'reject' })

        const refused = await IgcoreWalletService.processRollback(rollback(user, 'rbf-rb-1', 'rbf-bet', { action: 'bet', ticketId: 9 }))

        expect(refused.kind).toBe('ok')
        const [refusedRow] = await rowsFor('rbf-rb-1')
        expect(refusedRow).toMatchObject({ type: 'ROLLBACK', status: 'COMPLETED', roundId: '9' })
        expect(refusedRow.amount.toNumber()).toBe(0)
        // The refusal stands, so a replayed bet still repeats it.
        expect((await rowsFor('rbf-bet'))[0].status).toBe('FAILED')
        expect(await IgcoreWalletService.processBet(bet(user, 'rbf-bet', 25, 9))).toEqual({ kind: 'reject', error: 'INSUFFICIENT_FUNDS' })
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(10)

        await prisma.wallet.update({ where: { userId: user.id }, data: { realBalance: 100 } })
        await IgcoreWalletService.processBet(bet(user, 'rbf-bet-2', 25, 10))
        await IgcoreWalletService.processRollback(rollback(user, 'rbf-rb-2', 'rbf-bet-2', { action: 'bet', ticketId: 10 }))
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(100)

        const second = await IgcoreWalletService.processRollback(rollback(user, 'rbf-rb-3', 'rbf-bet-2', { action: 'bet', ticketId: 10 }))

        const [secondRow] = await rowsFor('rbf-rb-3')
        expect(second).toEqual({ kind: 'ok', transactionId: secondRow.id, userId: user.id })
        expect(secondRow.amount.toNumber()).toBe(0)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(100)
        expect(await rollbackTxnsFor(user.id)).toHaveLength(1)
    })

    it('a rollback naming another player\'s transaction moves nothing and writes no placeholder', async () => {
        const warn = vi.spyOn(rootLogger, 'warn')
        const owner = await createPlayer({ real: 100 })
        const other = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(owner, 'rbx-bet', 25, 11))

        const out = await IgcoreWalletService.processRollback(rollback(other, 'rbx-rb', 'rbx-bet', { action: 'bet', ticketId: 11 }))

        const rows = await rowsFor('rbx-rb')
        expect(rows).toHaveLength(1)
        expect(out).toEqual({ kind: 'ok', transactionId: rows[0].id, userId: other.id })
        expect(rows[0]).toMatchObject({ userId: other.id, type: 'ROLLBACK', status: 'COMPLETED', roundId: '11', rawResponse: null })
        expect(rows[0].amount.toNumber()).toBe(0)
        const originals = await rowsFor('rbx-bet')
        expect(originals).toHaveLength(1)
        expect(originals[0]).toMatchObject({ userId: owner.id, status: 'COMPLETED' })
        expect((await walletOf(owner.id)).realBalance.toNumber()).toBe(75)
        expect((await walletOf(other.id)).realBalance.toNumber()).toBe(100)
        expect(await prisma.transaction.count({ where: { type: 'TP_ROLLBACK' } })).toBe(0)
        expect(fraudFlags(warn)).toHaveLength(1)
    })

    it('a rollback whose action disagrees with the stored row asks for a retry', async () => {
        const warn = vi.spyOn(rootLogger, 'warn')
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'rbk-bet', 25, 12))

        const out = await IgcoreWalletService.processRollback(rollback(user, 'rbk-rb', 'rbk-bet', { action: 'result', ticketId: 12 }))

        expect(out).toMatchObject({ kind: 'retry' })
        expect(await rowsFor('rbk-rb')).toHaveLength(0)
        expect((await rowsFor('rbk-bet'))[0].status).toBe('COMPLETED')
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(75)
        expect(fraudFlags(warn)).toHaveLength(1)
    })

    it('a rollback that cannot be handled asks for a retry', async () => {
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'rbq-bet', 25, 13))
        const ghost = { id: randomBytes(16).toString('hex') }

        const unknownPlayer = await IgcoreWalletService.processRollback(rollback(ghost, 'rbq-1', 'rbq-bet', { action: 'bet' }))
        const noOriginal = await IgcoreWalletService.processRollback({ ...rollback(user, 'rbq-2', 'rbq-bet'), rollback_transaction_id: undefined })
        const badAction = await IgcoreWalletService.processRollback({
            ...rollback(user, 'rbq-3', 'rbq-bet'), rollback_transaction_action: 'cashout' as unknown as 'bet',
        })

        expect(unknownPlayer).toMatchObject({ kind: 'retry' })
        expect(noOriginal).toMatchObject({ kind: 'retry' })
        expect(badAction).toMatchObject({ kind: 'retry' })
        expect(await prisma.thirdPartyTransaction.count({ where: { type: 'ROLLBACK' } })).toBe(0)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(75)
    })

    it('racing identical rollbacks apply once', async () => {
        const user = await createPlayer({ real: 100 })
        await IgcoreWalletService.processBet(bet(user, 'rbc-bet', 25, 14))
        const body = rollback(user, 'rbc-rb', 'rbc-bet', { action: 'bet', ticketId: 14 })

        const [a, b] = await Promise.all([IgcoreWalletService.processRollback(body), IgcoreWalletService.processRollback(body)])

        expect(a.kind).toBe('ok')
        expect(b).toEqual(a)
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(100)
        expect(await rowsFor('rbc-rb')).toHaveLength(1)
        expect(await rollbackTxnsFor(user.id)).toHaveLength(1)
    })

    it('a racer that takes the placeholder key first is resolved by the immediate retry', async () => {
        // lockedOnce re-reads only the rollback's own key after a P2002. Here
        // the collision is on the placeholder key instead: another player's
        // bet row lands at rollback_transaction_id while ours is uncommitted.
        // The first answer is a retry (nothing written), and IGCORE's re-send
        // then finds the other player's row and takes the R4 path.
        const warn = vi.spyOn(rootLogger, 'warn')
        const user = await createPlayer({ real: 100 })
        const other = await createPlayer({ real: 100 })
        const providerId = await getIgcoreProviderId()
        let inserted!: () => void
        let release!: () => void
        const insertedSignal = new Promise<void>((r) => { inserted = r })
        const releaseSignal = new Promise<void>((r) => { release = r })

        const racer = prisma.$transaction(async (tx) => {
            const row = await tx.thirdPartyTransaction.create({
                data: {
                    providerId, userId: other.id, transactionId: 'rbz-orig', type: 'BET', status: 'COMPLETED',
                    betAmount: 25, amount: -25, balanceBefore: 100, balanceAfter: 100, roundId: '15', gameCode: 'sportsbook',
                },
            })
            inserted()
            await releaseSignal
            return row
        }, { timeout: 15_000 })
        await insertedSignal

        const body = rollback(user, 'rbz-rb', 'rbz-orig', { action: 'bet', ticketId: 15 })
        const pending = IgcoreWalletService.processRollback(body)
        await vi.waitFor(async () => {
            const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
                SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted
            `
            expect(n).toBeGreaterThan(0)
        }, { timeout: 4_000, interval: 25 })
        release()
        const racerRow = await racer

        const first = await pending

        expect(first).toMatchObject({ kind: 'retry' })
        expect(await rowsFor('rbz-rb')).toHaveLength(0)

        const again = await IgcoreWalletService.processRollback(body)

        const [row] = await rowsFor('rbz-rb')
        expect(again).toEqual({ kind: 'ok', transactionId: row.id, userId: user.id })
        expect(row.amount.toNumber()).toBe(0)
        expect(await rowsFor('rbz-orig')).toEqual([expect.objectContaining({ id: racerRow.id, userId: other.id, status: 'COMPLETED' })])
        expect((await walletOf(user.id)).realBalance.toNumber()).toBe(100)
        expect((await walletOf(other.id)).realBalance.toNumber()).toBe(100)
        expect(fraudFlags(warn)).toHaveLength(1)
    })
})
