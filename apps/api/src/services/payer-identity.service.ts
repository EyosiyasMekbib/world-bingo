import type { Prisma } from '@prisma/client'
import { TransactionType, PaymentStatus } from '@world-bingo/shared-types'
import prisma from '../lib/prisma'
import { normalizeName } from './deposit-verification/matching'

export type SharedPayerSignal = 'sender_account' | 'receipt_payer'

export type ClusterSignal = 'sender_account' | 'receipt_payer' | 'registered_phone'

export interface SharedPayerAccount {
    userId: string
    username: string | null
    phone: string | null
    registeredAt: string
    approvedDeposits: number
    approvedAmount: number
    firstDepositBonus: boolean
}

export interface SharedPayerCluster {
    signal: ClusterSignal
    key: string
    accounts: SharedPayerAccount[]
}

export interface SharedPayerMatch {
    transactionId: string
    userId: string
    matchedOn: SharedPayerSignal
}

/** Last 9 digits of a player-entered paying account (Ethiopian mobile 9XXXXXXXX), or null when too short to trust. */
export function senderAccountKey(raw: string | null | undefined): string | null {
    if (!raw) return null
    const digits = raw.replace(/\D/g, '')
    return digits.length >= 9 ? digits.slice(-9) : null
}

/** A receipt's masked payer number (e.g. "2519****2528") without whitespace, or null when it shows fewer than 8 digits. */
export function maskedPayerKey(raw: string | null | undefined): string | null {
    if (!raw) return null
    const compact = raw.replace(/\s+/g, '')
    return compact.replace(/\D/g, '').length >= 8 ? compact : null
}

/**
 * Class id (first argument of the two-integer `pg_advisory_xact_lock(int, int)`) for the
 * lock that serialises first-deposit approvals paid from one account. 0x57420001 is "WB"
 * plus namespace 1: no other Postgres advisory lock exists in this codebase, and the
 * two-integer keyspace is disjoint from the single-bigint key Prisma Migrate locks on.
 */
export const FIRST_DEPOSIT_PAYER_LOCK_CLASSID = 0x57420001

export class PayerIdentityService {
    /**
     * First-deposit incentives (the FIRST_DEPOSIT bonus and the referral reward) are
     * meant once per paying person, but were keyed only on "this account has no
     * approved deposit" — so one Telebirr wallet could fund the first deposit of any
     * number of fresh accounts. Returns another account's FIRST approved deposit that
     * was paid from the same account as `input.transactionId`, or null.
     *
     * Signals, strongest first: the player-entered sender account (last 9 digits), then
     * the receipt's masked payer number together with the normalised payer name. Hosted
     * ZareCash checkouts store neither, so they never match.
     */
    static async findPriorFirstDepositByPayer(
        tx: Prisma.TransactionClient,
        input: { userId: string; transactionId: string },
    ): Promise<SharedPayerMatch | null> {
        const current = await tx.transaction.findUnique({
            where: { id: input.transactionId },
            select: {
                senderAccount: true,
                depositVerification: { select: { payerNumberMasked: true, payerName: true } },
            },
        })
        if (!current) return null

        const senderKey = senderAccountKey(current.senderAccount)
        if (senderKey) {
            // `t.type = 'DEPOSIT' AND t.status = 'APPROVED'` are plain, index-usable
            // predicates, letting the planner use the transactions `[type, status]`
            // index to bound the scan to approved deposits before evaluating the
            // regexp match — though on a small table the planner may still choose a
            // sequential scan instead (confirmed via EXPLAIN against the test
            // database, where the table was near-empty). The correlated NOT EXISTS
            // below is similarly index-usable via `[userId, type]`. There is no index
            // on `senderAccount` itself, so within the approved-deposit set this is a
            // scan-and-regex; the follow-up if that set's growth makes it costly is a
            // normalized-sender-account index built CONCURRENTLY (never inline in a
            // migration transaction, which would lock out wallet writes).
            const rows = await tx.$queryRaw<Array<{ id: string; userId: string }>>`
                SELECT t.id, t."userId"
                FROM transactions t
                WHERE t.type = 'DEPOSIT'
                  AND t.status = 'APPROVED'
                  AND t."userId" <> ${input.userId}
                  AND t."senderAccount" IS NOT NULL
                  AND right(regexp_replace(t."senderAccount", '[^0-9]', '', 'g'), 9) = ${senderKey}
                  AND NOT EXISTS (
                      SELECT 1 FROM transactions e
                      WHERE e."userId" = t."userId"
                        AND e.type = 'DEPOSIT'
                        AND e.status = 'APPROVED'
                        AND e."createdAt" < t."createdAt"
                  )
                ORDER BY t."createdAt" ASC
                LIMIT 1
            `
            if (rows[0]) return { transactionId: rows[0].id, userId: rows[0].userId, matchedOn: 'sender_account' }
        }

        const masked = maskedPayerKey(current.depositVerification?.payerNumberMasked)
        const name = current.depositVerification?.payerName ? normalizeName(current.depositVerification.payerName) : ''
        if (masked && name) {
            // Same index-usable `type`/`status` predicates as the sender-account query
            // above, letting the planner bound this to approved deposits via
            // `[type, status]` (though it may still pick a sequential scan on a small
            // table). No index exists on `payerNumberMasked` (follow-up: a
            // normalized-payer-number index built CONCURRENTLY, if approved-deposit
            // volume ever makes this costly). Masked numbers have low entropy (a fixed
            // visible prefix/suffix), so this can match many rows across different
            // payer names — the fetch is capped to the 200 earliest-approved
            // candidates (ORDER BY before LIMIT), and the name check below walks that
            // same ascending order so the first hit among the fetched rows is the
            // earliest. TRADE-OFF, not a guarantee: if 200 or more OTHER approved
            // deposits share this masked number under different payer names and have
            // an earlier `createdAt` than the true name match, that true match falls
            // outside the fetched window and is silently missed. This is accepted to
            // bound the fetch under the wallet row lock C2 holds; revisit (e.g. a
            // normalized-key index, or filtering by name in SQL) if that volume of
            // same-masked-number deposits from other payers proves reachable.
            const rows = await tx.$queryRaw<Array<{ id: string; userId: string; payerName: string | null }>>`
                SELECT t.id, t."userId", dv."payerName"
                FROM transactions t
                JOIN deposit_verifications dv ON dv."transactionId" = t.id
                WHERE t.type = 'DEPOSIT'
                  AND t.status = 'APPROVED'
                  AND t."userId" <> ${input.userId}
                  AND regexp_replace(dv."payerNumberMasked", '[[:space:]]', '', 'g') = ${masked}
                  AND NOT EXISTS (
                      SELECT 1 FROM transactions e
                      WHERE e."userId" = t."userId"
                        AND e.type = 'DEPOSIT'
                        AND e.status = 'APPROVED'
                        AND e."createdAt" < t."createdAt"
                  )
                ORDER BY t."createdAt" ASC
                LIMIT 200
            `
            // Names are compared in JS so the normalisation is exactly the one the
            // deposit verifier's PAYER_MISMATCH gate already uses.
            const hit = rows.find((r) => r.payerName !== null && normalizeName(r.payerName) === name)
            if (hit) return { transactionId: hit.id, userId: hit.userId, matchedOn: 'receipt_payer' }
        }

        return null
    }

