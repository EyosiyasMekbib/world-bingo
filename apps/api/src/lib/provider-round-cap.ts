import { Decimal } from '@prisma/client/runtime/library'
import { AccountStatus, ThirdPartyTxStatus, ThirdPartyTxType } from '@world-bingo/shared-types'
import prisma from './prisma.js'
import { getLogger } from './log-context.js'

/**
 * Per-round cumulative caps on provider credits.
 *
 * Per-win caps judge each callback alone, so a round can be paid any number of
 * times by callbacks that each look reasonable: on 2026-10-22 one 50 ETB Palace
 * chicken-road bet was followed by 2,844 distinct win callbacks (220,410 ETB).
 * These caps bound what one player's round can be credited in total. Across
 * ~375k legitimate Palace rounds on both brands the most any round paid was 75
 * credits and 525x its stake, so the defaults leave wide headroom.
 *
 * Only credits that take no stake in the same call need this. A callback that
 * debits its own bet (Atlas-V betwin, GASea BET_WIN) costs the replayer a stake
 * every time.
 */

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export interface RoundCapLimits {
    maxCredits: number
    maxMultiple: number
}

/**
 * `<PREFIX>_MAX_ROUND_WINS` (default 200) and `<PREFIX>_MAX_ROUND_WIN_MULTIPLE`
 * (default 2,000x the round's stake). 0 disables either. Read per call, so an
 * env change applies without a restart path of its own.
 */
export function roundCapLimits(prefix: string): RoundCapLimits {
    return {
        maxCredits: Number(process.env[`${prefix}_MAX_ROUND_WINS`] ?? 200),
        maxMultiple: Number(process.env[`${prefix}_MAX_ROUND_WIN_MULTIPLE`] ?? 2_000),
    }
}

export interface RoundCapBreach {
    credits: number
    credited: number
    stake: number
    overCount: boolean
    overTotal: boolean
}

/**
 * Whether crediting `credit` would take the round past either cap. Call it under
 * the wallet lock, before writing the credit, so concurrent callbacks for one
 * round see each other. A zero credit, or a callback without a round, is never
 * capped.
 *
 * The stake is what the round's recorded bets add up to, or `knownStake` when
 * the caller has the bet from elsewhere (GASea can post a bet without a roundId).
 * A round with no stake at all (free spins, jackpots) gets the count cap only.
 */
export async function checkRoundCap(
    tx: Tx,
    input: {
        providerId: string
        userId: string
        roundId: string | null | undefined
        credit: Decimal
        knownStake?: Decimal | null
        limits: RoundCapLimits
    },
): Promise<RoundCapBreach | null> {
    const { providerId, userId, roundId, credit, limits } = input
    if (!roundId || credit.lessThanOrEqualTo(0)) return null

    const paid = await tx.thirdPartyTransaction.aggregate({
        where: {
            providerId,
            userId,
            roundId,
            type: { in: [ThirdPartyTxType.BET_RESULT, ThirdPartyTxType.BET_CREDIT] },
            amount: { gt: 0 },
        },
        _sum: { amount: true },
        _count: true,
    })
    const bets = await tx.thirdPartyTransaction.aggregate({
        where: {
            providerId,
            userId,
            roundId,
            type: { in: [ThirdPartyTxType.BET, ThirdPartyTxType.BET_DEBIT] },
            status: ThirdPartyTxStatus.COMPLETED,
        },
        _sum: { betAmount: true },
    })

    const stake = Decimal.max(new Decimal(bets._sum.betAmount ?? 0).abs(), input.knownStake?.abs() ?? 0)
    const credited = new Decimal(paid._sum.amount ?? 0).plus(credit)
    const overCount = limits.maxCredits > 0 && paid._count >= limits.maxCredits
    const overTotal =
        limits.maxMultiple > 0 && stake.greaterThan(0) && credited.greaterThan(stake.times(limits.maxMultiple))
    if (!overCount && !overTotal) return null
    return { credits: paid._count, credited: credited.toNumber(), stake: stake.toNumber(), overCount, overTotal }
}

/**
 * Contain an account whose round tripped a cap. Refusing the credit alone is not
 * enough: a replay that hits the cap can move to a fresh round. RESTRICTED stops
 * withdrawals and new games until staff review it. Never weakens a stricter
 * status, and never fails the callback.
 */
export async function restrictAfterRoundCap(
    userId: string,
    provider: string,
    roundId: string,
    gameCode: string | null | undefined,
): Promise<void> {
    try {
        // Provider gateways cache the resolved user for up to an hour; read the column itself.
        const current = await prisma.user.findUnique({ where: { id: userId }, select: { accountStatus: true } })
        if (current?.accountStatus !== AccountStatus.ACTIVE) return
        // Loaded lazily: account-status pulls in ZareCash and the wallet service,
        // which the callback paths otherwise never need.
        const { AccountStatusService } = await import('../services/account-status.service.js')
        await AccountStatusService.restrict(userId, {
            reason: `Automatic: ${provider} round ${roundId} (${gameCode ?? 'unknown game'}) exceeded the per-round win cap`,
            category: 'OTHER',
        })
    } catch (err) {
        getLogger().error(
            { component: 'provider-round-cap', err, provider, round: roundId, game: gameCode },
            '[provider-round-cap] could not restrict the account after a round cap',
        )
    }
}
