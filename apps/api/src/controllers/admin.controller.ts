import { FastifyReply, FastifyRequest } from 'fastify'
import { AdminService } from '../services/admin.service'
import { PaymentStatus, TransactionType, UserRole } from '@world-bingo/shared-types'

export class AdminController {
    static async getStats(request: FastifyRequest, reply: FastifyReply) {
        const q = (request.query as any) ?? {}
        const stats = await AdminService.getStats({
            from: q.from ? new Date(q.from) : undefined,
            to: q.to ? new Date(q.to) : undefined,
        })
        return stats
    }

    static async getPendingDeposits(request: FastifyRequest, reply: FastifyReply) {
        const q = (request.query as any) ?? {}
        const result = await AdminService.getTransactions({
            type: TransactionType.DEPOSIT,
            status: (q.status as PaymentStatus) || PaymentStatus.PENDING_REVIEW,
            search: q.search || undefined,
            userSerial: q.userSerial ? Number(q.userSerial) : undefined,
            from: q.from ? new Date(q.from) : undefined,
            to: q.to ? new Date(q.to) : undefined,
            minAmount: q.minAmount ? Number(q.minAmount) : undefined,
            maxAmount: q.maxAmount ? Number(q.maxAmount) : undefined,
            page: q.page ? Number(q.page) : undefined,
            limit: q.limit ? Number(q.limit) : undefined,
        })
        return result
    }

    static async getOrdersHistory(request: FastifyRequest, reply: FastifyReply) {
        const q = (request.query as any) ?? {}
        const typeParam: string | undefined = q.type && q.type !== 'ALL' ? q.type : undefined
        const types = typeParam?.includes(',')
            ? (typeParam.split(',').map((t: string) => t.trim()) as TransactionType[])
            : undefined
        const transactions = await AdminService.getTransactions({
            ...(types ? { types } : typeParam ? { type: typeParam as TransactionType } : {}),
            search: q.search || undefined,
            userSerial: q.userSerial ? Number(q.userSerial) : undefined,
            from: q.from ? new Date(q.from) : undefined,
            to: q.to ? new Date(q.to) : undefined,
            page: q.page ? parseInt(q.page, 10) : 1,
            limit: q.limit ? parseInt(q.limit, 10) : 20,
        })
        return transactions
    }

    static async getWithdrawals(request: FastifyRequest, reply: FastifyReply) {
        const q = (request.query as any) ?? {}
        const result = await AdminService.getTransactions({
            type: TransactionType.WITHDRAWAL,
            status: (q.status as PaymentStatus) || PaymentStatus.PENDING_REVIEW,
            search: q.search || undefined,
            userSerial: q.userSerial ? Number(q.userSerial) : undefined,
            from: q.from ? new Date(q.from) : undefined,
            to: q.to ? new Date(q.to) : undefined,
            minAmount: q.minAmount ? Number(q.minAmount) : undefined,
            maxAmount: q.maxAmount ? Number(q.maxAmount) : undefined,
            page: q.page ? Number(q.page) : undefined,
            limit: q.limit ? Number(q.limit) : undefined,
        })
        return result
    }

    static async approveTransaction(request: FastifyRequest<{ Params: { id: string }, Body: { amount?: number } }>, reply: FastifyReply) {
        const { id } = request.params
        const rawAmount = request.body?.amount
        let adjustedAmount: number | undefined
        if (rawAmount !== undefined && rawAmount !== null) {
            const parsed = Number(rawAmount)
            if (!Number.isFinite(parsed) || parsed <= 0) {
                reply.status(400).send({ error: 'Invalid adjusted amount' })
                return
            }
            // Normalise to 2 decimal places (currency)
            adjustedAmount = Math.round(parsed * 100) / 100
        }
        const transaction = await AdminService.reviewTransaction(id, PaymentStatus.APPROVED, undefined, adjustedAmount)
        return transaction
    }

    static async declineTransaction(request: FastifyRequest<{ Params: { id: string }, Body: { note?: string } }>, reply: FastifyReply) {
        const { id } = request.params
        const { note } = request.body
        const transaction = await AdminService.reviewTransaction(id, PaymentStatus.REJECTED, note)
        return transaction
    }

    static async getUsers(
        request: FastifyRequest<{ Querystring: { page?: string; limit?: string; search?: string; role?: string } }>,
        reply: FastifyReply,
    ) {
        const { page = '1', limit = '20', search, role } = request.query
        const result = await AdminService.getUsers({
            page: parseInt(page, 10),
            limit: parseInt(limit, 10),
            search,
            role: role as UserRole || undefined,
        })
        return result
    }

    static async updateUserStatus(
        request: FastifyRequest<{ Params: { id: string }; Body: { role: string } }>,
        reply: FastifyReply,
    ) {
        const { id } = request.params
        const { role } = request.body
        if (!Object.values(UserRole).includes(role as UserRole)) {
            reply.status(400).send({ error: 'Invalid role' })
            return
        }
        return await AdminService.updateUserRole(id, role as UserRole)
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

