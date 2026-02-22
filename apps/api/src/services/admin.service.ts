import prisma from '../lib/prisma'
import { GameStatus, PaymentStatus, TransactionType, UserRole } from '@world-bingo/shared-types'
import { WalletService } from './wallet.service'

export class AdminService {
    static async getStats() {
        const [
            approvedDeposits,
            declinedDeposits,
            approvedWithdrawals,
            totalUsers,
            gamesCount,
        ] = await Promise.all([
            prisma.transaction.aggregate({
                where: { type: TransactionType.DEPOSIT, status: PaymentStatus.APPROVED },
                _sum: { amount: true },
            }),
            prisma.transaction.aggregate({
                where: { type: TransactionType.DEPOSIT, status: PaymentStatus.REJECTED },
                _sum: { amount: true },
            }),
            prisma.transaction.aggregate({
                where: { type: TransactionType.WITHDRAWAL, status: PaymentStatus.APPROVED },
                _sum: { amount: true },
            }),
            prisma.user.count({ where: { role: UserRole.PLAYER } }),
            prisma.game.count({ where: { status: 'COMPLETED' } }),
        ])

        const games = await prisma.game.findMany({
            where: { status: 'COMPLETED' },
            include: {
                _count: {
                    select: { entries: true }
                }
            }
        })

        const totalProfit = games.reduce((acc, game) => {
            const totalCollected = Number(game.ticketPrice) * game._count.entries
            const houseFee = totalCollected * (Number(game.houseEdgePct) / 100)
            return acc + houseFee
        }, 0)

        return {
            approvedDepositSum: Number(approvedDeposits._sum.amount || 0),
            declinedDepositSum: Number(declinedDeposits._sum.amount || 0),
            approvedWithdrawalSum: Number(approvedWithdrawals._sum.amount || 0),
            totalProfit: totalProfit,
            usersCount: totalUsers,
            gamesCount: gamesCount,
            commission: 0, // Placeholder
        }
    }

    static async getTransactions(params: { type?: TransactionType; status?: PaymentStatus }) {
        return await prisma.transaction.findMany({
            where: {
                ...(params.type && { type: params.type }),
                ...(params.status && { status: params.status }),
            },
            include: {
                user: {
                    select: {
                        id: true,
                        username: true,
                        phone: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        })
    }

    static async reviewTransaction(transactionId: string, status: PaymentStatus, note?: string) {
        if (status === PaymentStatus.APPROVED) {
            return await WalletService.approveDeposit(transactionId)
        }

        return await prisma.transaction.update({
            where: { id: transactionId },
            data: { status, note },
        })
    }

    static async getUsers(params: { page?: number; limit?: number; search?: string }) {
        const page = params.page ?? 1
        const limit = params.limit ?? 20
        const skip = (page - 1) * limit

        const where = params.search
            ? {
                  OR: [
                      { username: { contains: params.search, mode: 'insensitive' as const } },
                      { phone: { contains: params.search } },
                  ],
              }
            : {}

        const [users, total] = await Promise.all([
            prisma.user.findMany({
                where,
                select: {
                    id: true,
                    username: true,
                    phone: true,
                    role: true,
                    createdAt: true,
                    wallet: { select: { balance: true } },
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.user.count({ where }),
        ])

        return {
            data: users,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        }
    }

    static async getGames(params: { status?: GameStatus; page?: number; limit?: number }) {
        const page = params.page ?? 1
        const limit = params.limit ?? 20
        const skip = (page - 1) * limit

        const where = params.status ? { status: params.status } : {}

        const [games, total] = await Promise.all([
            prisma.game.findMany({
                where,
                include: {
                    _count: { select: { entries: true } },
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.game.count({ where }),
        ])

        return {
            data: games,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        }
    }
}

