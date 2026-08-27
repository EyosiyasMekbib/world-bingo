/**
 * ZareCash domain mapping.
 *
 * The only module that knows about both Transaction rows and ZareCash payloads.
 * Deposit approval always funnels through WalletService.approveDeposit — that
 * function also grants bonuses, fires the referral payout, and emits metrics.
 */

import prisma from '../lib/prisma.js'
import { zarecashClient } from '../gateways/payment/zarecash/client.js'
import { resolveMethod } from '../gateways/payment/zarecash/method-config.js'
import { zarecashConfig, isZareCashEnabled } from '../gateways/payment/zarecash/config.js'
import { WalletService } from './wallet.service.js'
import { PaymentStatus, NotificationType } from '@world-bingo/shared-types'
import { ZareCashError } from '../gateways/payment/zarecash/types.js'
import { NotificationService } from './notification.service.js'
import { ZareCashCheckoutService } from './zarecash-checkout.service.js'
import { wbWithdrawalsTotal } from '../lib/metrics.js'
import { getQueue, QUEUE_NAMES } from '../lib/queue.js'
import { reportError, reportWarning } from '../lib/sentry.js'

/**
 * How many pages of GET /v1/events one sweep run may walk before it gives up and
 * logs. At the default page size of 100 this is 2 000 events per run, which is
 * far more than a realistic webhook outage produces and still bounded enough
 * that a pathological backlog cannot pin the worker forever.
 */
const SWEEP_MAX_PAGES = 20
const SWEEP_PAGE_SIZE = 100

/**
 * How long a terminal event whose `gatewayRef` we do not recognise stays
 * retryable before we give up on it.
 *
 * The race this exists for is short: `submitWithdrawal` POSTs, ZareCash records
 * and enqueues `withdrawal.approved` before the HTTP response reaches us, and
 * our own `gatewayRef` write lands a moment later. A webhook that wins that race
 * finds no row. Retrying for a day covers it with enormous margin. Past that the
 * ref is genuinely unknown to us (an event for a different tenant, a row we hard
 * deleted) and retrying forever would just be an infinite loop, so we stamp it
 * processed with the error recorded and alarm instead.
 */
const UNKNOWN_REF_GRACE_MS = 24 * 60 * 60 * 1000

/**
 * How old an unprocessed `ZareCashEvent` must be before the stranded-event pass
 * re-enqueues it. Anything younger is very likely a job that is simply still in
 * flight (or waiting on a BullMQ backoff), and re-enqueuing that would just
 * duplicate work.
 */
const STRANDED_MIN_AGE_MS = 10 * 60 * 1000

/** Raised when a terminal event names a `gatewayRef` no local row carries. */
export class UnknownGatewayRefError extends Error {
    readonly gatewayRef: string
    constructor(eventType: string, gatewayRef: unknown) {
        super(`${eventType} names gatewayRef ${String(gatewayRef)}, which matches no local transaction`)
        this.name = 'UnknownGatewayRefError'
        this.gatewayRef = String(gatewayRef)
    }
}

/**
 * Raised only when we reached ZareCash and it reported a keyspace that
 * contradicts ZARECASH_MODE. This is the ONE ZareCash boot failure that is fatal
 * — index.ts rethrows this and swallows everything else, so a provider blip or a
 * Redis outage can never take the whole API down over a payment gateway.
 */
export class ZareCashModeMismatchError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ZareCashModeMismatchError'
    }
}

export class ZareCashService {
    /** Idempotency keys are derived from our own row, so every retry is safe. */
    static depositKey(transactionId: string): string {
        return `dep_${transactionId}`
    }

    static withdrawalKey(transactionId: string): string {
        return `wd_${transactionId}`
    }

