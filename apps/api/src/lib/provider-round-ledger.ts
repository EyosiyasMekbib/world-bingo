import type { Prisma, PrismaClient } from '@prisma/client'
import type { GameLedgerRow, RoundLedgerRow } from './provider-round-reconciliation.js'

/**
 * SQL half of the provider payout reconciliation. Reads the per-callback ledger
 * (third_party_transactions: gameCode/roundId/type/status are structured there)
 * and cross-checks it against the wallet audit trail (transactions, joined on
 * referenceId = transactionId). Every query runs through withReadOnlyLedger, so
 * Postgres itself rejects any write.
 *
 * Timestamps are bound as ISO strings cast to `timestamp`: the createdAt columns
 * are timestamp WITHOUT time zone holding UTC, and a bound JS Date would be
 * reconciled through the session time zone (same reasoning as BonusService.grant).
 */

export type LedgerClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRawUnsafe'>

export interface LedgerWindow {
    provider: string
    since: Date
    until: Date
}

export async function withReadOnlyLedger<T>(prisma: PrismaClient, fn: (db: LedgerClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(
        async (tx) => {
            await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
            return fn(tx)
        },
        { maxWait: 10_000, timeout: 300_000 },
    )
}

export async function fetchGameLedgerRows(db: LedgerClient, w: LedgerWindow): Promise<GameLedgerRow[]> {
    return db.$queryRaw<GameLedgerRow[]>`
        SELECT
            t."gameCode" AS "gameCode",
            (count(*) FILTER (WHERE t.type = 'BET' AND t.status = 'COMPLETED'))::int AS bets,
            coalesce(sum(t."betAmount") FILTER (WHERE t.type = 'BET' AND t.status = 'COMPLETED'), 0)::text AS wagered,
            (count(*) FILTER (WHERE t.type = 'BET' AND t.status = 'ROLLED_BACK'))::int AS "rolledBackBets",
            coalesce(sum(t."betAmount") FILTER (WHERE t.type = 'BET' AND t.status = 'ROLLED_BACK'), 0)::text AS "rolledBackStake",
            (count(*) FILTER (WHERE t.type = 'BET' AND t.status = 'FAILED'))::int AS "failedBets",
            (count(*) FILTER (WHERE t.type = 'BET_RESULT'))::int AS wins,
            (count(*) FILTER (WHERE t.type = 'BET_RESULT' AND t."winAmount" > 0))::int AS "nonzeroWins",
            coalesce(sum(t."winAmount") FILTER (WHERE t.type = 'BET_RESULT'), 0)::text AS paid,
            coalesce(sum(t.amount) FILTER (WHERE t.type = 'ROLLBACK'), 0)::text AS refunded
        FROM third_party_transactions t
        JOIN game_providers p ON p.id = t."providerId"
        WHERE p.code = ${w.provider}
          AND t."createdAt" >= ${w.since.toISOString()}::timestamp
          AND t."createdAt" < ${w.until.toISOString()}::timestamp
        GROUP BY t."gameCode"
    `
}

export async function fetchRoundLedgerRows(db: LedgerClient, w: LedgerWindow, game: string): Promise<RoundLedgerRow[]> {
    return db.$queryRaw<RoundLedgerRow[]>`
        SELECT
            t."userId" AS "userId",
            t."roundId" AS "roundId",
            (count(*) FILTER (WHERE t.type = 'BET' AND t.status = 'COMPLETED'))::int AS bets,
            coalesce(sum(t."betAmount") FILTER (WHERE t.type = 'BET' AND t.status = 'COMPLETED'), 0)::text AS wagered,
            (count(*) FILTER (WHERE t.type = 'BET' AND t.status = 'ROLLED_BACK'))::int AS "rolledBackBets",
            coalesce(sum(t."betAmount") FILTER (WHERE t.type = 'BET' AND t.status = 'ROLLED_BACK'), 0)::text AS "rolledBackStake",
            (count(*) FILTER (WHERE t.type = 'BET_RESULT'))::int AS wins,
            coalesce(sum(t."winAmount") FILTER (WHERE t.type = 'BET_RESULT'), 0)::text AS paid
        FROM third_party_transactions t
        JOIN game_providers p ON p.id = t."providerId"
        WHERE p.code = ${w.provider}
          AND t."gameCode" = ${game}
          AND t."createdAt" >= ${w.since.toISOString()}::timestamp
          AND t."createdAt" < ${w.until.toISOString()}::timestamp
        GROUP BY t."userId", t."roundId"
    `
}

/**
 * Every committed BET and BET_RESULT must have its paired Transaction row
 * (TP_BET / TP_WIN, same referenceId and user, amount rounded to 2dp), because
 * PalaceWalletService writes both inside one database transaction. Any count
 * here other than zero is a double-write bug, not a reporting difference.
 */
export async function fetchLedgerIntegrity(
    db: LedgerClient,
    w: LedgerWindow,
    game: string | null,
): Promise<Array<{ type: string; missing: number; amountMismatch: number }>> {
    return db.$queryRaw<Array<{ type: string; missing: number; amountMismatch: number }>>`
        SELECT
            t.type::text AS type,
            (count(*) FILTER (WHERE x.id IS NULL))::int AS missing,
            (count(*) FILTER (
                WHERE x.id IS NOT NULL
                  AND x.amount <> round(coalesce(CASE WHEN t.type = 'BET' THEN t."betAmount" ELSE t."winAmount" END, 0), 2)
            ))::int AS "amountMismatch"
        FROM third_party_transactions t
        JOIN game_providers p ON p.id = t."providerId"
        LEFT JOIN transactions x
          ON x."referenceId" = t."transactionId"
         AND x."userId" = t."userId"
         AND x.type::text = CASE WHEN t.type = 'BET' THEN 'TP_BET' ELSE 'TP_WIN' END
        WHERE p.code = ${w.provider}
          AND t.type IN ('BET', 'BET_RESULT')
          AND t.status IN ('COMPLETED', 'ROLLED_BACK')
          AND t."createdAt" >= ${w.since.toISOString()}::timestamp
          AND t."createdAt" < ${w.until.toISOString()}::timestamp
          AND (${game}::text IS NULL OR t."gameCode" = ${game})
        GROUP BY t.type
    `
}

export async function fetchPalaceUserMap(db: LedgerClient, provider: string): Promise<Array<{ externalUserCode: string; userId: string }>> {
    return db.$queryRaw<Array<{ externalUserCode: string; userId: string }>>`
        SELECT a."externalUserCode" AS "externalUserCode", a."userId" AS "userId"
        FROM provider_user_accounts a
        JOIN game_providers p ON p.id = a."providerId"
        WHERE p.code = ${provider}
    `
}
