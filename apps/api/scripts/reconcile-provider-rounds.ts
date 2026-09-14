/**
 * Read-only reconciliation of third-party game payouts, per game and per
 * round, straight from the wallet ledger — so PostHog's provider_bet /
 * provider_win numbers, and Palace's own transaction list, can be checked
 * against what the wallet actually booked.
 *
 * USAGE (inside the api container, from /app/apps/api)
 *   node_modules/.bin/tsx scripts/reconcile-provider-rounds.ts --since 2026-08-31
 *   node_modules/.bin/tsx scripts/reconcile-provider-rounds.ts --since 2026-08-31 --game aviator --top 30
 *   node_modules/.bin/tsx scripts/reconcile-provider-rounds.ts --since 2026-09-12 --until 2026-09-13 --game aviator --palace
 *
 * Every query runs inside a READ ONLY Postgres transaction
 * (src/lib/provider-round-ledger.ts), so this cannot write even by mistake.
 * --palace also calls Palace's agent API /v4/game/transaction, which is a read;
 * keep that window to a day or two, since Palace pages every game 1,000 rows at
 * a time. Exit code 2 means Palace and the ledger disagree on at least one
 * player-round. Logic lives in src/lib and is unit tested; this file is I/O.
 */
import prisma from '../src/lib/prisma.js'
import {
    parseReconcileArgs,
    summarizeGames,
    analyzeRounds,
    diffAgainstPalace,
    type PalaceTxRecord,
    type ReconcileArgs,
} from '../src/lib/provider-round-reconciliation.js'
import {
    withReadOnlyLedger,
    fetchGameLedgerRows,
    fetchRoundLedgerRows,
    fetchLedgerIntegrity,
    fetchPalaceUserMap,
} from '../src/lib/provider-round-ledger.js'

/**
 * `getGameProviderGateway` is imported lazily, and only from here, because
 * src/gateways/game-provider/index.ts registers `new PalaceGateway()` at
 * module load for the default `standalone` (and `hub`) deployment role, and
 * PalaceGateway imports the shared Redis client from src/lib/redis.ts —
 * `new Redis(url)` with no lazyConnect and no unref, so it keeps Node's event
 * loop alive forever once created. A run without --palace must never pay for
 * that: mainline commit 265e405 hit the exact same class of bug in
 * prisma/seed.ts (redis client imported as a side effect, never closed, api
 * container stuck "unhealthy" for 8+ minutes in production with Redis up).
 * `redis.disconnect()` below force-closes the socket and cancels ioredis's
 * reconnect loop without a network round trip, so this exits cleanly whether
 * or not Redis is actually reachable.
 */
async function fetchPalaceRecords(since: Date, until: Date): Promise<PalaceTxRecord[]> {
    const [{ getGameProviderGateway }, { default: redis }] = await Promise.all([
        import('../src/gateways/game-provider/index.js'),
        import('../src/lib/redis.js'),
    ])
    try {
        const gateway = getGameProviderGateway('palace')
        const records: PalaceTxRecord[] = []
        for (let page = 1; ; page++) {
            const res = await gateway.getTransactions(since.getTime(), until.getTime(), page)
            for (const t of res.transactions) {
                records.push({ username: t.username, roundId: t.roundId, gameCode: t.gameCode, betAmount: t.betAmount, winAmount: t.winAmount })
            }
            console.error(`[reconcile] Palace page ${page}/${res.totalPages}`)
            if (page >= res.totalPages) break
        }
        return records
    } finally {
        redis.disconnect()
    }
}

async function main(): Promise<void> {
    let args: ReconcileArgs
    try {
        args = parseReconcileArgs(process.argv.slice(2))
    } catch (err) {
        console.error((err as Error).message)
        process.exitCode = 1
        return
    }
    const window = { provider: args.provider, since: args.since, until: args.until }
    console.log(
        `Ledger window ${args.since.toISOString()} -> ${args.until.toISOString()} provider=${args.provider}${args.game ? ` game=${args.game}` : ''}`,
    )

    const ledger = await withReadOnlyLedger(prisma, async (db) => ({
        games: await fetchGameLedgerRows(db, window),
        integrity: await fetchLedgerIntegrity(db, window, args.game),
        rounds: args.game ? await fetchRoundLedgerRows(db, window, args.game) : [],
        userMap: args.palace ? await fetchPalaceUserMap(db, args.provider) : [],
    }))

    const summaries = summarizeGames(ledger.games)
    console.log('\nPer-game ledger totals (hold = 1 - paid / wagered; posthogComparableWagered includes stake later refunded)')
    console.table(args.game ? summaries.filter((s) => s.gameCode === args.game) : summaries.slice(0, 40))

    console.log('\nLedger double-write integrity (third_party_transactions vs transactions) — every count must be 0')
    console.table(ledger.integrity)

    if (args.game) {
        const a = analyzeRounds(ledger.rounds, args.top)
        console.log(`\nPlayer-rounds for ${args.game}`)
        console.table([
            {
                rounds: a.rounds,
                paidRounds: a.paidRounds,
                zeroWinRounds: a.zeroWinRounds,
                betWithoutWinRounds: a.betWithoutWinRounds,
                winWithoutBetRounds: a.winWithoutBetRounds,
                players: a.players,
                playersNeverPaid: a.playersNeverPaid,
                netWinners: a.netWinners,
            },
        ])
        console.log('Stake buckets (stake per player-round)')
        console.table(a.stakeBuckets)
        console.log(`Top ${args.top} players by wagered`)
        console.table(a.topPlayers)
    }

    if (args.palace && args.game) {
        const palace = await fetchPalaceRecords(args.since, args.until)
        const diff = diffAgainstPalace({
            ledger: ledger.rounds,
            palace,
            game: args.game,
            userByExternalCode: new Map(ledger.userMap.map((u) => [u.externalUserCode, u.userId])),
        })
        console.log(
            `\nPalace vs ledger for ${args.game}: ${diff.palaceRowsForGame} Palace rows, ${diff.unmappedPalaceRows} without a provider_user_accounts mapping, ${diff.diffs.length} player-rounds differ`,
        )
        console.table(diff.diffs.slice(0, args.top))
        if (diff.diffs.length > 0) process.exitCode = 2
    }
}

main()
    .catch((err) => {
        console.error(err)
        process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
