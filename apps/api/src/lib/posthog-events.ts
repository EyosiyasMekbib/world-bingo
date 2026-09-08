/**
 * Typed PostHog emitters for the events that need a read or a fan-out before
 * they can be captured. Services call these post-commit as `void emitX(...)`.
 * Everything here is fire-and-forget and never throws — see lib/posthog.ts.
 *
 * Pure helpers (hoursBetween, withdrawalMethodFromNote, personPropsFor,
 * gameOutcomeEvents) are exported for unit tests and for the backfill mappers.
 */
import prisma from './prisma'
import { captureEvent } from './posthog'
import { rootLogger } from './logger'

/**
 * Null when the start is unknown: property maths runs before captureEvent's
 * try/catch, so this must never throw — a settle path with no `createdAt` on
 * the row (as one worker test constructs) would otherwise fail the request.
 */
export function hoursBetween(from: Date | null | undefined, to: Date): number | null {
    if (!(from instanceof Date) || Number.isNaN(from.getTime())) return null
    const hours = (to.getTime() - from.getTime()) / 3_600_000
    return Math.max(0, Math.round(hours * 100) / 100)
}

/**
 * requestWithdrawal writes `"<method>: <account>"` into `note`. Return the
 * method only. A reviewer's rejection note replaces that text, so anything
 * that does not match the shape yields null rather than a guess.
 */
export function withdrawalMethodFromNote(note: string | null | undefined): string | null {
    if (!note) return null
    const match = /^([a-z0-9_-]+):\s*\S+/i.exec(note)
    return match ? match[1].toLowerCase() : null
}

export function personPropsFor(
    user: { serial: number; createdAt: Date; referredById: string | null },
    signupMethod: 'phone' | 'telegram',
): Record<string, unknown> {
    return {
        serial: user.serial,
        signup_method: signupMethod,
        referred: user.referredById !== null,
        created_at: user.createdAt.toISOString(),
    }
}

export interface GameOutcomeInput {
    gameId: string
    templateId: string | null
    ticketPrice: number
    winnerId: string | null
    prize: number
    durationSecs: number | null
    entrants: Array<{ userId: string; cartelas: number }>
}

/** One `game_finished` payload per distinct entrant. Pure. */
export function gameOutcomeEvents(
    input: GameOutcomeInput,
): Array<{ userId: string; properties: Record<string, unknown> }> {
    return input.entrants.map((entrant) => {
        const stake = round2(input.ticketPrice * entrant.cartelas)
        const won = input.winnerId !== null && entrant.userId === input.winnerId
        const outcome = input.winnerId === null ? 'no_winner' : won ? 'won' : 'lost'
        const prize = won ? round2(input.prize) : 0
        return {
            userId: entrant.userId,
            properties: {
                game_id: input.gameId,
                template_id: input.templateId,
                ticket_price: input.ticketPrice,
                cartelas: entrant.cartelas,
                stake,
                outcome,
                prize,
                net: round2(prize - stake),
                duration_secs: input.durationSecs,
            },
        }
    })
}

function round2(n: number): number {
    return Math.round(n * 100) / 100
}

/** Post-commit for WalletService.approveDeposit — covers manual review and the ZareCash webhook. */
export async function emitDepositApproved(transactionId: string, now: Date = new Date()): Promise<void> {
    try {
        const tx = await prisma.transaction.findUnique({
            where: { id: transactionId },
            select: { id: true, userId: true, amount: true, note: true, gateway: true, createdAt: true },
        })
        if (!tx) return
        const prior = await prisma.transaction.count({
            where: { userId: tx.userId, type: 'DEPOSIT', status: 'APPROVED', id: { not: tx.id } },
        })
        void captureEvent(tx.userId, 'deposit_approved', {
            amount: Number(tx.amount),
            method: tx.note ?? null,
            gateway: tx.gateway ?? 'manual',
            hours_to_approve: hoursBetween(tx.createdAt, now),
            is_first_deposit: prior === 0,
            tx_id: tx.id,
        })
    } catch (err) {
        rootLogger.warn({ err, transactionId }, '[posthog] emitDepositApproved failed')
    }
}

