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
import { WalletService } from './wallet.service.js'
import { PaymentStatus } from '@world-bingo/shared-types'
import { ZareCashError } from '../gateways/payment/zarecash/types.js'

export class ZareCashService {
    /** Idempotency keys are derived from our own row, so every retry is safe. */
    static depositKey(transactionId: string): string {
        return `dep_${transactionId}`
    }

    static withdrawalKey(transactionId: string): string {
        return `wd_${transactionId}`
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
                console.warn('[ZareCash] deposit %s not credited inline: %s', transactionId, (err as Error).message)
            }
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
        const amount = data.approvedAmount ?? Number(tx.amount)
        try {
            await WalletService.approveDeposit(tx.id, amount)
        } catch (err) {
            // approveDeposit throws when the row is no longer PENDING_REVIEW, which
            // is exactly what a redelivery looks like. Not an error.
            console.log('[ZareCash] deposit %s not credited: %s', tx.id, (err as Error).message)
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
}
