/**
 * ZareCash hosted checkout.
 *
 * Split from zarecash.service.ts on purpose: that file owns the record-and-review
 * flow, where WE hold the receipt reference and create the deposit. Here ZareCash
 * collects the receipt and creates the deposit, so the local Transaction cannot
 * exist until a depositId does. Keeping the two lifecycles in separate files
 * keeps either one readable in a single pass.
 */

import prisma from '../lib/prisma.js'
import { zarecashClient } from '../gateways/payment/zarecash/client.js'
import { isZareCashEnabled } from '../gateways/payment/zarecash/config.js'
import { ZareCashError } from '../gateways/payment/zarecash/types.js'
import { PaymentStatus, TransactionType } from '@world-bingo/shared-types'
import { reportError } from '../lib/sentry.js'

/** The contract's open window. Overwritten by the expiresAt ZareCash returns. */
const OPEN_WINDOW_MS = 20 * 60 * 1000

/**
 * How long past `expiresAt` the hosted page still accepts a receipt. The session
 * is `open` for 20 minutes, then keeps taking a receipt for a further 24 hours
 * from a player who already sent money — only past that is it truly finished.
 */
const RECEIPT_WINDOW_MS = 24 * 60 * 60 * 1000

/** Bound on one sweep run, so a backlog cannot pin the worker. */
const SWEEP_BATCH = 200

/**
 * How many of a player's unlinked sessions we are willing to poll to find the one
 * a depositId belongs to. Bounded so a pathological account cannot turn a single
 * claim into an unbounded fan-out of HTTP calls.
 */
const RESOLVE_CANDIDATES = 5

/**
 * `code` is a stable, non-secret discriminator echoed to the caller. Two very
 * different operational faults produce the same 503 here — the gateway switched
 * off, versus a returnUrl the provider rejects — and telling them apart used to
 * require container logs. It names the fault, never the values behind it.
 */
function httpError(statusCode: number, message: string, code?: string): Error {
    return Object.assign(new Error(message), { statusCode, code })
}

function webBaseUrl(): string {
    return (process.env.WEB_BASE_URL || 'https://www.aradabingo.bet').replace(/\/+$/, '')
}

async function depositLimits(): Promise<{ min: number; max: number }> {
    const [minRow, maxRow] = await Promise.all([
        prisma.siteSetting.findUnique({ where: { key: 'min_deposit_amount' } }),
        prisma.siteSetting.findUnique({ where: { key: 'max_deposit_amount' } }),
    ])
    return { min: minRow ? Number(minRow.value) : 10, max: maxRow ? Number(maxRow.value) : 50000 }
}

type SessionLike = {
    id: string
    userId: string
    amount: unknown
    methodCode: string
    transactionId?: string | null
}

export class ZareCashCheckoutService {
    /**
     * Create a hosted payment page and return where to send the player.
     *
     * Deliberately creates NO Transaction. Most sessions are abandoned, and a
     * PENDING_REVIEW row per abandonment would fill the admin deposit queue with
     * ghosts a clerk could approve by hand.
     */
    static async createSession(
        userId: string,
        amount: number,
        methodCode: string,
    ): Promise<{ url: string; expiresAt: Date; localId: string }> {
        // Same player-facing message as the misconfiguration path below, because
        // neither is the player's problem — but they are very different problems
        // for whoever is on call, so say which one in the log.
        if (!isZareCashEnabled()) {
            console.error(
                '[ZareCashCheckout] refused: ZARECASH_ENABLED is not "true" (got %j). The hosted-checkout payment method is enabled in the database but the gateway is switched off in the environment.',
                process.env.ZARECASH_ENABLED ?? null,
            )
            throw httpError(503, 'Deposits are temporarily unavailable', 'gateway_disabled')
        }

        // Validate before creating. The contract warns that an amount outside every
        // method's limits produces a hosted page that can accept nothing — a far
        // worse failure for the player than a form error here.
        const { min, max } = await depositLimits()
        if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'Invalid amount')
        if (amount < min) throw httpError(400, `Minimum deposit amount is ${min} Birr`)
        if (amount > max) throw httpError(400, `Maximum deposit amount is ${max} Birr`)

