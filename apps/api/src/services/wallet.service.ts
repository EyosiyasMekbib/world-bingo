import prisma from '../lib/prisma'
import { DepositDto, TransactionType, PaymentStatus } from '@world-bingo/shared-types'

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
            },
        })
        return transaction
    }

    // Called by Admin
    static async approveDeposit(transactionId: string) {
        return await prisma.$transaction(async (tx) => {
            const transaction = await tx.transaction.findUnique({ where: { id: transactionId } })
            if (!transaction || transaction.status !== PaymentStatus.PENDING_REVIEW) {
                throw new Error('Invalid transaction')
            }

            // Update transaction status
            await tx.transaction.update({
                where: { id: transactionId },
                data: { status: PaymentStatus.APPROVED },
            })

            // Update user wallet
            await tx.wallet.update({
                where: { userId: transaction.userId },
                data: { balance: { increment: transaction.amount } },
            })

            return transaction
        })
    }

    static async requestWithdrawal(userId: string, data: { amount: number, paymentMethod: string, accountNumber: string }) {
        return await prisma.$transaction(async (tx) => {
            const wallet = await tx.wallet.findUnique({ where: { userId } })
            if (!wallet || wallet.balance < data.amount) {
                throw new Error('Insufficient balance')
            }

            // Lock the balance immediately
            await tx.wallet.update({
                where: { userId },
                data: { balance: { decrement: data.amount } }
            })

            // Create a pending withdrawal
            const transaction = await tx.transaction.create({
                data: {
                    userId,
                    type: TransactionType.WITHDRAWAL,
                    amount: data.amount,
                    status: PaymentStatus.PENDING_REVIEW,
                    note: `${data.paymentMethod}: ${data.accountNumber}`
                },
            })
            return transaction
        })
    }
}