    /**
     * Refuse to run against the wrong keyspace. Contract checklist item 9 — the
     * cheapest guard against a test key in production, or a live key in CI.
     *
     * Two distinct failure modes here, deliberately handled differently — do not
     * collapse them back into a single throw:
     *  - We reached ZareCash and it told us the wrong keyspace: FATAL. This is
     *    the guard's entire reason to exist.
     *  - We could not reach ZareCash at all (network error, timeout, 401, 5xx —
     *    see client.ts, which wraps all of these in ZareCashError): NOT fatal.
     *    That tells us nothing about whether the key is correct, only that the
     *    provider is unavailable right now, and bingo games have nothing to do
     *    with ZareCash's uptime. Log it loudly, report it, and let boot continue
     *    unverified rather than taking the whole API down over a payment
     *    provider blip.
     */
    static async assertMode(): Promise<void> {
        const cfg = zarecashConfig()
        if (!cfg.enabled) return

        let float
        try {
            float = await zarecashClient().getFloat()
        } catch (err) {
            console.error(
                '[ZareCash] could not verify keyspace at boot (continuing unverified):',
                (err as Error)?.message,
            )
            reportError(err, { phase: 'zarecash-assert-mode' })
            return
        }

        if (float.mode !== cfg.mode) {
            throw new ZareCashModeMismatchError(
                `ZareCash mode mismatch: ZARECASH_MODE=${cfg.mode} but the API key reports "${float.mode}". Refusing to start.`,
            )
        }
        console.log('[ZareCash] connected in %s mode (available float: %s ETB)', float.mode, float.available)
    }

    /**
     * Backfill anything a webhook outage lost.
     *
     * A reconciliation sweep wants the NEWEST events. It deliberately does NOT
     * persist a cursor between runs, and that is the whole point:
     *
     * `GET /v1/events` orders `createdAt DESC` and returns `nextCursor` = the id
     * of the LAST row of the page — i.e. the OLDEST one — which Prisma then
     * resumes *after*, in the same descending order. A stored cursor therefore
     * walks strictly BACKWARDS through history: run 1 scans the newest 100, run 2
     * scans 101-200-newest, and events created since the previous run are never
     * scanned at all. Eventually the walk reaches the start of history,
     * `nextCursor` goes null, the stored cursor freezes, and every subsequent run
     * re-scans the same ancient page reporting `scanned=100 replayed=0` — looking
     * perfectly healthy while reconciling nothing. Verified against the emitter:
     * paymentmgmtv2 `v1.service.ts` `listEvents`.
     *
     * So: every run starts from the newest page and pages FORWARD (older) within
     * that single run, stopping as soon as it reaches a page it has already fully
     * processed — which on a healthy day is page one, making the sweep cheap.
     * That also fixes the old one-page-per-run limit, under which a backlog larger
     * than a single page could never drain.
     *
     * Dedup is processedAt-aware, not existence-only — mirrors webhook.ts's P2002
     * handling. A row can exist with processedAt still null (the insert that
     * created it succeeded but the enqueue right after it threw — a transient
     * Redis blip is enough), and unlike a webhook-delivered event there is no
     * redelivery to rescue a sweep-discovered one: ZareCash only redelivers
     * webhooks, and these events are by definition ones that were never delivered
     * as a webhook. So "exists" alone must never mean "skip" — only "exists AND
     * processedAt is set" does.
     */
    static async sweepEvents(): Promise<{
        scanned: number
        replayed: number
        pages: number
        truncated: boolean
    }> {
        let cursor: string | undefined = undefined
        let scanned = 0
        let replayed = 0
        let pages = 0
        let truncated = false

        while (pages < SWEEP_MAX_PAGES) {
            const page: { data: Array<{ id: string; type: string }>; nextCursor: string | null } =
                await zarecashClient().listEvents({ cursor, limit: SWEEP_PAGE_SIZE })
            pages++
            scanned += page.data.length

            const { replayed: pageReplayed, caughtUp } = await ZareCashService.replayPage(page.data)
            replayed += pageReplayed

            // Every event on this page was already recorded AND already processed,
            // so everything older than it necessarily was too. This is the normal
            // exit on a healthy day, on page one.
            if (caughtUp) return { scanned, replayed, pages, truncated }

            // End of history.
            if (!page.nextCursor) return { scanned, replayed, pages, truncated }
            cursor = page.nextCursor
        }

        // Budget exhausted with more history still to walk. Say so loudly rather
        // than silently truncating — the next run starts from the newest page
        // again, so a backlog this deep needs a human to look at it.
        truncated = true
        console.error(
            '[ZareCash] sweep stopped after %d pages (%d events) with more still unscanned — backlog exceeds one run\'s budget',
            pages,
            scanned,
        )
        reportWarning('ZareCash reconciliation sweep hit its page budget with backlog remaining', {
            phase: 'zarecash-sweep-truncated',
            pages,
            scanned,
            replayed,
        })
        return { scanned, replayed, pages, truncated }
    }

