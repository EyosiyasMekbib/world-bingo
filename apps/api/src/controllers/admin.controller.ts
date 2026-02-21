import { FastifyReply, FastifyRequest } from 'fastify'
import { AdminService } from '../services/admin.service'
import { PaymentStatus, TransactionType } from '@world-bingo/shared-types'

export class AdminController {
    static async getStats(request: FastifyRequest, reply: FastifyReply) {
        const stats = await AdminService.getStats()
        return stats
    }

    static async getPendingDeposits(request: FastifyRequest, reply: FastifyReply) {
        const transactions = await AdminService.getTransactions({
            type: TransactionType.DEPOSIT,
            status: PaymentStatus.PENDING_REVIEW,
        })
        return transactions
    }

    static async getOrdersHistory(request: FastifyRequest, reply: FastifyReply) {
        const transactions = await AdminService.getTransactions({
            type: TransactionType.DEPOSIT,
        })
        return transactions
    }

    static async getWithdrawals(request: FastifyRequest, reply: FastifyReply) {
        const transactions = await AdminService.getTransactions({
            type: TransactionType.WITHDRAWAL,
        })
        return transactions
    }

    static async approveTransaction(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
        const { id } = request.params
        const transaction = await AdminService.reviewTransaction(id, PaymentStatus.APPROVED)
        return transaction
    }

    static async declineTransaction(request: FastifyRequest<{ Params: { id: string }, Body: { note?: string } }>, reply: FastifyReply) {
        const { id } = request.params
        const { note } = request.body
        const transaction = await AdminService.reviewTransaction(id, PaymentStatus.REJECTED, note)
        return transaction
    }
}
