import prisma from '../lib/prisma'
import { DepositDto, TransactionType, PaymentStatus, NotificationType } from '@world-bingo/shared-types'
import { Decimal } from '@prisma/client/runtime/library'
import { NotificationService } from './notification.service'
import { ReferralService } from './referral.service'
import { wbDepositsTotal } from '../lib/metrics'
import { DepositVerificationService } from './deposit-verification.service'

export class WalletService {
    static async getBalance(userId: string) {
        const wallet = await prisma.wallet.findUnique({
            where: { userId },
        })
        if (!wallet) throw new Error('Wallet not found')
        return wallet
    }

    static async initiateDeposit(userId: string, data: DepositDto) {
        const [minRow, maxRow] = await Promise.all([
            prisma.siteSetting.findUnique({ where: { key: 'min_deposit_amount' } }),
            prisma.siteSetting.findUnique({ where: { key: 'max_deposit_amount' } }),
        ])
        const minDeposit = minRow ? Number(minRow.value) : 10
        const maxDeposit = maxRow ? Number(maxRow.value) : 50000
        if (data.amount < minDeposit) {
            throw Object.assign(new Error(`Minimum deposit amount is ${minDeposit} Birr`), { statusCode: 400 })
        }
        if (data.amount > maxDeposit) {
            throw Object.assign(new Error(`Maximum deposit amount is ${maxDeposit} Birr`), { statusCode: 400 })
        }

        // Normalize so dedup is case-insensitive (e.g. "ABC123" == "abc123")
        const paymentTransactionId = data.transactionId?.trim().toUpperCase()

        // Reject duplicate payment transaction IDs
        if (paymentTransactionId) {
            const existing = await prisma.transaction.findUnique({
                where: { paymentTransactionId },
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
                paymentTransactionId,
                senderName: data.senderName,
                senderAccount: data.senderAccount,
                ...(data.methodCode ? { note: data.methodCode } : {}),
            },
        })
        // Best-effort: kick off async auto-verification. Swallows its own errors so a
        // queue hiccup can never break deposit submission — the deposit still goes to manual.
        await DepositVerificationService.enqueue(transaction.id)
        return transaction
    }

