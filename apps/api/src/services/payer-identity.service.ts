import type { Prisma } from '@prisma/client'
import { normalizeName } from './deposit-verification/matching'

export type SharedPayerSignal = 'sender_account' | 'receipt_payer'

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
            // predicates, so Postgres bounds the scan with the transactions
            // `[type, status]` index before evaluating the regexp match — it never
            // scans non-deposit or non-approved rows. The correlated NOT EXISTS below
            // is similarly bounded by `[userId, type]`. There is no index on
            // `senderAccount` itself, so within the approved-deposit set this is a
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
            // Same index-bounding as the sender-account query above: `[type, status]`
            // keeps this to approved deposits before the regexp runs; no index exists
            // on `payerNumberMasked` (follow-up: a normalized-payer-number index built
            // CONCURRENTLY, if approved-deposit volume ever makes this costly). Masked
            // numbers have low entropy (a fixed visible prefix/suffix), so this can
            // still match many rows across different payer names — capped to the 200
            // earliest-approved candidates. ORDER BY runs before LIMIT, so the earliest
            // legitimate match is never dropped by the cap; the name check below then
            // walks that same ascending order, so the first hit is always the earliest.
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
}
