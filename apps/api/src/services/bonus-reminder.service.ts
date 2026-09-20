import { Decimal } from '@prisma/client/runtime/library'
import prisma from '../lib/prisma'
import { NotificationType, BonusSource } from '@world-bingo/shared-types'
import { NotificationService } from './notification.service'

/**
 * Two warning shots before a lot dies. The bands are DISJOINT — the 24h band
 * stops where the 2h band starts — so a single sweep can only ever match one
 * window per lot. Overlapping bands (both "expires within Nh") would fire both
 * notifications back to back for a lot granted with two hours of validity, and
 * would make "which window is this?" ambiguous for the idempotency check below.
 */
export const REMINDER_WINDOWS = [
    { key: '24h', fromHours: 2, toHours: 24 },
    { key: '2h', fromHours: 0, toHours: 2 },
] as const

export type BonusReminderWindow = (typeof REMINDER_WINDOWS)[number]['key']

const HOUR_MS = 60 * 60 * 1000

/**
 * Player-facing provenance, used only when the lot has no rule to name. Keyed
 * on the shared enum so adding a BonusSource is a type error here rather than
 * an "undefined" in someone's notification.
 */
const SOURCE_LABELS: Record<`${BonusSource}`, string> = {
    FIRST_DEPOSIT: 'your first deposit',
    DAILY_DEPOSIT: 'a daily deposit bonus',
    WEEKLY_DEPOSIT: 'a weekly deposit bonus',
    CASHBACK: 'cashback',
    CAMPAIGN: 'a promotion',
    ADMIN: 'a bonus credit',
    REFUND: 'a refunded bonus',
}

export interface SweepExpiringBonusesResult {
    usersNotified: number
    notificationsSent: number
    byWindow: Record<BonusReminderWindow, number>
    failures: number
}

interface ExpiringLotRow {
    id: string
    userId: string
    remaining: Decimal
    expiresAt: Date
    source: `${BonusSource}`
    ruleName: string | null
    spendAccount: 'REAL' | 'BONUS'
}

/**
 * Same reasoning as wallet.service.ts's copy: bonus windows are lived in Addis
 * time, so a UTC rendering puts a late-evening expiry on the wrong day. Not
 * shared with that file — it is a private helper there, and this module is not
 * allowed to reach into it.
 */
function formatAddisTime(at: Date): string {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Addis_Ababa',
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(at)
}

