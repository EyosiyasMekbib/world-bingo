import prisma from '../lib/prisma'
import { DepositDto, TransactionType, PaymentStatus, NotificationType } from '@world-bingo/shared-types'
import { Decimal } from '@prisma/client/runtime/library'
import { NotificationService } from './notification.service'
import { ReferralService } from './referral.service'

export class WalletService {
    static async getBalance(userId: string) {
        const wallet = await prisma.wallet.findUnique({
            where: { userId },
        })
        if (!wallet) throw new Error('Wallet not found')
        return wallet
    }

    static async initiateDeposit(userId: string, data: DepositDto) {
        // Create a pending transaction
        const transaction = await prisma.transaction.create({
            data: {
                userId,
                type: TransactionType.DEPOSIT,
                amount: data.amount,
                status: PaymentStatus.PENDING_REVIEW, // Needs admin approval
                receiptUrl: data.receiptUrl,
                paymentTransactionId: data.transactionId,
                senderName: data.senderName,
                senderAccount: data.senderAccount,
            },
        })
        return transaction
    }

    // Called by Admin — uses SELECT FOR UPDATE to prevent double-crediting
    static async approveDeposit(transactionId: string) {
        return await prisma.$transaction(async (tx) => {
            const transaction = await tx.transaction.findUnique({ where: { id: transactionId } })
            if (!transaction || transaction.status !== PaymentStatus.PENDING_REVIEW) {
                throw new Error('Invalid transaction')
            }

            // Lock the wallet row before reading and updating
            const wallets = await tx.$queryRaw<Array<{ id: string; balance: Decimal }>>`
                SELECT id, balance FROM wallets WHERE "userId" = ${transaction.userId} FOR UPDATE
            `
            const wallet = wallets[0]
            if (!wallet) throw new Error('Wallet not found')

            const balanceBefore = wallet.balance
            const balanceAfter = new Decimal(balanceBefore).plus(new Decimal(transaction.amount))

            // Update transaction status with balance snapshot
            await tx.transaction.update({
                where: { id: transactionId },
                data: {
                    status: PaymentStatus.APPROVED,
                    balanceBefore: balanceBefore,
                    balanceAfter: balanceAfter,
                },
            })

            // Update user wallet
            await tx.wallet.update({
                where: { userId: transaction.userId },
                data: { balance: { increment: transaction.amount } },
            })

            return transaction
        }).then(async (transaction) => {
            // Push balance update
            NotificationService.pushWalletUpdate(transaction.userId, Number(transaction.balanceAfter ?? 0))

            // Post-transaction: send notification (non-critical)
            await NotificationService.create(
                transaction.userId,
                NotificationType.DEPOSIT_APPROVED,
                'Deposit Approved ✅',
                `Your deposit of ${Number(transaction.amount).toFixed(2)} ETB has been approved and added to your wallet.`,
                { transactionId: transaction.id, amount: Number(transaction.amount) },
            ).catch(() => {})

            // Check if this is the player's first approved deposit → award referral bonus
            const previousApproved = await prisma.transaction.count({
                where: {
                    userId: transaction.userId,
                    type: TransactionType.DEPOSIT,
                    status: PaymentStatus.APPROVED,
                    id: { not: transaction.id },
                },
            })
            if (previousApproved === 0) {
                await ReferralService.processFirstDepositBonus(transaction.userId).catch(() => {})
            }

            return transaction
        })
    }

    static async requestWithdrawal(userId: string, data: { amount: number, paymentMethod: string, accountNumber: string }) {
        if (data.amount < 100) {
            throw new Error('Minimum withdrawal amount is 100 Birr')
        }

        return await prisma.$transaction(async (tx) => {
            // Lock the wallet row to prevent concurrent withdrawals from passing the balance check
            const wallets = await tx.$queryRaw<Array<{ id: string; balance: Decimal }>>`
                SELECT id, balance FROM wallets WHERE "userId" = ${userId} FOR UPDATE
            `
            const wallet = wallets[0]
            if (!wallet || new Decimal(wallet.balance).lessThan(new Decimal(data.amount))) {
                throw new Error('Insufficient balance')
            }

            const balanceBefore = new Decimal(wallet.balance)
            const balanceAfter = balanceBefore.minus(new Decimal(data.amount))

            // Lock the balance immediately
            await tx.wallet.update({
                where: { userId },
                data: { balance: { decrement: data.amount } }
            })

            // Create a pending withdrawal with balance snapshot
            const transaction = await tx.transaction.create({
                data: {
                    userId,
                    type: TransactionType.WITHDRAWAL,
                    amount: data.amount,
                    status: PaymentStatus.PENDING_REVIEW,
                    note: `${data.paymentMethod}: ${data.accountNumber}`,
                    balanceBefore: balanceBefore,
                    balanceAfter: balanceAfter,
                },
            })
            return transaction
        }).then(async (transaction) => {
            // Push balance update
            NotificationService.pushWalletUpdate(userId, Number(transaction.balanceAfter ?? 0))
            return transaction
        })
    }

    static async getTransactions(
        userId: string,
        params: { type?: TransactionType; page?: number; limit?: number },
    ) {
        const page = params.page ?? 1
        const limit = params.limit ?? 20
        const skip = (page - 1) * limit

        const [transactions, total] = await Promise.all([
            prisma.transaction.findMany({
                where: {
                    userId,
                    ...(params.type && { type: params.type }),
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.transaction.count({
                where: {
                    userId,
                    ...(params.type && { type: params.type }),
                },
            }),
        ])

        return {
            data: transactions,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        }
    }
}

