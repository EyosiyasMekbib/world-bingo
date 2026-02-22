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

    static async getUsers(
        request: FastifyRequest<{ Querystring: { page?: string; limit?: string; search?: string } }>,
        reply: FastifyReply,
    ) {
        const { page = '1', limit = '20', search } = request.query
        const result = await AdminService.getUsers({
            page: parseInt(page, 10),
            limit: parseInt(limit, 10),
            search,
        })
        return result
    }

    static async updateUserStatus(
        request: FastifyRequest<{ Params: { id: string }; Body: { active: boolean } }>,
        reply: FastifyReply,
    ) {
        // Placeholder for future user suspension feature
        return { message: 'Not yet implemented' }
    }

    static async getGames(
        request: FastifyRequest<{ Querystring: { status?: string; page?: string; limit?: string } }>,
        reply: FastifyReply,
    ) {
        const { status, page = '1', limit = '20' } = request.query
        const result = await AdminService.getGames({
            status: status as any,
            page: parseInt(page, 10),
            limit: parseInt(limit, 10),
        })
        return result
    }
}

