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
            approvedWithdrawals,
            totalPrizes,
            gamesCompleted,
            gamesCancelled,
            houseSummary,
            houseBalance,
            activePlayersGroups,
            completedGames,
        ] = await Promise.all([
            prisma.transaction.aggregate({
                where: { type: TransactionType.DEPOSIT, status: PaymentStatus.APPROVED },
                _sum: { amount: true },
            }),
            prisma.transaction.aggregate({
                where: { type: TransactionType.WITHDRAWAL, status: PaymentStatus.APPROVED },
                _sum: { amount: true },
            }),
            prisma.transaction.aggregate({
                where: { type: TransactionType.PRIZE_WIN, status: PaymentStatus.APPROVED },
                _sum: { amount: true },
            }),
            prisma.game.count({ where: { status: 'COMPLETED' } }),
            prisma.game.count({ where: { status: 'CANCELLED' } }),
            HouseWalletService.getSummary(),
            HouseWalletService.getBalance(),
            prisma.gameEntry.groupBy({ by: ['userId'] }),
            prisma.game.findMany({
                where: { status: 'COMPLETED' },
                include: { _count: { select: { entries: true } } },
            }),
        ])

        const activePlayers = activePlayersGroups.length
        const totalPrizePools = completedGames.reduce((acc, g) => {
            return acc + Number(g.ticketPrice) * g._count.entries
        }, 0)

        // Provider stats: gained = bets placed (amount < 0), lost = winnings paid (amount > 0)
        const [providerGained, providerLost] = await Promise.all([
            prisma.thirdPartyTransaction.groupBy({
                by: ['providerId'],
                where: { amount: { lt: 0 } },
                _sum: { amount: true },
            }),
            prisma.thirdPartyTransaction.groupBy({
                by: ['providerId'],
                where: { amount: { gt: 0 } },
                _sum: { amount: true },
            }),
        ])
        const gainedMap = new Map(providerGained.map(r => [r.providerId, Math.abs(Number(r._sum.amount ?? 0))]))
        const lostMap = new Map(providerLost.map(r => [r.providerId, Number(r._sum.amount ?? 0)]))
        const allProviderIds = [...new Set([...gainedMap.keys(), ...lostMap.keys()])]
        const providers = await prisma.gameProvider.findMany({
            where: { id: { in: allProviderIds } },
            select: { id: true, code: true },
        })
        const providerMap = new Map(providers.map(p => [p.id, p.code]))
        const providerStats = allProviderIds.map(pid => {
            const gained = gainedMap.get(pid) ?? 0
            const lost = lostMap.get(pid) ?? 0
            return {
                name: providerMap.get(pid) ?? pid,
                gained,
                lost,
                net: gained - lost,
            }
        })

        const totalProviderProfit = providerStats.reduce((sum, p) => sum + p.net, 0)
        const bingoProfit = houseSummary.COMMISSION
        const totalProfit = bingoProfit + totalProviderProfit

        return {
            approvedDepositSum: Number(approvedDeposits._sum.amount ?? 0),
            approvedWithdrawalSum: Number(approvedWithdrawals._sum.amount ?? 0),
            totalPrizesSum: Number(totalPrizes._sum.amount ?? 0),
            gamesCompleted,
            gamesCancelled,
            totalPrizePools,
            activePlayers,
            houseBalance: Number(houseBalance),
            houseCommissionEarned: bingoProfit,
            totalProviderProfit,
            totalProfit,
            providerStats,
            // Legacy fields
            declinedDepositSum: 0,
            usersCount: 0,
            gamesCount: gamesCompleted,
            commission: bingoProfit,
        }
    }

    static async getTransactions(params: {
        type?: TransactionType
        status?: PaymentStatus
        page?: number
        limit?: number
        from?: Date
        to?: Date
        minAmount?: number
        maxAmount?: number
        userSerial?: number
        search?: string
    }) {
        const page = params.page ?? 1
        const limit = params.limit ?? 50
        const skip = (page - 1) * limit

        const where: any = {
            ...(params.type && { type: params.type }),
            ...(params.status && { status: params.status }),
            ...((params.from || params.to) && {
                createdAt: {
                    ...(params.from && { gte: params.from }),
                    ...(params.to && { lte: params.to }),
                },
            }),
            ...((params.minAmount !== undefined || params.maxAmount !== undefined) && {
                amount: {
                    ...(params.minAmount !== undefined && { gte: params.minAmount }),
                    ...(params.maxAmount !== undefined && { lte: params.maxAmount }),
                },
            }),
        }

        // user filter: serial and/or search — built separately to avoid overwriting
        const userFilter: any = {}
        if (params.userSerial !== undefined) {
            userFilter.serial = params.userSerial
        }
        if (params.search) {
            userFilter.OR = [
                { username: { contains: params.search, mode: 'insensitive' } },
                { phone: { contains: params.search } },
            ]
        }
        if (Object.keys(userFilter).length > 0) {
            where.user = userFilter
        }

        const [data, total] = await Promise.all([
            prisma.transaction.findMany({
                where,
                include: {
                    user: {
                        select: { id: true, serial: true, username: true, phone: true },
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
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
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

    static async getMoneyFlow(params: {
        page?: number
        limit?: number
        direction?: 'IN' | 'OUT'
        types?: string[]
        from?: Date
        to?: Date
        search?: string
    }) {
        const page = params.page ?? 1
        const limit = params.limit ?? 30
        const skip = (page - 1) * limit

        const dateFilter = (params.from || params.to) ? {
            createdAt: {
                ...(params.from && { gte: params.from }),
                ...(params.to && { lte: params.to }),
            },
        } : {}

        // Direction mapping
        const IN_PLAYER_TYPES = ['DEPOSIT', 'PRIZE_WIN', 'ADMIN_REAL_ADJUSTMENT', 'ADMIN_BONUS_ADJUSTMENT', 'CASHBACK', 'REFERRAL_BONUS']
        const IN_HOUSE_TYPES = ['COMMISSION', 'BOT_PRIZE_WIN']

        // Fetch from all three sources in parallel
        const [playerTxs, houseTxs, providerTxs] = await Promise.all([
            prisma.transaction.findMany({
                where: {
                    ...dateFilter,
                    ...(params.search && {
                        user: {
                            OR: [
                                { username: { contains: params.search, mode: 'insensitive' } },
                                { phone: { contains: params.search } },
                            ],
                        },
                    }),
                },
                include: { user: { select: { username: true, id: true } } },
                orderBy: { createdAt: 'desc' },
                take: limit * 5,
            }),
            prisma.houseTransaction.findMany({
                where: { ...dateFilter },
                orderBy: { createdAt: 'desc' },
                take: limit * 5,
            }),
            prisma.thirdPartyTransaction.findMany({
                where: { ...dateFilter },
                orderBy: { createdAt: 'desc' },
                take: limit * 5,
            }),
        ])

        type FlowRow = {
            id: string
            createdAt: Date
            type: string
            direction: 'IN' | 'OUT'
            amount: number
            playerName?: string
            playerId?: string
            gameId?: string
            source: string
            balanceAfter?: number
        }

        const rows: FlowRow[] = []

        for (const tx of playerTxs) {
            const direction: 'IN' | 'OUT' = IN_PLAYER_TYPES.includes(tx.type) ? 'IN' : 'OUT'
            rows.push({
                id: tx.id,
                createdAt: tx.createdAt,
                type: tx.type,
                direction,
                amount: Number(tx.amount),
                playerName: (tx as any).user?.username,
                playerId: (tx as any).user?.id,
                gameId: (tx as any).gameId ?? undefined,
                source: 'Player Wallet',
                balanceAfter: Number(tx.balanceAfter),
            })
        }

        for (const tx of houseTxs) {
            const direction: 'IN' | 'OUT' = IN_HOUSE_TYPES.includes(tx.type) ? 'IN' : 'OUT'
            rows.push({
                id: tx.id,
                createdAt: tx.createdAt,
                type: tx.type,
                direction,
                amount: Number(tx.amount),
                playerId: tx.userId ?? undefined,
                gameId: tx.gameId ?? undefined,
                source: 'House Wallet',
                balanceAfter: Number(tx.balanceAfter),
            })
        }

        for (const tx of providerTxs) {
            const net = Number(tx.amount)
            // negative amount = debit from player = house gained (IN)
            // positive amount = credit to player = house lost (OUT)
            const direction: 'IN' | 'OUT' = net < 0 ? 'IN' : 'OUT'
            rows.push({
                id: tx.id,
                createdAt: tx.createdAt,
                type: `PROVIDER_${tx.type}`,
                direction,
                amount: Math.abs(net),
                playerId: tx.userId,
                source: 'Provider',
            })
        }

        // Filter by direction
        const afterDirection = params.direction
            ? rows.filter(r => r.direction === params.direction)
            : rows

        // Filter by types
        const afterTypes = params.types?.length
            ? afterDirection.filter(r => params.types!.includes(r.type))
            : afterDirection

        // Sort descending by date and paginate
        afterTypes.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        const total = afterTypes.length
        const paginated = afterTypes.slice(skip, skip + limit)

        // Summary totals (platform-wide, not affected by filters)
        const [depositSum, wagerSum, prizeSum, houseSummary] = await Promise.all([
            prisma.transaction.aggregate({
                where: { type: TransactionType.DEPOSIT, status: PaymentStatus.APPROVED },
                _sum: { amount: true },
            }),
            prisma.transaction.aggregate({
                where: { type: TransactionType.GAME_ENTRY },
                _sum: { amount: true },
            }),
            prisma.transaction.aggregate({
                where: { type: TransactionType.PRIZE_WIN, status: PaymentStatus.APPROVED },
                _sum: { amount: true },
            }),
            HouseWalletService.getSummary(),
        ])

        return {
            rows: paginated,
            total,
            page,
            limit,
            summary: {
                totalDeposited: Number(depositSum._sum.amount ?? 0),
                totalWagered: Number(wagerSum._sum.amount ?? 0),
                totalPrizesOut: Number(prizeSum._sum.amount ?? 0),
                houseKept: houseSummary.COMMISSION,
                refundsIssued: houseSummary.REFUND_ISSUED,
            },
        }
    }
}