    // Called by Admin — uses SELECT FOR UPDATE to prevent double-crediting
    static async approveDeposit(transactionId: string, adjustedAmount?: number, reviewerId?: string) {
        return await prisma.$transaction(async (tx) => {
            // Lock the transaction row first to prevent concurrent approvals from both
            // passing the PENDING_REVIEW check before either commits.
            const transactions = await tx.$queryRaw<Array<{ id: string; userId: string; amount: Decimal; status: string; type: string; note: string | null }>>`
                SELECT id, "userId", amount, status, type, note FROM transactions WHERE id = ${transactionId} FOR UPDATE
            `
            const transaction = transactions[0]
            if (!transaction || transaction.status !== PaymentStatus.PENDING_REVIEW) {
                throw new Error('Invalid transaction')
            }

            // Separation of duties (defense-in-depth; also enforced in reviewTransaction):
            // a reviewer may never credit a deposit into their own account.
            if (reviewerId && reviewerId === transaction.userId) {
                throw new Error('You cannot approve your own deposit')
            }

            // Lock the wallet row before reading and updating
            const wallets = await tx.$queryRaw<Array<{ id: string; realBalance: Decimal; bonusBalance: Decimal }>>`
                SELECT id, "realBalance", "bonusBalance" FROM wallets WHERE "userId" = ${transaction.userId} FOR UPDATE
            `
            const wallet = wallets[0]
            if (!wallet) throw new Error('Wallet not found')

            // Determine the amount to credit. When an admin adjusts the deposit
            // during review, `adjustedAmount` overrides the player-stated value and
            // the original is preserved in `originalAmount` for the audit trail.
            const statedAmount = new Decimal(transaction.amount)
            const creditAmount = adjustedAmount != null ? new Decimal(adjustedAmount) : statedAmount
            if (!creditAmount.isFinite() || creditAmount.lte(0)) {
                throw new Error('Adjusted amount must be a positive number')
            }
            const isAdjusted = adjustedAmount != null && !creditAmount.equals(statedAmount)

            const realBefore = new Decimal(wallet.realBalance)
            const realAfter = realBefore.plus(creditAmount)
            const bonusBefore = new Decimal(wallet.bonusBalance)

            // Update transaction status with balance snapshot. If the amount was
            // adjusted, overwrite `amount` with the credited value and keep the
            // player-stated figure in `originalAmount`.
            await tx.transaction.update({
                where: { id: transactionId },
                data: {
                    status: PaymentStatus.APPROVED,
                    reviewedById: reviewerId,
                    balanceBefore: realBefore,
                    balanceAfter: realAfter,
                    bonusBalanceBefore: bonusBefore,
                    bonusBalanceAfter: bonusBefore,
                    ...(isAdjusted ? { amount: creditAmount, originalAmount: statedAmount } : {}),
                },
            })

            // Credit realBalance with the (possibly adjusted) amount
            await tx.wallet.update({
                where: { userId: transaction.userId },
                data: { realBalance: { increment: creditAmount } },
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

            return { transaction, realAfter, bonusAwarded, bonusBefore, creditAmount, isAdjusted, statedAmount }
        }).then(async ({ transaction, realAfter, bonusAwarded, bonusBefore, creditAmount, isAdjusted, statedAmount }) => {
            const finalBonusBalance = bonusAwarded > 0
                ? bonusBefore.plus(new Decimal(bonusAwarded)).toNumber()
                : bonusBefore.toNumber()

            // Push balance update
            NotificationService.pushWalletUpdate(
                transaction.userId,
                realAfter.toNumber(),
                finalBonusBalance,
            )

            // Metrics: deposit approved (post-commit). The payment method is stored
            // in `note` (the client-supplied methodCode) by initiateDeposit. Bound
            // the label to the configured PaymentMethod catalog so an arbitrary
            // client value can never explode Prometheus label cardinality: unknown
            // codes collapse to 'other', a missing code to 'unknown'.
            let methodLabel = 'unknown'
            if (transaction.note) {
                const known = await prisma.paymentMethod
                    .findUnique({ where: { code: transaction.note }, select: { code: true } })
                    .catch(() => null)
                methodLabel = known ? transaction.note : 'other'
            }
            wbDepositsTotal.labels(methodLabel, 'approved').inc()

            // Send notification (reflects the credited amount, which may have been adjusted)
            const credited = creditAmount.toNumber()
            const metadata: Record<string, unknown> = {
                transactionId: transaction.id,
                amount: credited,
            }
            if (isAdjusted) {
                metadata.originalAmount = statedAmount.toNumber()
            }
            if (bonusAwarded > 0) {
                metadata.bonusAwarded = bonusAwarded
            }

            await NotificationService.create(
                transaction.userId,
                NotificationType.DEPOSIT_APPROVED,
                'Deposit Approved ✅',
                bonusAwarded > 0
                    ? `Your deposit of ${credited.toFixed(2)} ETB has been approved! You also received a ${bonusAwarded.toFixed(2)} ETB first deposit bonus!`
                    : `Your deposit of ${credited.toFixed(2)} ETB has been approved and added to your wallet.`,
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

            // Return the transaction reflecting the credited (possibly adjusted) amount
            return { ...transaction, amount: creditAmount, originalAmount: isAdjusted ? statedAmount : null }
        })
    }

    static async requestWithdrawal(userId: string, data: { amount: number, paymentMethod: string, accountNumber: string }) {
        const pendingWithdrawal = await prisma.transaction.findFirst({
            where: { userId, type: TransactionType.WITHDRAWAL, status: PaymentStatus.PENDING_REVIEW },
        })
        if (pendingWithdrawal) {
            throw Object.assign(
                new Error('You already have a pending withdrawal request. Please wait for it to be processed before submitting a new one.'),
                { statusCode: 409 },
            )
        }

        const [minRow, maxRow] = await Promise.all([
            prisma.siteSetting.findUnique({ where: { key: 'min_withdrawal_amount' } }),
            prisma.siteSetting.findUnique({ where: { key: 'max_withdrawal_amount' } }),
        ])
        const minWithdrawal = minRow ? Number(minRow.value) : 100
        const maxWithdrawal = maxRow ? Number(maxRow.value) : 10000
        if (data.amount < minWithdrawal) {
            throw new Error(`Minimum withdrawal amount is ${minWithdrawal} Birr`)
        }
        if (data.amount > maxWithdrawal) {
            throw new Error(`Maximum withdrawal amount is ${maxWithdrawal} Birr`)
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

            // Authoritative single-pending guard INSIDE the wallet lock. Concurrent
            // requests for the same user serialize on the FOR UPDATE row above, so the
            // second caller sees the first's pending row here (the pre-check at the top
            // is only a fast-path for UX and is not race-safe on its own).
            const stillPending = await tx.transaction.findFirst({
                where: { userId, type: TransactionType.WITHDRAWAL, status: PaymentStatus.PENDING_REVIEW },
            })
            if (stillPending) {
                throw Object.assign(
                    new Error('You already have a pending withdrawal request. Please wait for it to be processed before submitting a new one.'),
                    { statusCode: 409 },
                )
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
