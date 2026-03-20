import { FastifyReply, FastifyRequest } from 'fastify'
import { WalletService } from '../services'
import type { DepositDto, WithdrawalDto } from '@world-bingo/shared-types'
import { uploadFile, validateFile } from '../lib/storage'

export class WalletController {
    static async getBalance(request: FastifyRequest, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        const wallet = await WalletService.getBalance(userId)
        return wallet
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

            const transaction = await WalletService.initiateDeposit(userId, {
                amount,
                receiptUrl,
                transactionId,
                senderName,
                senderAccount,
            })
            return reply.status(201).send(transaction)
        }

        // Fallback: JSON body (backward compat)
        const body = request.body as DepositDto
        const transaction = await WalletService.initiateDeposit(userId, body)
        return reply.status(201).send(transaction)
    }

    static async withdraw(request: FastifyRequest<{ Body: WithdrawalDto }>, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        const transaction = await WalletService.requestWithdrawal(userId, request.body)
        return transaction
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
}

