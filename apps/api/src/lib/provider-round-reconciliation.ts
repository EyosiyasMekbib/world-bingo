/**
 * Pure half of the provider payout reconciliation
 * (scripts/reconcile-provider-rounds.ts): argument parsing, per-game hold,
 * per-round and per-player analysis, and the round-level diff against Palace's
 * own transaction list. No database and no network here — the SQL lives in
 * ./provider-round-ledger.ts, so everything in this file is unit tested.
 */

export interface ReconcileArgs {
    since: Date
    until: Date
    provider: 'palace'
    game: string | null
    palace: boolean
    top: number
}

const USAGE =
    'usage: reconcile-provider-rounds.ts --since YYYY-MM-DD [--until YYYY-MM-DD] [--provider palace] [--game <code>] [--palace] [--top N]'

function readFlag(argv: string[], name: string): string | undefined {
    const i = argv.indexOf(`--${name}`)
    if (i < 0) return undefined
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value. ${USAGE}`)
    return value
}

function parseDay(raw: string, name: string): Date {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`--${name} must be YYYY-MM-DD, got "${raw}". ${USAGE}`)
    const day = new Date(`${raw}T00:00:00.000Z`)
    if (Number.isNaN(day.getTime())) throw new Error(`--${name} is not a real date: "${raw}"`)
    return day
}

export function parseReconcileArgs(argv: string[], now: Date = new Date()): ReconcileArgs {
    const sinceRaw = readFlag(argv, 'since')
    if (!sinceRaw) throw new Error(`--since is required. ${USAGE}`)
    const since = parseDay(sinceRaw, 'since')
    const untilRaw = readFlag(argv, 'until')
    const until = untilRaw ? parseDay(untilRaw, 'until') : now
    if (until.getTime() <= since.getTime()) throw new Error('--until must be after --since')

    const provider = readFlag(argv, 'provider') ?? 'palace'
    if (provider !== 'palace') {
        throw new Error(`--provider ${provider} is not supported; only palace has ledger rows to reconcile`)
    }

    const game = readFlag(argv, 'game') ?? null
    const palace = argv.includes('--palace')
    if (palace && !game) {
        throw new Error('--palace needs --game: Palace lists every game, so the diff is scoped to one')
    }

    const topRaw = readFlag(argv, 'top')
    const top = topRaw === undefined ? 20 : Number(topRaw)
    if (!Number.isInteger(top) || top < 1) throw new Error(`--top must be a positive integer, got "${topRaw}"`)

    return { since, until, provider, game, palace, top }
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const round3 = (n: number): number => Math.round(n * 1000) / 1000

/** One row per game code from the ledger SQL. Numeric sums arrive as text. */
export interface GameLedgerRow {
    gameCode: string | null
    bets: number
    wagered: string
    rolledBackBets: number
    rolledBackStake: string
    failedBets: number
    wins: number
    nonzeroWins: number
    paid: string
    refunded: string
}

export interface GameSummary {
    gameCode: string
    bets: number
    wagered: number
    /**
     * Completed stake plus stake later refunded by a cancel. PostHog's
     * provider_bet sum equals this, because processCancel emits no event.
     */
    posthogComparableWagered: number
    paid: number
    refunded: number
    hold: number | null
    wins: number
    zeroWinShare: number | null
    failedBets: number
}

export function summarizeGames(rows: GameLedgerRow[]): GameSummary[] {
    return rows
        .map((r) => {
            const wagered = Number(r.wagered)
            const paid = Number(r.paid)
            return {
                gameCode: r.gameCode ?? '(none)',
                bets: r.bets,
                wagered: round2(wagered),
                posthogComparableWagered: round2(wagered + Number(r.rolledBackStake)),
                paid: round2(paid),
                refunded: round2(Number(r.refunded)),
                hold: wagered > 0 ? round3(1 - paid / wagered) : null,
                wins: r.wins,
                zeroWinShare: r.wins > 0 ? round3((r.wins - r.nonzeroWins) / r.wins) : null,
                failedBets: r.failedBets,
            }
        })
        .sort((a, b) => b.wagered - a.wagered || a.gameCode.localeCompare(b.gameCode))
}

/** One row per (player, round) for a single game. Numeric sums arrive as text. */
export interface RoundLedgerRow {
    userId: string
    roundId: string | null
    bets: number
    wagered: string
    rolledBackBets: number
    rolledBackStake: string
    wins: number
    paid: string
}

export interface PlayerTotals {
    userId: string
    rounds: number
    paidRounds: number
    wagered: number
    paid: number
    rtp: number | null
}

export interface StakeBucket {
    label: string
    rounds: number
    paidRounds: number
    wagered: number
    paid: number
    maxPaid: number
}

export interface RoundAnalysis {
    rounds: number
    paidRounds: number
    zeroWinRounds: number
    betWithoutWinRounds: number
    winWithoutBetRounds: number
    players: number
    playersNeverPaid: number
    netWinners: number
    topPlayers: PlayerTotals[]
    stakeBuckets: StakeBucket[]
}

const STAKE_BUCKETS: Array<{ label: string; min: number; max: number }> = [
    { label: '<50', min: 0, max: 50 },
    { label: '50-99', min: 50, max: 100 },
    { label: '100-199', min: 100, max: 200 },
    { label: '200-499', min: 200, max: 500 },
    { label: '500-999', min: 500, max: 1000 },
    { label: '1000+', min: 1000, max: Number.POSITIVE_INFINITY },
]

export function analyzeRounds(rows: RoundLedgerRow[], top: number): RoundAnalysis {
    const buckets: StakeBucket[] = STAKE_BUCKETS.map((b) => ({
        label: b.label,
        rounds: 0,
        paidRounds: 0,
        wagered: 0,
        paid: 0,
        maxPaid: 0,
    }))
    const byPlayer = new Map<string, PlayerTotals>()
    let rounds = 0
    let paidRounds = 0
    let zeroWinRounds = 0
    let betWithoutWinRounds = 0
    let winWithoutBetRounds = 0

    for (const r of rows) {
        const wagered = Number(r.wagered)
        const paid = Number(r.paid)
        if (r.bets === 0) {
            // Cancelled-only and failed-only rounds are not play. A win with no
            // completed and no cancelled bet is worth surfacing.
            if (r.wins > 0 && r.rolledBackBets === 0) winWithoutBetRounds++
            continue
        }
        rounds++
        if (r.wins === 0) betWithoutWinRounds++
        else if (paid > 0) paidRounds++
        else zeroWinRounds++

        const bucket = buckets[STAKE_BUCKETS.findIndex((b) => wagered >= b.min && wagered < b.max)]
        bucket.rounds++
        bucket.wagered += wagered
        bucket.paid += paid
        if (paid > 0) bucket.paidRounds++
        if (paid > bucket.maxPaid) bucket.maxPaid = paid

        const player = byPlayer.get(r.userId) ?? { userId: r.userId, rounds: 0, paidRounds: 0, wagered: 0, paid: 0, rtp: null }
        player.rounds++
        if (paid > 0) player.paidRounds++
        player.wagered += wagered
        player.paid += paid
        byPlayer.set(r.userId, player)
    }

    const players = [...byPlayer.values()].map((p) => ({
        ...p,
        wagered: round2(p.wagered),
        paid: round2(p.paid),
        rtp: p.wagered > 0 ? round3(p.paid / p.wagered) : null,
    }))
    players.sort((a, b) => b.wagered - a.wagered || a.userId.localeCompare(b.userId))

    return {
        rounds,
        paidRounds,
        zeroWinRounds,
        betWithoutWinRounds,
        winWithoutBetRounds,
        players: players.length,
        playersNeverPaid: players.filter((p) => p.paid === 0).length,
        netWinners: players.filter((p) => p.paid > p.wagered).length,
        topPlayers: players.slice(0, top),
        stakeBuckets: buckets.map((b) => ({ ...b, wagered: round2(b.wagered), paid: round2(b.paid), maxPaid: round2(b.maxPaid) })),
    }
}

/** The fields the diff needs from a Palace transaction list row (TransactionRecord in game-provider.interface.ts). */
export interface PalaceTxRecord {
    /** Palace's numeric user_code, as a string. */
    username: string
    roundId: string
    gameCode: string
    betAmount: number
    winAmount: number
}

export interface RoundDiff {
    userId: string | null
    externalUserCode: string | null
    roundId: string
    kind: 'ledger_only' | 'palace_only' | 'amount_mismatch'
    ledgerWagered: number
    palaceWagered: number
    ledgerPaid: number
    palacePaid: number
}

const TOLERANCE = 0.005

export function diffAgainstPalace(input: {
    ledger: RoundLedgerRow[]
    palace: PalaceTxRecord[]
    game: string
    /** Palace user_code → our userId, from provider_user_accounts. */
    userByExternalCode: Map<string, string>
}): { diffs: RoundDiff[]; palaceRowsForGame: number; unmappedPalaceRows: number } {
    type Side = Omit<RoundDiff, 'kind'> & { inLedger: boolean; inPalace: boolean }
    const sides = new Map<string, Side>()
    const side = (key: string, userId: string | null, roundId: string): Side => {
        let s = sides.get(key)
        if (!s) {
            s = { userId, externalUserCode: null, roundId, ledgerWagered: 0, palaceWagered: 0, ledgerPaid: 0, palacePaid: 0, inLedger: false, inPalace: false }
            sides.set(key, s)
        }
        return s
    }

    for (const r of input.ledger) {
        if (!r.roundId) continue
        if (r.bets === 0 && r.wins === 0 && r.rolledBackBets === 0) continue // failed-only round
        const s = side(`${r.userId}|${r.roundId}`, r.userId, r.roundId)
        // Palace still lists a bet we later refunded, so compare against completed + refunded stake.
        s.ledgerWagered += Number(r.wagered) + Number(r.rolledBackStake)
        s.ledgerPaid += Number(r.paid)
        s.inLedger = true
    }

    let palaceRowsForGame = 0
    let unmappedPalaceRows = 0
    for (const t of input.palace) {
        if (t.gameCode !== input.game) continue
        palaceRowsForGame++
        const userId = input.userByExternalCode.get(t.username) ?? null
        if (!userId) unmappedPalaceRows++
        const s = side(userId ? `${userId}|${t.roundId}` : `ext:${t.username}|${t.roundId}`, userId, t.roundId)
        s.externalUserCode = t.username
        s.palaceWagered += t.betAmount
        s.palacePaid += t.winAmount
        s.inPalace = true
    }

    const diffs: RoundDiff[] = []
    for (const s of sides.values()) {
        const kind: RoundDiff['kind'] | null = !s.inPalace
            ? 'ledger_only'
            : !s.inLedger
              ? 'palace_only'
              : Math.abs(s.ledgerWagered - s.palaceWagered) > TOLERANCE || Math.abs(s.ledgerPaid - s.palacePaid) > TOLERANCE
                ? 'amount_mismatch'
                : null
        if (!kind) continue
        diffs.push({
            userId: s.userId,
            externalUserCode: s.externalUserCode,
            roundId: s.roundId,
            kind,
            ledgerWagered: round2(s.ledgerWagered),
            palaceWagered: round2(s.palaceWagered),
            ledgerPaid: round2(s.ledgerPaid),
            palacePaid: round2(s.palacePaid),
        })
    }
    diffs.sort(
        (a, b) => Math.abs(b.palacePaid - b.ledgerPaid) - Math.abs(a.palacePaid - a.ledgerPaid) || a.roundId.localeCompare(b.roundId),
    )
    return { diffs, palaceRowsForGame, unmappedPalaceRows }
}