    /**
     * Record and enqueue everything on one page that we have not already fully
     * handled. `caughtUp` is true only when every event on the page was already
     * present AND already processed — the signal that paging further back is
     * pointless.
     */
    private static async replayPage(
        events: Array<{ id: string; type: string }>,
    ): Promise<{ replayed: number; caughtUp: boolean }> {
        if (events.length === 0) return { replayed: 0, caughtUp: true }

        const ids = events.map((e) => e.id)
        const known = await prisma.zareCashEvent.findMany({
            where: { id: { in: ids } },
            select: { id: true, processedAt: true },
        })
        const knownProcessedAt = new Map(known.map((k) => [k.id, k.processedAt]))

        let replayed = 0
        let caughtUp = true

        for (const evt of events) {
            if (knownProcessedAt.has(evt.id)) {
                // Exists already. Only re-enqueue if it was never processed —
                // otherwise this is a genuine repeat and must stay a no-op.
                if (knownProcessedAt.get(evt.id) === null) {
                    await getQueue(QUEUE_NAMES.ZARECASH_EVENT).add('process', { eventId: evt.id })
                    replayed++
                    caughtUp = false
                }
                continue
            }

            caughtUp = false

            try {
                await prisma.zareCashEvent.create({
                    data: { id: evt.id, type: evt.type, payload: evt as unknown as object },
                })
            } catch (err: any) {
                // P2002 = unique violation = someone else (a webhook delivery
                // racing this sweep, or an overlapping sweep run) inserted this
                // id between our findMany snapshot and this create. Same rule
                // as above: re-enqueue only if it landed unprocessed. Any other
                // error is a genuine failure and must propagate — but must not
                // abort the events already handled earlier in this page.
                if (err?.code === 'P2002') {
                    const existing = await prisma.zareCashEvent.findUnique({
                        where: { id: evt.id },
                        select: { processedAt: true },
                    })
                    if (existing && existing.processedAt === null) {
                        await getQueue(QUEUE_NAMES.ZARECASH_EVENT).add('process', { eventId: evt.id })
                        replayed++
                    }
                    continue
                }
                throw err
            }
            await getQueue(QUEUE_NAMES.ZARECASH_EVENT).add('process', { eventId: evt.id })
            replayed++
        }

        return { replayed, caughtUp }
    }

    /**
     * Re-enqueue events stranded at `processedAt = null`.
     *
     * Nothing else revisits them. The webhook route returns 200 BEFORE processing,
     * so ZareCash never redelivers; the event worker gets a handful of BullMQ
     * attempts and then the job is gone for good. A `withdrawal.rejected` that
     * arrives during a deploy and throws a connection error on each attempt dies
     * with `processedAt` null — leaving a player debited for a payout ZareCash
     * refused, recoverable only by hand.
     *
     * The `processedAt` index exists for exactly this query. Only events older
     * than STRANDED_MIN_AGE_MS are touched, so a job that is merely still in
     * flight (or sitting on a BullMQ backoff) is left alone.
     */
    static async requeueStrandedEvents(limit = 200): Promise<{ found: number; requeued: number }> {
        const cutoff = new Date(Date.now() - STRANDED_MIN_AGE_MS)
        const stranded = await prisma.zareCashEvent.findMany({
            where: { processedAt: null, receivedAt: { lt: cutoff } },
            select: { id: true, type: true, error: true, receivedAt: true },
            orderBy: { receivedAt: 'asc' },
            take: limit,
        })

        if (stranded.length === 0) return { found: 0, requeued: 0 }

        let requeued = 0
        for (const evt of stranded) {
            await getQueue(QUEUE_NAMES.ZARECASH_EVENT).add('process', { eventId: evt.id })
            requeued++
        }

        console.warn(
            '[ZareCash] re-enqueued %d stranded event(s); oldest %s received %s, last error: %s',
            requeued,
            stranded[0].type,
            stranded[0].receivedAt.toISOString(),
            stranded[0].error ?? 'none recorded',
        )
        reportWarning(`ZareCash re-enqueued ${requeued} stranded event(s)`, {
            phase: 'zarecash-stranded-requeue',
            found: stranded.length,
            requeued,
            oldestReceivedAt: stranded[0].receivedAt.toISOString(),
            oldestType: stranded[0].type,
        })

        return { found: stranded.length, requeued }
    }

