import { FastifyReply, FastifyRequest } from 'fastify'
import { WalletService } from '../services'
import { DepositDto } from '@world-bingo/shared-types'

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

    // Admin only
    static async reviewDeposit(request: FastifyRequest, reply: FastifyReply) {
        // Implementation for admin to approve/reject
        return { message: 'Not implemented yet' }
    }
}