        const method = await prisma.paymentMethod.findUnique({ where: { code: methodCode } })
        if (
            !method ||
            !method.enabled ||
            method.type !== 'DEPOSIT' ||
            !method.hostedCheckout ||
            method.gateway !== 'zarecash'
        ) {
            throw httpError(400, 'That payment method is not available')
        }

        const returnUrl = `${webBaseUrl()}/wallet`
        const row = await prisma.zareCashCheckoutSession.create({
            data: {
                userId,
                amount,
                methodCode,
                returnUrl,
                status: 'open',
                expiresAt: new Date(Date.now() + OPEN_WINDOW_MS),
            },
        })

        try {
            const session = await zarecashClient().createCheckoutSession(
                { playerRef: userId, amount, returnUrl },
                row.id,
            )
            const expiresAt = new Date(session.expiresAt)
            await prisma.zareCashCheckoutSession.update({
                where: { id: row.id },
                data: { sessionId: session.id, status: session.status, expiresAt },
            })
            return { url: session.url, expiresAt, localId: row.id }
        } catch (err) {
            // invalid_return_url is a misconfiguration, not a player problem: it
            // fails every attempt until an operator fixes the console's Custom URL.
            // Alarm on it rather than letting it read as a transient blip.
            if (err instanceof ZareCashError && err.code === 'invalid_return_url') {
                console.error('[ZareCashCheckout] returnUrl %s rejected by ZareCash', returnUrl)
                reportError(err, { phase: 'zarecash-checkout-return-url', returnUrl })
                throw httpError(503, 'Deposits are temporarily unavailable', 'return_url_rejected')
            }
            if (err instanceof ZareCashError && err.code === 'rate_limited') {
                throw httpError(429, 'Too many attempts — please try again shortly')
            }
            throw err
        }
    }

    /**
     * Find the session a depositId belongs to.
     *
     * Deliberately NOT "the caller's most recent session". A player can have more
     * than one session in flight — they can open the modal twice — and picking the
     * newest would eventually attach a deposit to the wrong one, which means a
     * wrong amount credited to a real wallet. Ask ZareCash which session produced
     * this deposit instead.
     */
    static async resolveSessionForDeposit(userId: string, depositId: string) {
        const direct = await prisma.zareCashCheckoutSession.findUnique({ where: { depositId } })
        if (direct) return direct.userId === userId ? direct : null

        const candidates = await prisma.zareCashCheckoutSession.findMany({
            where: {
                userId,
                transactionId: null,
                sessionId: { not: null },
                status: { in: ['open', 'submitted'] },
            },
            orderBy: { createdAt: 'desc' },
            take: RESOLVE_CANDIDATES,
        })

        for (const candidate of candidates) {
            let remote
            try {
                remote = await zarecashClient().getCheckoutSession(candidate.sessionId as string)
            } catch {
                // A session we cannot read tells us nothing. Try the next one; the
                // sweep revisits this session later.
                continue
            }
            if (remote.depositId !== depositId) continue
            await prisma.zareCashCheckoutSession.update({
                where: { id: candidate.id },
                data: { depositId, status: remote.status },
            })
            return { ...candidate, depositId, status: remote.status }
        }
        return null
    }

    /**
     * Create the local Transaction for a deposit ZareCash has accepted a receipt
     * for. PENDING_REVIEW and nothing more — crediting is the webhook's job.
     */
    static async materialise(
        session: SessionLike,
        depositId: string,
        amount?: number,
    ): Promise<string> {
        if (session.transactionId) return session.transactionId

        const existing = await prisma.transaction.findUnique({ where: { gatewayRef: depositId } })
        if (existing) {
            await prisma.zareCashCheckoutSession.update({
                where: { id: session.id },
                data: { transactionId: existing.id, depositId, status: 'submitted' },
            })
            return existing.id
        }

        try {
            const tx = await prisma.transaction.create({
                data: {
                    userId: session.userId,
                    type: TransactionType.DEPOSIT,
                    amount: amount ?? Number(session.amount),
                    status: PaymentStatus.PENDING_REVIEW,
                    // The routing marker. The admin double-pay guard keys on it, so
                    // without this a clerk could hand-approve a deposit ZareCash is
                    // also about to approve.
                    gateway: 'zarecash',
                    gatewayRef: depositId,
                    note: session.methodCode,
                },
            })
            await prisma.zareCashCheckoutSession.update({
                where: { id: session.id },
                data: { transactionId: tx.id, depositId, status: 'submitted' },
            })
            return tx.id
        } catch (err: any) {
            // Unique violation on gatewayRef: the claim and the webhook raced and
            // the other one won. Its row is the right answer.
            if (err?.code === 'P2002') {
                const winner = await prisma.transaction.findUnique({
                    where: { gatewayRef: depositId },
                })
                if (winner) {
                    await prisma.zareCashCheckoutSession.update({
                        where: { id: session.id },
                        data: { transactionId: winner.id, depositId, status: 'submitted' },
                    })
                    return winner.id
                }
            }
            throw err
        }
    }

    /**
     * Called when the player lands back on /wallet with ?deposit=dp_…
     *
     * NEVER credits. `status=pending` on that redirect means a receipt was
     * accepted, not that money arrived — the contract says so twice.
     */
    static async claimDeposit(userId: string, depositId: string): Promise<{ transactionId: string }> {
        const ref = String(depositId ?? '').trim()
        if (!ref) throw httpError(400, 'Missing deposit reference')

        const session = await ZareCashCheckoutService.resolveSessionForDeposit(userId, ref)
        // A query parameter is not proof. If it names no session of this player's,
        // it is not theirs to claim.
        if (!session) throw httpError(404, 'Deposit not found')

        const transactionId = await ZareCashCheckoutService.materialise(session, ref)
        return { transactionId }
    }

    /**
     * Last resort before a deposit event is quarantined: the player paid on the
     * hosted page and never came back, so `claim` never ran and no local row
     * exists. This is routine, not exotic — a redirect back to our site is a
     * courtesy, not a guarantee.
     *
     * Returns the local transaction id, or null when this deposit belongs to no
     * session of ours (a genuinely unknown ref, which must still quarantine).
     */
    static async adoptFromWebhook(data: Record<string, any>): Promise<string | null> {
        const depositId = String(data?.id ?? '').trim()
        const playerRef = String(data?.playerRef ?? '').trim()
        if (!depositId || !playerRef) return null

        const session = await ZareCashCheckoutService.resolveSessionForDeposit(playerRef, depositId)
        if (!session) return null

        // statedAmount is what the player told the hosted page they sent. It is
        // only the row's placeholder — approveDeposit credits approvedAmount.
        const stated = Number(data?.statedAmount)
        return ZareCashCheckoutService.materialise(
            session,
            depositId,
            Number.isFinite(stated) && stated > 0 ? stated : undefined,
        )
    }

    /**
     * Two passes, both about sessions rather than events — the existing
     * GET /v1/events sweep already covers a missed webhook.
     */
    static async sweepSessions(): Promise<{ dead: number; linked: number }> {
        if (!isZareCashEnabled()) return { dead: 0, linked: 0 }

        const dead = await prisma.zareCashCheckoutSession.updateMany({
            where: {
                transactionId: null,
                depositId: null,
                status: { in: ['open', 'submitted'] },
                expiresAt: { lt: new Date(Date.now() - RECEIPT_WINDOW_MS) },
            },
            data: { status: 'dead' },
        })

        const pending = await prisma.zareCashCheckoutSession.findMany({
            where: {
                transactionId: null,
                sessionId: { not: null },
                status: { in: ['open', 'submitted'] },
            },
            orderBy: { createdAt: 'asc' },
            take: SWEEP_BATCH,
        })

        let linked = 0
        for (const session of pending) {
            let remote
            try {
                remote = await zarecashClient().getCheckoutSession(session.sessionId as string)
            } catch (err) {
                // Unreadable now, readable next run. Never let one bad session end
                // the pass for the ones behind it.
                console.warn(
                    '[ZareCashCheckout] could not read session %s: %s',
                    session.sessionId,
                    (err as Error)?.message,
                )
                continue
            }
            if (remote.depositId) {
                await ZareCashCheckoutService.materialise(session, remote.depositId)
                linked += 1
            } else if (remote.status !== session.status) {
                await prisma.zareCashCheckoutSession.update({
                    where: { id: session.id },
                    data: { status: remote.status },
                })
            }
        }

        return { dead: dead.count, linked }
    }
}