    static async submitDeposit(transactionId: string): Promise<void> {
        const tx = await prisma.transaction.findUnique({ where: { id: transactionId } })
        if (!tx) return

        const method = await resolveMethod(tx.note)

        let res
        try {
            res = await zarecashClient().createDeposit(
                {
                    playerRef: tx.userId,
                    amount: Number(tx.amount),
                    methodCode: method?.gatewayMethodCode ?? tx.note ?? '',
                    receiptRef: tx.paymentTransactionId ?? '',
                    payerName: tx.senderName ?? undefined,
                    payerAccount: tx.senderAccount ?? undefined,
                },
                ZareCashService.depositKey(transactionId),
            )
        } catch (err) {
            const zc = err as ZareCashError
            // A permanent refusal (duplicate_receipt, amount_out_of_range, …) will
            // never succeed on retry. Reject locally so the deposit does not sit in
            // review forever. No wallet change — nothing was ever credited.
            if (zc?.permanent) {
                await prisma.transaction.updateMany({
                    where: { id: transactionId, status: PaymentStatus.PENDING_REVIEW },
                    data: { status: PaymentStatus.REJECTED, note: `ZareCash refused (${zc.code}): ${zc.message}` },
                })
                return
            }
            throw err
        }

        await prisma.transaction.update({ where: { id: transactionId }, data: { gatewayRef: res.id } })

        // Test mode approves clean refs inline. Credit now rather than waiting for
        // the webhook. approveDeposit can throw here — the row is no longer
        // PENDING_REVIEW (a redelivery of this same job after an earlier run already
        // credited it) or the amount is not positive (approvedAmount === 0 from
        // ZareCash). Neither case is retryable, so swallow it: leave the row for the
        // webhook (or a human) rather than failing the BullMQ job and retrying.
        if (res.status === 'APPROVED') {
            try {
                await WalletService.approveDeposit(transactionId, res.approvedAmount ?? Number(tx.amount))
            } catch (err) {
                const message = (err as Error).message
                // Only these two are the known, non-retryable shapes: a redelivery
                // that already credited the row, or ZareCash's own 0-amount
                // contract violation. Anything else (Wallet not found, a Prisma
                // error, …) is a genuine failure and must not be swallowed.
                if (message === 'Invalid transaction' || message === 'Adjusted amount must be a positive number') {
                    console.warn('[ZareCash] deposit %s not credited inline: %s', transactionId, message)
                } else {
                    throw err
                }
            }
        }
    }

    /**
     * Submit a payout the player has ALREADY been debited for.
     *
     * A permanent failure must refund, or the player stays debited for a payout
     * that was never accepted. A retryable failure must NOT refund — the job
     * retries. `withdrawal_pending` is classified retryable on purpose: it means
     * our state and ZareCash's disagree, and refunding could double-pay a payout
     * that is genuinely in flight. The sweep resolves it.
     */
    static async submitWithdrawal(job: {
        transactionId: string
        methodCode: string
        destinationAccount: string
        destinationName?: string
    }): Promise<void> {
        const tx = await prisma.transaction.findUnique({ where: { id: job.transactionId } })
        if (!tx || tx.status !== PaymentStatus.PENDING_REVIEW) return

        const method = await resolveMethod(job.methodCode)

        let res
        try {
            res = await zarecashClient().createWithdrawal(
                {
                    playerRef: tx.userId,
                    amount: Number(tx.amount),
                    methodCode: method?.gatewayMethodCode ?? job.methodCode,
                    destinationAccount: job.destinationAccount,
                    destinationName: job.destinationName,
                },
                ZareCashService.withdrawalKey(job.transactionId),
            )
        } catch (err) {
            const zc = err as ZareCashError
            if (zc?.permanent) {
                await WalletService.rejectWithdrawal(
                    job.transactionId,
                    `ZareCash refused the payout (${zc.code}): ${zc.message}`,
                )
                return
            }
            throw err
        }

        await prisma.transaction.update({ where: { id: job.transactionId }, data: { gatewayRef: res.id } })

        // Terminal states can arrive INLINE, not only as a webhook. Verified
        // against the emitter: WithdrawalsService.create settles the sandbox happy
        // path immediately (`settleSandbox`) and returns state 'approved' — and it
        // records AND enqueues `withdrawal.approved` before the HTTP response even
        // reaches us. Handling only 'rejected' left an approved payout sitting in
        // PENDING_REVIEW until (or unless) the webhook rescued it.
        switch (res.state) {
            case 'rejected':
                await ZareCashService.refundWithdrawalIfPending(
                    job.transactionId,
                    'ZareCash rejected the payout',
                )
                break
            case 'cancelled':
                await ZareCashService.refundWithdrawalIfPending(
                    job.transactionId,
                    'Payout was cancelled at ZareCash',
                )
                break
            case 'approved':
                await ZareCashService.settleApprovedWithdrawal(job.transactionId, res.settlementRef)
                break
            default:
                // pending / queued_float / risk_hold all stay PENDING_REVIEW; the
                // terminal state arrives as a webhook.
                break
        }
    }