/**
 * Post-commit for both completion paths (claimBingo and endGameNoWinner).
 * Reads the committed game row so the two paths cannot disagree about the prize.
 */
export async function emitGameFinished(gameId: string): Promise<void> {
    try {
        const game = await prisma.game.findUnique({
            where: { id: gameId },
            select: {
                id: true,
                templateId: true,
                ticketPrice: true,
                houseEdgePct: true,
                winnerId: true,
                startedAt: true,
                endedAt: true,
            },
        })
        if (!game) return
        const grouped = await prisma.gameEntry.groupBy({
            by: ['userId'],
            where: { gameId },
            _count: { _all: true },
        })
        const entrants = grouped.map((g) => ({ userId: g.userId, cartelas: g._count._all }))
        const totalEntries = entrants.reduce((sum, e) => sum + e.cartelas, 0)
        const ticketPrice = Number(game.ticketPrice)
        const prize = game.winnerId
            ? ticketPrice * totalEntries * (1 - Number(game.houseEdgePct) / 100)
            : 0
        const durationSecs =
            game.startedAt && game.endedAt
                ? Math.max(0, Math.round((game.endedAt.getTime() - game.startedAt.getTime()) / 1000))
                : null
        for (const ev of gameOutcomeEvents({
            gameId,
            templateId: game.templateId,
            ticketPrice,
            winnerId: game.winnerId,
            prize,
            durationSecs,
            entrants,
        })) {
            void captureEvent(ev.userId, 'game_finished', ev.properties)
        }
    } catch (err) {
        rootLogger.warn({ err, gameId }, '[posthog] emitGameFinished failed')
    }
}

/** Post-commit for GameService.cancelGame, fed by RefundService.refundGame's result. */
export function emitGameRefunded(
    gameId: string,
    templateId: string | null,
    refunds: Array<{ userId: string; amount: number; alreadyRefunded: boolean }>,
    reason: string,
): void {
    for (const refund of refunds) {
        if (refund.alreadyRefunded) continue
        void captureEvent(refund.userId, 'game_refunded', {
            game_id: gameId,
            template_id: templateId,
            reason,
            refund: refund.amount,
        })
    }
}

// ── Third-party (provider) play ─────────────────────────────────────────────
// Bets and wins happen inside the provider's iframe and only reach us as
// wallet callbacks, so without these the only PostHog trace of provider play
// is "launched". All three are fire-and-forget; call them post-commit.

/**
 * One event per launch attempt. `launchOk` false means the provider answered
 * but the URL was unusable, or the vendor call failed — `reason` says which.
 * Before this the launch event fired for every attempt, so launches
 * outnumbered game views by almost two to one and nobody could tell a failed
 * launch from a working one.
 */
export function emitProviderLaunch(
    userId: string,
    input: { providerCode: string; gameCode: string; launchOk: boolean; reason?: string },
): void {
    const base = { provider_code: input.providerCode, game_code: input.gameCode }
    if (input.launchOk) {
        void captureEvent(userId, 'provider_game_launched', base)
    } else {
        void captureEvent(userId, 'provider_launch_failed', { ...base, reason: input.reason ?? 'unknown' })
    }
}

export function emitProviderBet(
    userId: string,
    input: {
        providerCode: string
        gameCode: string | null
        roundId: string | null
        betId: string | null
        amount: number
        spendAccount: string
    },
): void {
    void captureEvent(userId, 'provider_bet', {
        provider_code: input.providerCode,
        game_code: input.gameCode,
        round_id: input.roundId,
        bet_id: input.betId,
        amount: round2(Math.abs(input.amount)),
        spend_account: input.spendAccount,
    })
}

export function emitProviderWin(
    userId: string,
    input: {
        providerCode: string
        gameCode: string | null
        roundId: string | null
        betId: string | null
        amount: number
        roundStake: number
    },
): void {
    const amount = round2(Math.abs(input.amount))
    const roundStake = round2(Math.abs(input.roundStake))
    void captureEvent(userId, 'provider_win', {
        provider_code: input.providerCode,
        game_code: input.gameCode,
        round_id: input.roundId,
        bet_id: input.betId,
        amount,
        round_stake: roundStake,
        net: round2(amount - roundStake),
    })
}
