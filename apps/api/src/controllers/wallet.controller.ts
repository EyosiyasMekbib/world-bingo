import { FastifyReply, FastifyRequest } from 'fastify'
import { WalletService } from '../services'
import type { DepositDto, WithdrawalDto } from '@world-bingo/shared-types'

export class WalletController {
    static async getBalance(request: FastifyRequest, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        const wallet = await WalletService.getBalance(userId)
        return wallet
    }

    static async deposit(request: FastifyRequest<{ Body: DepositDto }>, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        const transaction = await WalletService.initiateDeposit(userId, request.body)
        return transaction
    }

    static async withdraw(request: FastifyRequest<{ Body: WithdrawalDto }>, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        const transaction = await WalletService.requestWithdrawal(userId, request.body)
        return transaction
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

