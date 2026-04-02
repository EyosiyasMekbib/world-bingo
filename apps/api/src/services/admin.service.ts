import prisma from '../lib/prisma'
import { GameStatus, PaymentStatus, TransactionType, UserRole, NotificationType } from '@world-bingo/shared-types'
import { WalletService } from './wallet.service'
import { NotificationService } from './notification.service'
import { Decimal } from '@prisma/client/runtime/library'
import { HouseWalletService } from './house-wallet.service'

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

        const houseSummary = await HouseWalletService.getSummary()

        return {
            approvedDepositSum: Number(approvedDeposits._sum.amount || 0),
            declinedDepositSum: Number(declinedDeposits._sum.amount || 0),
            approvedWithdrawalSum: Number(approvedWithdrawals._sum.amount || 0),
            totalProfit: totalProfit,
            usersCount: totalUsers,
            gamesCount: gamesCount,
            commission: houseSummary.COMMISSION,
        }
    }

    static async getTransactions(params: { type?: TransactionType; status?: PaymentStatus; page?: number; limit?: number }) {
        const page = params.page ?? 1
        const limit = params.limit ?? 50
        const skip = (page - 1) * limit

        const where = {
            ...(params.type && { type: params.type }),
            ...(params.status && { status: params.status }),
        }

        const [data, total] = await Promise.all([
            prisma.transaction.findMany({
                where,
                include: {
                    user: {
                        select: {
                            id: true,
                            serial: true,
                            username: true,
                            phone: true,
                        },
                    },
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.transaction.count({ where }),
        ])

        return {
            data,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        }
    }

    static async reviewTransaction(transactionId: string, status: PaymentStatus, note?: string) {
        if (status === PaymentStatus.APPROVED) {
            // Check transaction type — deposits go through WalletService (credits wallet)
            const tx = await prisma.transaction.findUnique({ where: { id: transactionId } })
            if (!tx) throw new Error('Transaction not found')

            if (tx.type === TransactionType.DEPOSIT) {
                return await WalletService.approveDeposit(transactionId)
            }

            // Withdrawal approval — just mark as APPROVED (balance was already deducted on request)
            const updated = await prisma.transaction.update({
                where: { id: transactionId },
                data: { status: PaymentStatus.APPROVED, note },
            })
            await NotificationService.create(
                updated.userId,
                NotificationType.WITHDRAWAL_PROCESSED,
                'Withdrawal Processed ✅',
                `Your withdrawal of ${Number(updated.amount).toFixed(2)} ETB has been transferred.`,
                { transactionId, amount: Number(updated.amount) },
            ).catch(() => {})
            return updated
        }

        // ── REJECTED path ────────────────────────────────────────────────────
        const existing = await prisma.transaction.findUnique({ where: { id: transactionId } })
        if (!existing) throw new Error('Transaction not found')
        if (existing.status !== PaymentStatus.PENDING_REVIEW) {
            throw new Error(`Transaction is not pending review (current status: ${existing.status})`)
        }

        if (existing.type === TransactionType.WITHDRAWAL) {
            // Withdrawal rejection must:
            // 1. Mark the withdrawal REJECTED
            // 2. Re-credit the wallet using SELECT FOR UPDATE (was deducted on request)
            // 3. Create a REFUND compensation transaction for the audit trail
            // All in one DB transaction to prevent partial state on crash.
            const result = await prisma.$transaction(async (tx) => {
                // Mark withdrawal rejected
                const updated = await tx.transaction.update({
                    where: { id: transactionId },
                    data: { status: PaymentStatus.REJECTED, note },
                })

                // Lock wallet row before reading balance
                const wallets = await tx.$queryRaw<Array<{ id: string; realBalance: Decimal; bonusBalance: Decimal }>>`
                    SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${existing.userId} FOR UPDATE
                `
                const wallet = wallets[0]
                if (!wallet) throw new Error('Wallet not found')

                const realBefore = new Decimal(wallet.realBalance)
                const realAfter = realBefore.plus(new Decimal(existing.amount))
                const bonusBefore = new Decimal(wallet.bonusBalance)

                // Re-credit wallet
                await tx.wallet.update({
                    where: { userId: existing.userId },
                    data: { realBalance: { increment: existing.amount } },
                })

                // Create compensation transaction so audit trail shows the wallet credit
                await tx.transaction.create({
                    data: {
                        userId: existing.userId,
                        type: TransactionType.REFUND,
                        amount: existing.amount,
                        status: PaymentStatus.APPROVED,
                        referenceId: transactionId,
                        note: `Refund for rejected withdrawal${note ? `: ${note}` : ''}`,
                        balanceBefore: realBefore,
                        balanceAfter: realAfter,
                        bonusBalanceBefore: bonusBefore,
                        bonusBalanceAfter: bonusBefore,
                    },
                })

                return { updated, realAfter, bonusBefore }
            })

            // Push real-time balance update after commit
            NotificationService.pushWalletUpdate(
                existing.userId,
                result.realAfter.toNumber(),
                result.bonusBefore.toNumber(),
            )

            await NotificationService.create(
                existing.userId,
                NotificationType.WITHDRAWAL_PROCESSED,
                'Withdrawal Rejected',
                `Your withdrawal of ${Number(existing.amount).toFixed(2)} ETB was rejected and refunded to your wallet.${note ? ` Reason: ${note}` : ''}`,
                { transactionId, amount: Number(existing.amount), note },
            ).catch(() => {})

            return result.updated
        }

        // DEPOSIT rejection — no wallet change (balance was never credited)
        const transaction = await prisma.transaction.update({
            where: { id: transactionId },
            data: { status: PaymentStatus.REJECTED, note },
        })

        await NotificationService.create(
            transaction.userId,
            NotificationType.DEPOSIT_REJECTED,
            'Deposit Rejected',
            `Your deposit of ${Number(transaction.amount).toFixed(2)} ETB was rejected.${note ? ` Reason: ${note}` : ''}`,
            { transactionId, amount: Number(transaction.amount), note },
        ).catch(() => {})

        return transaction
    }

    static async getUsers(params: { page?: number; limit?: number; search?: string; role?: UserRole }) {
        const page = params.page ?? 1
        const limit = params.limit ?? 20
        const skip = (page - 1) * limit

        const where: any = {}
        if (params.search) {
            where.OR = [
                { username: { contains: params.search, mode: 'insensitive' as const } },
                { phone: { contains: params.search } },
            ]
        }
        if (params.role) {
            where.role = params.role
        }

        const [users, total] = await Promise.all([
            prisma.user.findMany({
                where,
                select: {
                    id: true,
                    serial: true,
                    username: true,
                    phone: true,
                    role: true,
                    createdAt: true,
                    wallet: { select: { realBalance: true, bonusBalance: true } },
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

    /**
     * T43 — Update user role (promote to admin, demote to player, etc.)
     */
    static async updateUserRole(userId: string, role: UserRole) {
        const user = await prisma.user.findUnique({ where: { id: userId } })
        if (!user) throw new Error('User not found')
        if (user.role === UserRole.SUPER_ADMIN) throw new Error('Cannot change role of SUPER_ADMIN')

        return await prisma.user.update({
            where: { id: userId },
            data: { role },
            select: {
                id: true,
                username: true,
                phone: true,
                role: true,
                createdAt: true,
            },
        })
    }
}