    /**
     * Advisory-lock keys for `transactionId`'s paying account: one per signal
     * `findPriorFirstDepositByPayer` can match that deposit on, prefixed with the signal
     * so a sender-account key and a masked-number key never collide, and sorted so every
     * approval takes them in the same order. Empty when the deposit carries neither
     * (hosted ZareCash checkouts), so those approvals take no lock. Read-only through `tx`.
     */
    static async firstDepositLockKeys(tx: Prisma.TransactionClient, transactionId: string): Promise<string[]> {
        const current = await tx.transaction.findUnique({
            where: { id: transactionId },
            select: { senderAccount: true, depositVerification: { select: { payerNumberMasked: true } } },
        })
        if (!current) return []

        const keys: string[] = []
        const sender = senderAccountKey(current.senderAccount)
        if (sender) keys.push(`sender_account:${sender}`)
        const masked = maskedPayerKey(current.depositVerification?.payerNumberMasked)
        if (masked) keys.push(`receipt_payer:${masked}`)
        return keys.sort()
    }

    /**
     * Admin detection: groups of accounts tied together by one paying account inside
     * the window. Three signals: one sender account behind approved deposits on several
     * accounts; one parsed receipt payer (masked number + lower-cased name) behind
     * several accounts; one account's REGISTERED phone paying another account's deposit.
     * Telegram ids and phones are unique columns, so no two accounts can share those;
     * device overlap is only visible in PostHog (docs/posthog.md §10.2).
     */
    static async listSharedPayerClusters(opts: { since: Date; limit: number }): Promise<SharedPayerCluster[]> {
        const since = opts.since.toISOString()
        const [senderRows, receiptCandidates, phoneRows] = await Promise.all([
            prisma.$queryRaw<Array<{ key: string; userIds: string[] }>>`
                SELECT right(regexp_replace(t."senderAccount", '[^0-9]', '', 'g'), 9) AS key,
                       array_agg(DISTINCT t."userId") AS "userIds"
                FROM transactions t
                WHERE t.type = 'DEPOSIT'
                  AND t.status = 'APPROVED'
                  AND t."createdAt" >= ${since}::timestamp
                  AND length(regexp_replace(coalesce(t."senderAccount", ''), '[^0-9]', '', 'g')) >= 9
                GROUP BY 1
                HAVING count(DISTINCT t."userId") > 1
                ORDER BY count(DISTINCT t."userId") DESC, 1
                LIMIT ${opts.limit}::int
            `,
            // Grouped in JS below (not GROUP BY here, unlike the other two signals):
            // the key's name half has to run through the SAME `normalizeName` that
            // C1's matcher and the deposit verifier's PAYER_MISMATCH gate use (NFD
            // diacritic stripping, punctuation-to-space). A SQL-only
            // lower()+trim()+collapse-whitespace re-implementation would silently
            // diverge from that on any accented or punctuated payer name — this
            // fetch is still bounded by the `since` window, only its GROUP BY moved
            // to the app.
            prisma.$queryRaw<Array<{ userId: string; maskedRaw: string; payerName: string }>>`
                SELECT t."userId" AS "userId", dv."payerNumberMasked" AS "maskedRaw", dv."payerName" AS "payerName"
                FROM transactions t
                JOIN deposit_verifications dv ON dv."transactionId" = t.id
                WHERE t.type = 'DEPOSIT'
                  AND t.status = 'APPROVED'
                  AND t."createdAt" >= ${since}::timestamp
                  AND dv."payerNumberMasked" IS NOT NULL
                  AND dv."payerName" IS NOT NULL
            `,
            prisma.$queryRaw<Array<{ key: string; ownerId: string; fundedIds: string[] }>>`
                WITH funded AS (
                    SELECT right(regexp_replace(t."senderAccount", '[^0-9]', '', 'g'), 9) AS key, t."userId"
                    FROM transactions t
                    WHERE t.type = 'DEPOSIT'
                      AND t.status IN ('APPROVED', 'PENDING_REVIEW')
                      AND t."createdAt" >= ${since}::timestamp
                      AND length(regexp_replace(coalesce(t."senderAccount", ''), '[^0-9]', '', 'g')) >= 9
                ), owners AS (
                    SELECT right(regexp_replace(u.phone, '[^0-9]', '', 'g'), 9) AS key, u.id
                    FROM users u
                    WHERE u.phone IS NOT NULL
                      AND length(regexp_replace(u.phone, '[^0-9]', '', 'g')) >= 9
                )
                SELECT o.key AS key, o.id AS "ownerId", array_agg(DISTINCT f."userId") AS "fundedIds"
                FROM funded f
                JOIN owners o ON o.key = f.key AND o.id <> f."userId"
                GROUP BY o.key, o.id
                ORDER BY count(DISTINCT f."userId") DESC, o.key
                LIMIT ${opts.limit}::int
            `,
        ])

        // Same normalisation C1's findPriorFirstDepositByPayer uses for this signal
        // (maskedPayerKey for the number, normalizeName for the payer name), just
        // applied per-row instead of per-transaction, then grouped by the composite
        // key and cut to accounts sharing it.
        const receiptGroups = new Map<string, Set<string>>()
        for (const row of receiptCandidates) {
            const masked = maskedPayerKey(row.maskedRaw)
            const name = row.payerName ? normalizeName(row.payerName) : ''
            if (!masked || !name) continue
            const key = `${masked}|${name}`
            const group = receiptGroups.get(key) ?? new Set<string>()
            group.add(row.userId)
            receiptGroups.set(key, group)
        }
        const receiptRows = [...receiptGroups.entries()]
            .filter(([, userIds]) => userIds.size > 1)
            .sort(([keyA, a], [keyB, b]) => b.size - a.size || (keyA < keyB ? -1 : keyA > keyB ? 1 : 0))
            .slice(0, opts.limit)
            .map(([key, userIds]) => ({ key, userIds: [...userIds] }))

        const raw: Array<{ signal: ClusterSignal; key: string; userIds: string[] }> = [
            ...senderRows.map((r) => ({ signal: 'sender_account' as const, key: r.key, userIds: r.userIds })),
            ...receiptRows.map((r) => ({ signal: 'receipt_payer' as const, key: r.key, userIds: r.userIds })),
            ...phoneRows.map((r) => ({ signal: 'registered_phone' as const, key: r.key, userIds: [r.ownerId, ...r.fundedIds] })),
        ]
        const ids = [...new Set(raw.flatMap((r) => r.userIds))]
        if (ids.length === 0) return []

        const [users, deposits, bonuses] = await Promise.all([
            prisma.user.findMany({
                where: { id: { in: ids } },
                select: { id: true, username: true, phone: true, createdAt: true },
            }),
            prisma.transaction.groupBy({
                by: ['userId'],
                where: { userId: { in: ids }, type: TransactionType.DEPOSIT, status: PaymentStatus.APPROVED },
                _count: { _all: true },
                _sum: { amount: true },
            }),
            prisma.transaction.findMany({
                where: { userId: { in: ids }, type: TransactionType.FIRST_DEPOSIT_BONUS },
                select: { userId: true },
                distinct: ['userId'],
            }),
        ])
        const userById = new Map(users.map((u) => [u.id, u]))
        const depositsByUser = new Map(deposits.map((d) => [d.userId, d]))
        const bonusUsers = new Set(bonuses.map((b) => b.userId))

        return raw.map((r) => ({
            signal: r.signal,
            key: r.key,
            accounts: [...new Set(r.userIds)].sort().map((id) => {
                const user = userById.get(id)
                const dep = depositsByUser.get(id)
                return {
                    userId: id,
                    username: user?.username ?? null,
                    phone: user?.phone ?? null,
                    registeredAt: user ? user.createdAt.toISOString() : '',
                    approvedDeposits: dep?._count._all ?? 0,
                    approvedAmount: Number(dep?._sum.amount ?? 0),
                    firstDepositBonus: bonusUsers.has(id),
                }
            }),
        }))
    }
}
