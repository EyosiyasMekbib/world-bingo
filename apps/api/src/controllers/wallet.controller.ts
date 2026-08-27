import { FastifyReply, FastifyRequest } from 'fastify'
import { WalletService } from '../services'
import type { DepositDto, WithdrawalDto } from '@world-bingo/shared-types'
import { uploadFile, validateFile } from '../lib/storage'
import { EventService } from '../services/event.service.js'
import { BonusGrantQueryService } from '../services/bonus-grant-query.service'
import { ZareCashCheckoutService } from '../services/zarecash-checkout.service.js'

export class WalletController {
    static async getBalance(request: FastifyRequest, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        const wallet = await WalletService.getBalance(userId)
        return wallet
    }

    static async getBonusGrants(request: FastifyRequest, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        return BonusGrantQueryService.listActiveForUser(userId)
    }

    /**
     * Start a ZareCash hosted-checkout deposit. Returns where to redirect the
     * player; creates no Transaction — see ZareCashCheckoutService.
     */
    static async createCheckoutSession(request: FastifyRequest, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        const { amount, methodCode } = request.body as { amount: number; methodCode: string }
        try {
            const session = await ZareCashCheckoutService.createSession(userId, amount, methodCode)
            return { url: session.url, expiresAt: session.expiresAt }
        } catch (err: any) {
            return reply
                .status(err?.statusCode ?? 500)
                .send({ error: err?.message ?? 'Could not start the deposit' })
        }
    }

    /**
     * The player is back from ZareCash with ?deposit=dp_… — record the pending
     * deposit. Never credits: the deposit.approved webhook does that.
     */
    static async claimCheckoutDeposit(request: FastifyRequest, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        const { depositId } = request.body as { depositId: string }
        try {
            return await ZareCashCheckoutService.claimDeposit(userId, depositId)
        } catch (err: any) {
            return reply.status(err?.statusCode ?? 500).send({ error: err?.message ?? 'Claim failed' })
        }
    }

    /**
     * T16 — Deposit route: Handle multipart/form-data file upload.
     * Accepts `amount` field + optional `receipt` file.
     * If a receipt file is attached, it is uploaded via the storage module
     * and the resulting URL is stored on the transaction.
     */
    static async deposit(request: FastifyRequest, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id

        // Check if the request is multipart (file upload)
        if (request.isMultipart()) {
            const parts = request.parts()
            let amount: number | undefined
            let receiptUrl: string | undefined
            let transactionId: string | undefined
            let senderName: string | undefined
            let senderAccount: string | undefined
            let methodCode: string | undefined

            for await (const part of parts) {
                if (part.type === 'field') {
                    if (part.fieldname === 'amount') {
                        amount = Number(part.value)
                    } else if (part.fieldname === 'transactionId') {
                        transactionId = String(part.value)
                    } else if (part.fieldname === 'senderName') {
                        senderName = String(part.value)
                    } else if (part.fieldname === 'senderAccount') {
                        senderAccount = String(part.value)
                    } else if (part.fieldname === 'methodCode') {
                        methodCode = String(part.value)
                    }
                } else if (part.type === 'file' && part.fieldname === 'receipt') {
                    // Validate file type and size
                    const buffer = await part.toBuffer()
                    validateFile(part.mimetype, buffer.byteLength)
                    const result = await uploadFile(buffer, part.filename, part.mimetype)
                    receiptUrl = result.url
                }
            }

            if (!amount || amount <= 0) {
                return reply.status(400).send({ error: 'Amount is required and must be positive' })
            }
            if (amount < 200) {
                return reply.status(400).send({ error: 'Minimum deposit amount is 200 ETB' })
            }

            try {
                const transaction = await WalletService.initiateDeposit(userId, {
                    amount,
                    receiptUrl,
                    transactionId,
                    senderName,
                    senderAccount,
                    methodCode,
                })
                EventService.record(
                    [{ name: 'deposit_submitted', props: { amount, paymentMethod: methodCode ?? null, txId: transaction.id } }],
                    { userId },
                ).catch(() => {})
                return reply.status(201).send(transaction)
            } catch (err: any) {
                if (err.statusCode === 409) {
                    return reply.status(409).send({ error: err.message })
                }
                throw err
            }
        }

        // Fallback: JSON body (backward compat)
        const body = request.body as DepositDto
        try {
            const transaction = await WalletService.initiateDeposit(userId, body)
            EventService.record(
                [{ name: 'deposit_submitted', props: { amount: body.amount, paymentMethod: (body as any).methodCode ?? null, txId: transaction.id } }],
                { userId },
            ).catch(() => {})
            return reply.status(201).send(transaction)
        } catch (err: any) {
            if (err.statusCode === 409) {
                return reply.status(409).send({ error: err.message })
            }
            throw err
        }
    }

    static async withdraw(request: FastifyRequest<{ Body: WithdrawalDto }>, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        try {
            const transaction = await WalletService.requestWithdrawal(userId, request.body)
            return transaction
        } catch (err: any) {
            if (err.statusCode === 409) {
                return reply.status(409).send({ error: err.message })
            }
            throw err
        }
    }

    static async getStats(request: FastifyRequest, reply: FastifyReply) {
        const userId = (request.user as any).id
        const stats = await WalletService.getUserStats(userId)
        return stats
    }

    static async getTransactions(
        request: FastifyRequest<{ Querystring: { type?: string; page?: string; limit?: string } }>,
        reply: FastifyReply,
    ) {
        // @ts-ignore
        const userId = request.user.id
        const { type, page = '1', limit = '20' } = request.query
        const transactions = await WalletService.getTransactions(userId, {
            type: type as any,
            page: parseInt(page, 10),
            limit: parseInt(limit, 10),
        })
        return transactions
    }

    static async setSpendAccount(request: FastifyRequest, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        const { account } = request.body as { account: 'REAL' | 'BONUS' }
        if (account !== 'REAL' && account !== 'BONUS') {
            return reply.status(400).send({ error: 'account must be REAL or BONUS' })
        }
        const wallet = await WalletService.setSpendAccount(userId, account)
        return wallet
    }
}

