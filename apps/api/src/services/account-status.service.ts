/**
 * Account status — the only writer of User.accountStatus in the codebase.
 *
 * Replaces the bare `isActive` boolean, which carried no reason, no actor, no
 * timestamp and no expiry, blocked only withdrawals, and could be set solely by
 * a CLI script or a raw UPDATE. Every transition here appends an immutable row
 * saying who did it, why, and when it lifts.
 *
 * Covers staff accounts as well as players: `isActive` already did, so a
 * disabled clerk is SUSPENDED. RESTRICTED is simply never used for staff.
 */

import prisma from '../lib/prisma.js'
import redis from '../lib/redis.js'
import { AccountStatus, NotificationType } from '@world-bingo/shared-types'
import { NotificationService } from './notification.service.js'
import { ZareCashService } from './zarecash.service.js'

/** Free-text `reason` is required; this only buckets it for reporting. */
export const STATUS_CATEGORIES = [
    'RECEIPT_FRAUD',
    'CHARGEBACK',
    'BONUS_ABUSE',
    'MULTI_ACCOUNT',
    'OTHER',
] as const
export type StatusCategory = (typeof STATUS_CATEGORIES)[number]

export interface TransitionInput {
    reason: string
    category?: StatusCategory | null
    /** Auto-return to ACTIVE at this time. Ignored when reinstating. */
    expiresAt?: Date | null
    /** Staff account making the change; null when the expiry pass does. */
    actorId?: string | null
}

const CACHE_PREFIX = 'acct:status:'

/**
 * Short enough that containment lands within half a minute even if an
 * invalidation is lost, long enough that the auth path is not a per-request
 * database read. Every transition deletes the key, so the normal case is
 * immediate.
 */
const CACHE_TTL_SECS = 30

function httpError(statusCode: number, message: string, code?: string): Error {
    return Object.assign(new Error(message), { statusCode, code })
}

export class AccountStatusService {
    private static cacheKey(userId: string): string {
        return `${CACHE_PREFIX}${userId}`
    }

    /**
     * Current status, read through a short Redis cache.
     *
     * Redis is a latency optimisation here, never an authority: any failure
     * falls through to the database rather than failing the request. An auth
     * path that breaks when the cache hiccups is worse than one that is briefly
     * slower.
     */
    static async current(userId: string): Promise<AccountStatus | null> {
        try {
            const hit = await redis.get(AccountStatusService.cacheKey(userId))
            if (hit) return hit as AccountStatus
        } catch {
            // fall through to the database
        }

        const row = await prisma.user.findUnique({
            where: { id: userId },
            select: { accountStatus: true },
        })
        if (!row) return null

        try {
            await redis.set(
                AccountStatusService.cacheKey(userId),
                row.accountStatus,
                'EX',
                CACHE_TTL_SECS,
            )
        } catch {
            // a cache we could not write is not a failed request
        }
        return row.accountStatus as AccountStatus
    }

    /**
     * Drop every cached copy of this account's status.
     *
     * Two caches, not one: the palace casino gateway caches its own resolved
     * user under `tp:user:<account>` keyed by BOTH the dashless id and the
     * username, and it is an enforcement point (`resolveUser` refuses a
     * non-ACTIVE account). Missing it would leave a suspended player able to
     * keep playing third-party casino games until that TTL expired.
     */
    static async invalidate(userId: string, username?: string | null): Promise<void> {
        const keys = [
            AccountStatusService.cacheKey(userId),
            `tp:user:${userId.replace(/-/g, '')}`,
        ]
        if (username) keys.push(`tp:user:${username}`)
        try {
            await redis.del(...keys)
        } catch {
            // The TTL bounds the staleness even when this fails.
        }
    }

    /** Under investigation: no money movement, no new games, login still works. */
    static restrict(userId: string, input: TransitionInput) {
        return AccountStatusService.transition(userId, AccountStatus.RESTRICTED, input)
    }

    /** Login refused outright. */
    static suspend(userId: string, input: TransitionInput) {
        return AccountStatusService.transition(userId, AccountStatus.SUSPENDED, input)
    }

    static reinstate(userId: string, input: Omit<TransitionInput, 'expiresAt' | 'category'>) {
        return AccountStatusService.transition(userId, AccountStatus.ACTIVE, {
            ...input,
            expiresAt: null,
            category: null,
        })
    }