    /**
     * Refund a payout that is still PENDING_REVIEW, tolerating the case where the
     * webhook for the very same terminal state got there first.
     *
     * Shared by the inline path above and the webhook handler, so the two can race
     * freely: rejectWithdrawal's claim is atomic, and the loser sees exactly one
     * benign message.
     */
    private static async refundWithdrawalIfPending(transactionId: string, reason: string): Promise<void> {
        try {
            await WalletService.rejectWithdrawal(transactionId, reason)
        } catch (err) {
            if ((err as Error).message === 'Transaction is not pending review') {
                console.log('[ZareCash] withdrawal %s already resolved, skipping duplicate refund', transactionId)
                return
            }
            // Anything else (Transaction not found, Wallet not found, a Prisma
            // error, …) is a genuine failure and must not be swallowed — a lost
            // refund leaves the player permanently debited.
            throw err
        }
    }

    /**
     * Dispatch a received webhook.
     *
     * Keyed on the envelope `type`, never on `data.status`: the withdrawal payload
     * (WithdrawalsService.payload) carries no status field at all.
     */
    static async processEvent(eventId: string): Promise<void> {
        const row = await prisma.zareCashEvent.findUnique({ where: { id: eventId } })
        if (!row || row.processedAt) return

        const envelope = row.payload as { type?: string; data?: Record<string, any> }
        const data = envelope?.data ?? {}

        try {
            switch (row.type) {
                case 'deposit.approved':
                    await ZareCashService.onDepositApproved(data)
                    break
                case 'deposit.rejected':
                    await ZareCashService.onDepositRejected(data)
                    break
                case 'withdrawal.approved':
                    await ZareCashService.onWithdrawalApproved(data)
                    break
                case 'withdrawal.rejected':
                    await ZareCashService.onWithdrawalRefunded(data, 'ZareCash rejected the payout')
                    break
                case 'withdrawal.cancelled':
                    await ZareCashService.onWithdrawalRefunded(data, 'Payout was cancelled at ZareCash')
                    break
                case 'withdrawal.queued_float':
                    await ZareCashService.onWithdrawalQueued(data)
                    break
                case 'withdrawal.risk_hold':
                    await ZareCashService.onWithdrawalRiskHold(data)
                    break
                case 'float.low':
                    await ZareCashService.onFloatLow(data)
                    break
                default:
                    console.log('[ZareCash] unhandled event type %s (%s)', row.type, eventId)
            }
            await prisma.zareCashEvent.update({
                where: { id: eventId },
                data: { processedAt: new Date(), error: null },
            })
        } catch (err) {
            // A terminal event naming a gatewayRef we do not recognise must NOT be
            // stamped processed. The likely cause is a race we lose by design:
            // ZareCash records and enqueues `withdrawal.approved` before the POST
            // response carrying the id reaches us, so the webhook can land before
            // our own `gatewayRef` write. Stamping it would permanently consume the
            // event and strand the row in PENDING_REVIEW forever, with the admin
            // guard refusing both manual actions. Leave processedAt null so the
            // stranded-event pass retries once the ref exists.
            if (err instanceof UnknownGatewayRefError) {
                const stillYoung = Date.now() - row.receivedAt.getTime() < UNKNOWN_REF_GRACE_MS
                await prisma.zareCashEvent.update({
                    where: { id: eventId },
                    // Past the grace window the ref is genuinely unknown to us, not
                    // merely early. Stamp it so we stop retrying forever, but alarm
                    // — an unrecognisable terminal money event is not routine.
                    data: stillYoung
                        ? { error: err.message }
                        : { error: err.message, processedAt: new Date() },
                })
                if (stillYoung) {
                    console.warn('[ZareCash] %s: %s — leaving unprocessed for retry', row.type, err.message)
                    throw err
                }
                console.error('[ZareCash] giving up on %s (%s): %s', row.type, eventId, err.message)
                reportError(err, {
                    phase: 'zarecash-unknown-gateway-ref-expired',
                    eventId,
                    eventType: row.type,
                    gatewayRef: err.gatewayRef,
                })
                await ZareCashService.recordAdminAlert('zarecash.unknown_gateway_ref', eventId, {
                    eventType: row.type,
                    gatewayRef: err.gatewayRef,
                    receivedAt: row.receivedAt.toISOString(),
                })
                return
            }
            await prisma.zareCashEvent.update({
                where: { id: eventId },
                data: { error: (err as Error).message },
            })
            throw err
        }
    }

