import prisma from '../lib/prisma'
import { PaymentStatus, TransactionType, UserRole } from '@world-bingo/shared-types'
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

        // Simplified profit calculation: 
        // In a real bingo app, profit comes from house edge on games.
        // For now, let's assume profit is house fees from completed games.
        // This is just a placeholder logic as requested by userflows.
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
            // Use WalletService for side-effects (incrementing balance)
            return await WalletService.approveDeposit(transactionId)
        }

        return await prisma.transaction.update({
            where: { id: transactionId },
            data: { status, note },
        })
    }
}
