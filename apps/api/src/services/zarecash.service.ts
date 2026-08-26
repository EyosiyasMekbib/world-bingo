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
import { zarecashConfig } from '../gateways/payment/zarecash/config.js'
import { WalletService } from './wallet.service.js'
import { PaymentStatus, NotificationType } from '@world-bingo/shared-types'
import { ZareCashError } from '../gateways/payment/zarecash/types.js'
import { NotificationService } from './notification.service.js'
import { wbWithdrawalsTotal } from '../lib/metrics.js'
import { getQueue, QUEUE_NAMES } from '../lib/queue.js'

const CURSOR_KEY = 'zarecash_events_cursor'

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
     */
    static async assertMode(): Promise<void> {
        const cfg = zarecashConfig()
        if (!cfg.enabled) return
        const float = await zarecashClient().getFloat()
        if (float.mode !== cfg.mode) {
            throw new Error(
                `ZareCash mode mismatch: ZARECASH_MODE=${cfg.mode} but the API key reports "${float.mode}". Refusing to start.`,
            )
        }
        console.log('[ZareCash] connected in %s mode (available float: %s ETB)', float.mode, float.available)
    }

    /**
     * Backfill anything a webhook outage lost. Events carry full payloads, so no
     * follow-up fetch is needed, and processing is keyed on the event id, so a
     * replay of something already handled is a no-op.
     */
    static async sweepEvents(): Promise<{ scanned: number; replayed: number }> {
        const cursorRow = await prisma.siteSetting.findUnique({ where: { key: CURSOR_KEY } })
        const page = await zarecashClient().listEvents({
            cursor: cursorRow?.value ?? undefined,
            limit: 100,
        })

        const scanned = page.data.length
        let replayed = 0

        if (scanned > 0) {
            const ids = page.data.map((e) => e.id)
            const known = await prisma.zareCashEvent.findMany({
                where: { id: { in: ids } },
                select: { id: true },
            })
            const knownIds = new Set(known.map((k) => k.id))

            for (const evt of page.data) {
                if (knownIds.has(evt.id)) continue
                await prisma.zareCashEvent.create({
                    data: { id: evt.id, type: evt.type, payload: evt as unknown as object },
                })
                await getQueue(QUEUE_NAMES.ZARECASH_EVENT).add('process', { eventId: evt.id })
                replayed++
            }
        }

        if (page.nextCursor) {
            await prisma.siteSetting.upsert({
                where: { key: CURSOR_KEY },
                create: { key: CURSOR_KEY, value: page.nextCursor },
                update: { value: page.nextCursor },
            })
        }

        return { scanned, replayed }
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

        if (res.state === 'rejected') {
            await WalletService.rejectWithdrawal(job.transactionId, 'ZareCash rejected the payout')
        }
        // pending / queued_float / risk_hold all stay PENDING_REVIEW here; the
        // terminal state arrives as a webhook.
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
                    console.warn('[ZareCash] withdrawal %s placed on risk hold', data.id)
                    break
                case 'float.low':
                    console.warn(
                        '[ZareCash] float low: available=%s threshold=%s',
                        data.available,
                        data.lowFloatThreshold,
                    )
                    break
                default:
                    console.log('[ZareCash] unhandled event type %s (%s)', row.type, eventId)
            }
            await prisma.zareCashEvent.update({
                where: { id: eventId },
                data: { processedAt: new Date(), error: null },
            })
        } catch (err) {
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

    private static async onDepositApproved(data: Record<string, any>): Promise<void> {
        const tx = await ZareCashService.findByGatewayRef(data.id)
        if (!tx) {
            console.warn('[ZareCash] deposit.approved for unknown gatewayRef %s', data.id)
            return
        }
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
        const tx = await ZareCashService.findByGatewayRef(data.id)
        if (!tx) {
            console.warn('[ZareCash] deposit.rejected for unknown gatewayRef %s', data.id)
            return
        }
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
        const tx = await ZareCashService.findByGatewayRef(data.id)
        if (!tx) {
            console.warn('[ZareCash] withdrawal.approved for unknown gatewayRef %s', data.id)
            return
        }
        const claim = await prisma.transaction.updateMany({
            where: { id: tx.id, status: PaymentStatus.PENDING_REVIEW },
            data: {
                status: PaymentStatus.APPROVED,
                note: `Settled by ZareCash${data.settlementRef ? ` (ref ${data.settlementRef})` : ''}`,
            },
        })
        if (claim.count === 0) return // redelivery

        await NotificationService.create(
            tx.userId,
            NotificationType.WITHDRAWAL_PROCESSED,
            'Withdrawal Processed ✅',
            `Your withdrawal of ${Number(tx.amount).toFixed(2)} ETB has been transferred.`,
            { transactionId: tx.id, amount: Number(tx.amount) },
        ).catch(() => {})
        wbWithdrawalsTotal.labels('approved').inc()
    }

    private static async onWithdrawalRefunded(data: Record<string, any>, reason: string): Promise<void> {
        const tx = await ZareCashService.findByGatewayRef(data.id)
        if (!tx) {
            console.warn('[ZareCash] withdrawal refund for unknown gatewayRef %s', data.id)
            return
        }
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
}
