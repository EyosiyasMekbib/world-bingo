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
        // Reject duplicate payment transaction IDs
        if (data.transactionId) {
            const existing = await prisma.transaction.findUnique({
                where: { paymentTransactionId: data.transactionId },
            })
            if (existing) {
                throw Object.assign(new Error('Transaction ID already used'), { statusCode: 409 })
            }
        }

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
                ...(data.methodCode ? { metadata: { methodCode: data.methodCode } } : {}),
            },
        })
        return transaction
    }

    // Called by Admin — uses SELECT FOR UPDATE to prevent double-crediting
    static async approveDeposit(transactionId: string) {
        return await prisma.$transaction(async (tx) => {
            // Lock the transaction row first to prevent concurrent approvals from both
            // passing the PENDING_REVIEW check before either commits.
            const transactions = await tx.$queryRaw<Array<{ id: string; userId: string; amount: Decimal; status: string; type: string }>>`
                SELECT id, "userId", amount, status, type FROM transactions WHERE id = ${transactionId} FOR UPDATE
            `
            const transaction = transactions[0]
            if (!transaction || transaction.status !== PaymentStatus.PENDING_REVIEW) {
                throw new Error('Invalid transaction')
            }

            // Lock the wallet row before reading and updating
            const wallets = await tx.$queryRaw<Array<{ id: string; realBalance: Decimal; bonusBalance: Decimal }>>`
                SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${transaction.userId} FOR UPDATE
            `
            const wallet = wallets[0]
            if (!wallet) throw new Error('Wallet not found')

            const realBefore = new Decimal(wallet.realBalance)
            const realAfter = realBefore.plus(new Decimal(transaction.amount))
            const bonusBefore = new Decimal(wallet.bonusBalance)

            // Update transaction status with balance snapshot
            await tx.transaction.update({
                where: { id: transactionId },
                data: {
                    status: PaymentStatus.APPROVED,
                    balanceBefore: realBefore,
                    balanceAfter: realAfter,
                    bonusBalanceBefore: bonusBefore,
                    bonusBalanceAfter: bonusBefore,
                },
            })

            // Credit realBalance
            await tx.wallet.update({
                where: { userId: transaction.userId },
                data: { realBalance: { increment: transaction.amount } },
            })

            // ── First Deposit Bonus ──────────────────────────────────────────
            const previousApproved = await tx.transaction.count({
                where: {
                    userId: transaction.userId,
                    type: TransactionType.DEPOSIT,
                    status: PaymentStatus.APPROVED,
                    id: { not: transactionId },
                },
            })

            let bonusAwarded = 0
            if (previousApproved === 0) {
                // This is their first deposit — check for bonus setting
                const bonusSetting = await tx.siteSetting.findUnique({ where: { key: 'first_deposit_bonus_amount' } })
                const bonusAmount = Number(bonusSetting?.value ?? '0')

                if (bonusAmount > 0) {
                    const bonusAfter = bonusBefore.plus(new Decimal(bonusAmount))

                    // Credit bonusBalance
                    await tx.wallet.update({
                        where: { userId: transaction.userId },
                        data: { bonusBalance: { increment: bonusAmount } },
                    })

                    // Record bonus transaction
                    await tx.transaction.create({
                        data: {
                            userId: transaction.userId,
                            type: TransactionType.FIRST_DEPOSIT_BONUS,
                            amount: bonusAmount,
                            status: PaymentStatus.APPROVED,
                            note: 'First deposit bonus',
                            balanceBefore: realAfter,
                            balanceAfter: realAfter,
                            bonusBalanceBefore: bonusBefore,
                            bonusBalanceAfter: bonusAfter,
                        },
                    })

                    bonusAwarded = bonusAmount
                }
            }

            return { transaction, realAfter, bonusAwarded, bonusBefore }
        }).then(async ({ transaction, realAfter, bonusAwarded, bonusBefore }) => {
            const finalBonusBalance = bonusAwarded > 0
                ? bonusBefore.plus(new Decimal(bonusAwarded)).toNumber()
                : bonusBefore.toNumber()

            // Push balance update
            NotificationService.pushWalletUpdate(
                transaction.userId,
                realAfter.toNumber(),
                finalBonusBalance,
            )

            // Send notification
            const metadata: Record<string, unknown> = {
                transactionId: transaction.id,
                amount: Number(transaction.amount),
            }
            if (bonusAwarded > 0) {
                metadata.bonusAwarded = bonusAwarded
            }

            await NotificationService.create(
                transaction.userId,
                NotificationType.DEPOSIT_APPROVED,
                'Deposit Approved ✅',
                bonusAwarded > 0
                    ? `Your deposit of ${Number(transaction.amount).toFixed(2)} ETB has been approved! You also received a ${bonusAwarded.toFixed(2)} ETB first deposit bonus!`
                    : `Your deposit of ${Number(transaction.amount).toFixed(2)} ETB has been approved and added to your wallet.`,
                metadata,
            ).catch(() => {})

            // Check referral bonus (only on first deposit, bonus already handled above)
            if (bonusAwarded > 0) {
                // bonusAwarded > 0 means this IS the first deposit
                await ReferralService.processFirstDepositBonus(transaction.userId).catch(() => {})
            } else {
                // Still check if it's first deposit for referral purposes
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
            const wallets = await tx.$queryRaw<Array<{ id: string; realBalance: Decimal; bonusBalance: Decimal }>>`
                SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${userId} FOR UPDATE
            `
            const wallet = wallets[0]
            if (!wallet || new Decimal(wallet.realBalance).lessThan(new Decimal(data.amount))) {
                throw new Error('Insufficient balance — only your real balance is withdrawable')
            }

            const realBefore = new Decimal(wallet.realBalance)
            const realAfter = realBefore.minus(new Decimal(data.amount))
            const bonusBefore = new Decimal(wallet.bonusBalance)

            // Lock the balance immediately
            await tx.wallet.update({
                where: { userId },
                data: { realBalance: { decrement: data.amount } }
            })

            // Create a pending withdrawal with balance snapshot
            const transaction = await tx.transaction.create({
                data: {
                    userId,
                    type: TransactionType.WITHDRAWAL,
                    amount: data.amount,
                    status: PaymentStatus.PENDING_REVIEW,
                    note: `${data.paymentMethod}: ${data.accountNumber}`,
                    balanceBefore: realBefore,
                    balanceAfter: realAfter,
                    bonusBalanceBefore: bonusBefore,
                    bonusBalanceAfter: bonusBefore,
                },
            })
            return { transaction, realAfter, bonusBefore }
        }).then(async ({ transaction, realAfter, bonusBefore }) => {
            // Push balance update
            NotificationService.pushWalletUpdate(userId, realAfter.toNumber(), bonusBefore.toNumber())
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

    static async getUserStats(userId: string) {
        const [entries, prizes] = await Promise.all([
            prisma.transaction.aggregate({
                where: { userId, type: TransactionType.GAME_ENTRY },
                _count: true,
                _sum: { amount: true },
            }),
            prisma.transaction.aggregate({
                where: { userId, type: TransactionType.PRIZE_WIN },
                _count: true,
                _sum: { amount: true },
            }),
        ])
        return {
            gamesPlayed: entries._count,
            gamesWon: prizes._count,
            totalWagered: Number(entries._sum.amount ?? 0),
            totalWon: Number(prizes._sum.amount ?? 0),
        }
    }
}