    private static async findByGatewayRef(gatewayRef: unknown) {
        if (!gatewayRef) return null
        return prisma.transaction.findUnique({ where: { gatewayRef: String(gatewayRef) } })
    }

    /**
     * Resolve the local row a terminal event refers to, or refuse to consume the
     * event. See the UnknownGatewayRefError handling in processEvent.
     */
    /**
     * Resolve the local row a DEPOSIT event refers to.
     *
     * Two legitimate ways a deposit row can be missing, and only one is a problem:
     * a hosted-checkout deposit whose player never returned to our site has no row
     * yet and we can build one from the session; anything else is genuinely
     * unknown and must not consume the event.
     */
    private static async requireDepositRow(eventType: string, data: Record<string, any>) {
        const direct = await ZareCashService.findByGatewayRef(data.id)
        if (direct) return direct

        const adoptedId = await ZareCashCheckoutService.adoptFromWebhook(data)
        if (adoptedId) {
            const adopted = await prisma.transaction.findUnique({ where: { id: adoptedId } })
            if (adopted) return adopted
        }
        throw new UnknownGatewayRefError(eventType, data.id)
    }

    private static async requireByGatewayRef(eventType: string, gatewayRef: unknown) {
        const tx = await ZareCashService.findByGatewayRef(gatewayRef)
        if (!tx) throw new UnknownGatewayRefError(eventType, gatewayRef)
        return tx
    }

    /**
     * Durable, admin-visible record of an operational ZareCash event.
     *
     * This codebase has no admin notification channel (NotificationType is a
     * player-facing enum owned by packages/shared-types, and the admin app has no
     * notification surface), so AuditLog — already the convention for
     * admin-relevant events, see routes/admin/crm.ts — is the durable record, and
     * Sentry carries the alert.
     */
    private static async recordAdminAlert(
        action: string,
        target: string,
        detail: Record<string, unknown>,
    ): Promise<void> {
        await prisma.auditLog.create({
            data: { action, actorId: null, actorName: 'zarecash', target, detail: detail as object },
        })
    }

    private static async onDepositApproved(data: Record<string, any>): Promise<void> {
        const tx = await ZareCashService.requireDepositRow('deposit.approved', data)
        if (tx.status !== PaymentStatus.PENDING_REVIEW) {
            // Already terminal — this is an at-least-once redelivery, not a failure.
            console.log('[ZareCash] deposit %s already %s, skipping redelivery', tx.id, tx.status)
            return
        }
        const amount = data.approvedAmount ?? Number(tx.amount)
        try {
            await WalletService.approveDeposit(tx.id, amount)
        } catch (err) {
            const message = (err as Error).message
            if (message === 'Invalid transaction') {
                // Lost a race with a concurrent worker that credited it first.
                // approveDeposit's row lock is what makes that safe.
                console.log('[ZareCash] deposit %s credited concurrently, skipping', tx.id)
                return
            }
            // Anything else is a real failure: let processEvent record it on the
            // event row and let BullMQ retry.
            throw err
        }
    }