/** Rounded, never truncated to "0 hours" — the 2h window is mostly minutes. */
function remainingTimePhrase(from: Date, to: Date): string {
    const minutes = Math.max(1, Math.round((to.getTime() - from.getTime()) / 60000))
    if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`
    const hours = Math.round(minutes / 60)
    return `${hours} hour${hours === 1 ? '' : 's'}`
}

export class BonusReminderService {
    /**
     * Warns players whose bonus is about to expire, so the money is spent or
     * knowingly forfeited rather than vanishing at the next
     * `BonusService.sweepExpired` run.
     *
     * Idempotency is derived from the notifications table itself rather than a
     * "reminded" column on the lot: a BONUS_EXPIRING row whose
     * `metadata.grantId` and `metadata.window` match IS the receipt. The worker
     * ticks every 15 minutes, so without this a 24h window would send ~88
     * notifications instead of one. Because the check is a read followed by a
     * write, it assumes the single-concurrency, single-repeatable-job worker
     * that calls it — two sweeps racing on the same lot could both pass the
     * NOT EXISTS. That is the same shape of assumption `sweepExpired` makes.
     */
    static async sweepExpiring(now: Date = new Date()): Promise<SweepExpiringBonusesResult> {
        const byWindow: Record<BonusReminderWindow, number> = { '24h': 0, '2h': 0 }
        const notifiedUsers = new Set<string>()
        let notificationsSent = 0
        let failures = 0

        for (const window of REMINDER_WINDOWS) {
            // "expiresAt" is `timestamp` WITHOUT time zone holding UTC. Binding a
            // JS Date sends it as timestamptz, which Postgres reconciles through
            // the SESSION timezone and silently shifts the comparison — the bug
            // documented at length in bonus.service.ts's expireForUser. Bind ISO
            // strings and cast explicitly.
            const fromUtc = new Date(now.getTime() + window.fromHours * HOUR_MS).toISOString()
            const toUtc = new Date(now.getTime() + window.toHours * HOUR_MS).toISOString()

            // Liveness is checked live against `users`, the same exclusions
            // campaign.service.ts's processDelivery applies: a frozen account or
            // a load-test bot must not be messaged. `LEFT(username, 5)` rather
            // than a LIKE pattern because `_` is a LIKE wildcard, and 'bot\_t%'
            // needs double-escaping through a JS template literal to survive.
            const lots = await prisma.$queryRaw<ExpiringLotRow[]>`
                SELECT g.id,
                       g."userId",
                       g.remaining,
                       g."expiresAt",
                       g.source::text AS source,
                       r.name AS "ruleName",
                       w."spendAccount"::text AS "spendAccount"
                FROM bonus_grants g
                JOIN users u ON u.id = g."userId"
                JOIN wallets w ON w."userId" = g."userId"
                LEFT JOIN bonus_rules r ON r.id = g."ruleId"
                WHERE g.status = 'ACTIVE'
                  AND g.remaining > 0
                  AND g."expiresAt" > ${fromUtc}::timestamp
                  AND g."expiresAt" <= ${toUtc}::timestamp
                  AND u."accountStatus" = 'ACTIVE'
                  AND u.role = 'PLAYER'
                  AND u."passwordHash" <> 'BOT_ACCOUNT'
                  AND (u.username IS NULL OR LEFT(u.username, 5) <> 'bot_t')
                  AND NOT EXISTS (
                      SELECT 1 FROM notifications n
                      WHERE n."userId" = g."userId"
                        AND n.type = 'BONUS_EXPIRING'
                        AND n.metadata->>'grantId' = g.id
                        AND n.metadata->>'window' = ${window.key}
                  )
                ORDER BY g."userId", g."expiresAt"
            `

            for (const lot of lots) {
                try {
                    await BonusReminderService.notifyOne(lot, window.key, now)
                    notificationsSent++
                    byWindow[window.key]++
                    notifiedUsers.add(lot.userId)
                } catch (err) {
                    // One unreachable player must not cost everyone else their
                    // warning, and a lot skipped here is retried on the next
                    // tick — no receipt was written for it.
                    failures++
                    console.error(
                        `[BonusReminderService] Failed to warn user ${lot.userId} about grant ${lot.id}:`,
                        err instanceof Error ? err.message : err,
                    )
                }
            }
        }

        return { usersNotified: notifiedUsers.size, notificationsSent, byWindow, failures }
    }

    private static async notifyOne(lot: ExpiringLotRow, window: BonusReminderWindow, now: Date): Promise<void> {
        const amount = new Decimal(lot.remaining)
        const origin = lot.ruleName ?? SOURCE_LABELS[lot.source] ?? 'a bonus credit'
        const remaining = remainingTimePhrase(now, lot.expiresAt)

        // The nudge is the whole point of the message. A player on REAL is
        // betting from the wrong bucket, so their bonus cannot be spent no
        // matter how much they play — that, not forgetfulness, is why the money
        // would go unused. On BONUS there is nothing to fix.
        const nudge =
            lot.spendAccount === 'REAL'
                ? 'Switch to Spend Bonus in your wallet to use it.'
                : 'Play before then to use it.'

        await NotificationService.create(
            lot.userId,
            NotificationType.BONUS_EXPIRING,
            'Bonus Expiring Soon ⏳',
            `${amount.toFixed(2)} ETB from ${origin} expires in ${remaining} (${formatAddisTime(lot.expiresAt)}). ${nudge}`,
            {
                grantId: lot.id,
                window,
                amount: amount.toNumber(),
                source: lot.source,
                ruleName: lot.ruleName,
                expiresAt: lot.expiresAt.toISOString(),
                spendAccount: lot.spendAccount,
            },
        )
    }
}