    static history(userId: string) {
        return prisma.accountStatusChange.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 100,
        })
    }

    /**
     * Accounts whose most recent change has fallen due. Used by the hourly pass.
     *
     * Keyed on the newest change per user rather than on any row with a past
     * `expiresAt`, because an account restricted-then-reinstated-then-restricted
     * carries stale expiry rows that must not resurrect an active suspension.
     */
    static async findExpired(limit = 200): Promise<string[]> {
        const due = await prisma.accountStatusChange.findMany({
            where: { expiresAt: { lte: new Date() }, to: { not: AccountStatus.ACTIVE } },
            orderBy: { createdAt: 'desc' },
            select: { userId: true, createdAt: true },
            take: limit * 4,
        })

        const seen = new Set<string>()
        const candidates: string[] = []
        for (const row of due) {
            if (seen.has(row.userId)) continue
            seen.add(row.userId)
            candidates.push(row.userId)
        }
        if (candidates.length === 0) return []

        // Only those still non-ACTIVE, and only where the due row is genuinely
        // the latest one for that user.
        const latest = await prisma.accountStatusChange.findMany({
            where: { userId: { in: candidates } },
            orderBy: { createdAt: 'desc' },
            select: { userId: true, expiresAt: true, to: true, createdAt: true },
        })
        const newestPerUser = new Map<string, { expiresAt: Date | null; to: string }>()
        for (const row of latest) {
            if (!newestPerUser.has(row.userId)) {
                newestPerUser.set(row.userId, { expiresAt: row.expiresAt, to: row.to })
            }
        }

        const ready = candidates.filter((id) => {
            const newest = newestPerUser.get(id)
            return (
                newest !== undefined &&
                newest.to !== AccountStatus.ACTIVE &&
                newest.expiresAt !== null &&
                newest.expiresAt.getTime() <= Date.now()
            )
        })
        return ready.slice(0, limit)
    }

    private static async transition(userId: string, to: AccountStatus, input: TransitionInput) {
        const reason = (input.reason ?? '').trim()
        if (!reason) throw httpError(400, 'A reason is required', 'reason_required')

        const result = await prisma.$transaction(async (tx) => {
            const user = await tx.user.findUnique({
                where: { id: userId },
                select: { accountStatus: true, username: true },
            })
            if (!user) throw httpError(404, 'Account not found', 'not_found')

            const from = user.accountStatus as AccountStatus

            // Re-applying the status an account already holds appends nothing.
            // Two clerks reacting to the same report should not produce two
            // suspensions and two notifications.
            if (from === to) {
                const existing = await tx.accountStatusChange.findFirst({
                    where: { userId },
                    orderBy: { createdAt: 'desc' },
                })
                return { change: existing, from, changed: false, username: user.username }
            }

            await tx.user.update({ where: { id: userId }, data: { accountStatus: to } })

            const change = await tx.accountStatusChange.create({
                data: {
                    userId,
                    from,
                    to,
                    reason,
                    category: input.category ?? null,
                    actorId: input.actorId ?? null,
                    expiresAt: input.expiresAt ?? null,
                },
            })

            await tx.auditLog.create({
                data: {
                    action: `account.${to.toLowerCase()}`,
                    actorId: input.actorId ?? null,
                    target: `user:${userId}`,
                    detail: {
                        from,
                        to,
                        reason,
                        category: input.category ?? null,
                        expiresAt: input.expiresAt?.toISOString() ?? null,
                    },
                },
            })

            return { change, from, changed: true, username: user.username }
        })

        // Always invalidate, even on a no-op: the cache may hold a value that
        // predates a change made by another process.
        await AccountStatusService.invalidate(userId, result.username)

        if (result.changed) {
            await AccountStatusService.announce(userId, to, reason)
        }

        return result.change
    }

    /**
     * Post-commit side effects. Deliberately outside the transaction, and
     * deliberately unable to fail it: a notification that did not send, or an
     * upstream mirror that did not land, must never leave the account
     * un-contained locally. The local status is what protects our own balance.
     */
    private static async announce(userId: string, to: AccountStatus, reason: string): Promise<void> {
        const copy = {
            [AccountStatus.ACTIVE]: {
                title: 'Account reinstated',
                body: 'Your account is active again. Deposits, withdrawals and games are available.',
            },
            [AccountStatus.RESTRICTED]: {
                title: 'Account under review',
                body: 'Deposits, withdrawals and joining games are paused while we review your account. You can still reach us through support.',
            },
            [AccountStatus.SUSPENDED]: {
                title: 'Account suspended',
                body: 'Your account has been suspended. Please contact support.',
            },
        }[to]

        try {
            await NotificationService.create(
                userId,
                NotificationType.ACCOUNT_STATUS_CHANGED,
                copy.title,
                copy.body,
                { status: to },
            )
        } catch (err) {
            console.error('[AccountStatus] notify failed for %s: %s', userId, (err as Error)?.message)
        }

        try {
            const sync = await ZareCashService.syncPlayerFreeze(
                userId,
                to !== AccountStatus.ACTIVE,
                reason,
            )
            if (!sync.ok) {
                console.error(
                    '[AccountStatus] ZareCash mirror failed for %s (local status stands): %s',
                    userId,
                    sync.error,
                )
            }
        } catch (err) {
            console.error(
                '[AccountStatus] ZareCash mirror threw for %s (local status stands): %s',
                userId,
                (err as Error)?.message,
            )
        }
    }
}