    private static async onDepositRejected(data: Record<string, any>): Promise<void> {
        const tx = await ZareCashService.requireDepositRow('deposit.rejected', data)
        // No wallet change — a deposit is never credited before approval.
        await prisma.transaction.updateMany({
            where: { id: tx.id, status: PaymentStatus.PENDING_REVIEW },
            data: {
                status: PaymentStatus.REJECTED,
                note: `Rejected by ZareCash${data.verdict ? `: ${data.verdict}` : ''}`,
            },
        })
    }

    private static async onWithdrawalApproved(data: Record<string, any>): Promise<void> {
        const tx = await ZareCashService.requireByGatewayRef('withdrawal.approved', data.id)
        await ZareCashService.settleApprovedWithdrawal(tx.id, data.settlementRef ?? null)
    }

    /**
     * Mark a payout settled. Shared by the webhook handler and the inline
     * 'approved' response, so either can win the race safely — the claim is an
     * atomic conditional update and exactly one caller gets count === 1.
     *
     * When the claim finds nothing, the row's CURRENT status decides whether that
     * is routine or an emergency, and conflating the two is how a real double
     * payment goes unnoticed:
     *  - APPROVED  → someone already settled it. A redelivery. Routine.
     *  - REJECTED  → we already refunded this player, and ZareCash has now paid
     *    them as well. That is a GENUINE DOUBLE PAYMENT. The spec accepts the
     *    risk (it is the price of refunding when we cannot confirm acceptance);
     *    it does not accept silence. Finance has to hear about it.
     */
    private static async settleApprovedWithdrawal(
        transactionId: string,
        settlementRef: string | null,
    ): Promise<void> {
        const claim = await prisma.transaction.updateMany({
            where: { id: transactionId, status: PaymentStatus.PENDING_REVIEW },
            data: {
                status: PaymentStatus.APPROVED,
                note: `Settled by ZareCash${settlementRef ? ` (ref ${settlementRef})` : ''}`,
            },
        })

        if (claim.count === 0) {
            const current = await prisma.transaction.findUnique({ where: { id: transactionId } })
            if (current?.status === PaymentStatus.REJECTED) {
                const amount = Number(current.amount).toFixed(2)
                console.error(
                    '[ZareCash] DOUBLE PAYMENT: withdrawal %s was refunded locally (%s ETB) but ZareCash settled it%s. ' +
                        'The player has been paid twice — finance must reconcile.',
                    transactionId,
                    amount,
                    settlementRef ? ` (ref ${settlementRef})` : '',
                )
                reportError(
                    new Error(`ZareCash double payment on withdrawal ${transactionId}: refunded locally then settled upstream`),
                    {
                        phase: 'zarecash-double-payment',
                        transactionId,
                        settlementRef,
                        amount,
                        userId: current.userId,
                    },
                )
                await ZareCashService.recordAdminAlert('zarecash.double_payment', transactionId, {
                    settlementRef,
                    amount,
                    userId: current.userId,
                    detail: 'Withdrawal was refunded locally and then settled by ZareCash. Player paid twice.',
                })
                return
            }
            // APPROVED (or anything else non-REJECTED) — a redelivery, or the
            // inline path and the webhook simply racing. Routine.
            console.log(
                '[ZareCash] withdrawal %s already %s, skipping duplicate settle',
                transactionId,
                current?.status ?? 'missing',
            )
            return
        }

        const settled = await prisma.transaction.findUnique({ where: { id: transactionId } })
        if (!settled) return
        await NotificationService.create(
            settled.userId,
            NotificationType.WITHDRAWAL_PROCESSED,
            'Withdrawal Processed ✅',
            `Your withdrawal of ${Number(settled.amount).toFixed(2)} ETB has been transferred.`,
            { transactionId, amount: Number(settled.amount) },
        ).catch(() => {})
        wbWithdrawalsTotal.labels('approved').inc()
    }

    private static async onWithdrawalRefunded(data: Record<string, any>, reason: string): Promise<void> {
        const tx = await ZareCashService.requireByGatewayRef('withdrawal refund', data.id)
        try {
            await WalletService.rejectWithdrawal(tx.id, reason)
        } catch (err) {
            const message = (err as Error).message
            if (message === 'Transaction is not pending review') {
                // rejectWithdrawal's claim found nothing — already terminal, which is
                // exactly what a redelivery looks like. Not an error.
                console.log('[ZareCash] withdrawal %s already resolved, skipping redelivery', tx.id)
                return
            }
            // Anything else (Transaction not found, Wallet not found, a Prisma
            // error, …) is a genuine failure: let processEvent record it on the
            // event row and let BullMQ retry, per the house pattern from Task 8
            // (see onDepositApproved) — a blanket catch here would silently lose
            // a player's refund.
            throw err
        }
    }

    /**
     * A human at ZareCash is deciding. The row stays PENDING_REVIEW — this is not
     * a fault — but an operator has to know a payout is parked, so this raises a
     * real alert instead of a console line nobody reads (spec: "Stay
     * PENDING_REVIEW; raise an admin alert").
     */
    private static async onWithdrawalRiskHold(data: Record<string, any>): Promise<void> {
        const tx = await ZareCashService.findByGatewayRef(data.id)
        console.warn('[ZareCash] withdrawal %s placed on risk hold', data.id)
        reportWarning(`ZareCash placed withdrawal ${data.id} on risk hold`, {
            phase: 'zarecash-risk-hold',
            gatewayRef: String(data.id),
            transactionId: tx?.id,
            userId: tx?.userId,
        })
        await ZareCashService.recordAdminAlert('zarecash.risk_hold', String(data.id), {
            gatewayRef: String(data.id),
            transactionId: tx?.id ?? null,
            userId: tx?.userId ?? null,
            amount: tx ? Number(tx.amount).toFixed(2) : null,
        })
    }

    /**
     * Operational, not player-facing (spec: "Admin notification + Sentry
     * warning"). A low float is what turns new payouts into `queued_float`, so it
     * needs to reach an operator before players start asking why withdrawals are
     * slow.
     */
    private static async onFloatLow(data: Record<string, any>): Promise<void> {
        console.warn('[ZareCash] float low: available=%s threshold=%s', data.available, data.lowFloatThreshold)
        reportWarning('ZareCash float is low — payouts will start queueing', {
            phase: 'zarecash-float-low',
            available: data.available,
            threshold: data.lowFloatThreshold ?? data.threshold,
        })
        await ZareCashService.recordAdminAlert('zarecash.float_low', 'float', {
            available: data.available ?? null,
            threshold: data.lowFloatThreshold ?? data.threshold ?? null,
        })
    }

    private static async onWithdrawalQueued(data: Record<string, any>): Promise<void> {
        const tx = await ZareCashService.findByGatewayRef(data.id)
        if (!tx) return
        // Stays PENDING_REVIEW — queued_float is a normal state, not a fault.
        await NotificationService.create(
            tx.userId,
            NotificationType.WITHDRAWAL_PROCESSED,
            'Withdrawal Processing',
            `Your withdrawal of ${Number(tx.amount).toFixed(2)} ETB is queued and will be paid shortly.`,
            { transactionId: tx.id, amount: Number(tx.amount) },
        ).catch(() => {})
    }

    /**
     * Mirror a local freeze upstream. Best-effort by design: the LOCAL freeze is
     * the one that protects our own balance (enforced in WalletService.requestWithdrawal
     * and AdminService.reviewTransaction), so a failed sync must never block or
     * undo it — unlike the deposit/withdrawal paths, a blanket catch here is
     * correct. Deposits are unaffected on both sides — a frozen player can still
     * fund.
     *
     * NEVER throws, on any path — including zarecashClient() construction or
     * zarecashConfig() throwing (both are exercised inside the try below). That
     * is what lets a caller sequence this strictly after the local freeze
     * without risking the containment action itself. The outcome is reported
     * back instead of being swallowed into a log line, so a caller that needs
     * to know whether the mirror actually landed (e.g. an operator-facing
     * script) can — while a caller that doesn't care can still just await it.
     */
    static async syncPlayerFreeze(
        userId: string,
        frozen: boolean,
        reason: string,
    ): Promise<{ ok: boolean; skipped: boolean; error?: string }> {
        try {
            if (!isZareCashEnabled()) return { ok: true, skipped: true }
            const client = zarecashClient()
            if (frozen) await client.freezePlayer(userId, reason)
            else await client.unfreezePlayer(userId, reason)
            return { ok: true, skipped: false }
        } catch (err) {
            const message = (err as Error)?.message ?? String(err)
            console.error('[ZareCash] freeze sync failed for %s: %s', userId, message)
            return { ok: false, skipped: false, error: message }
        }
    }
}
