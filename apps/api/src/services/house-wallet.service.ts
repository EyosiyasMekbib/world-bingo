import prisma from '../lib/prisma'
import { Decimal } from '@prisma/client/runtime/library'
import { Prisma } from '@prisma/client'

export type { HouseTransactionType } from '@prisma/client'

export interface BotActivityRow {
    userId: string
    username: string
    totalSpent: number
    gamesPlayed: number
    gamesWon: number
    gamesLost: number
    isActive: boolean
    templateBotMaxSpend: number | null
}

export class HouseWalletService {
    /**
     * Get or create the singleton house wallet (id = "house").
     */
    static async getOrCreate() {
        return prisma.houseWallet.upsert({
            where: { id: 'house' },
            update: {},
            create: { id: 'house', balance: 0 },
        })
    }

    /**
     * Internal executor: upserts house wallet if missing, then credits/debits.
     * Accepts an optional transaction client for atomicity with the caller's transaction.
     */
    private static async execCredit(
        client: Prisma.TransactionClient,
        amt: Decimal,
        type: 'COMMISSION' | 'BOT_PRIZE_WIN' | 'REFUND_ISSUED',
        description: string,
        gameId?: string,
        userId?: string,
    ) {
        await client.$executeRaw`
            INSERT INTO house_wallet (id, balance, "updatedAt")
            VALUES ('house', 0, NOW())
            ON CONFLICT (id) DO NOTHING
        `
        const rows = await client.$queryRaw<Array<{ balance: Decimal }>>`
            SELECT balance FROM house_wallet WHERE id = 'house' FOR UPDATE
        `
        const before = new Decimal(rows[0]?.balance ?? 0)
        const after = before.plus(amt)
        await client.$executeRaw`UPDATE house_wallet SET balance = ${after}, "updatedAt" = NOW() WHERE id = 'house'`
        return client.houseTransaction.create({
            data: { type, amount: amt, description, gameId, userId, balanceBefore: before, balanceAfter: after },
        })
    }

    private static async execDebit(
        client: Prisma.TransactionClient,
        amt: Decimal,
        type: 'COMMISSION' | 'BOT_PRIZE_WIN' | 'REFUND_ISSUED',
        description: string,
        gameId?: string,
        userId?: string,
    ) {
        await client.$executeRaw`
            INSERT INTO house_wallet (id, balance, "updatedAt")
            VALUES ('house', 0, NOW())
            ON CONFLICT (id) DO NOTHING
        `
        const rows = await client.$queryRaw<Array<{ balance: Decimal }>>`
            SELECT balance FROM house_wallet WHERE id = 'house' FOR UPDATE
        `
        const before = new Decimal(rows[0]?.balance ?? 0)
        const after = before.minus(amt)
        await client.$executeRaw`UPDATE house_wallet SET balance = ${after}, "updatedAt" = NOW() WHERE id = 'house'`
        return client.houseTransaction.create({
            data: { type, amount: amt, description, gameId, userId, balanceBefore: before, balanceAfter: after },
        })
    }

    /**
     * Credit the house wallet. Pass `tx` to run atomically inside the caller's transaction.
     */
    static async credit(
        amount: Decimal | number,
        type: 'COMMISSION' | 'BOT_PRIZE_WIN' | 'REFUND_ISSUED',
        description: string,
        gameId?: string,
        userId?: string,
        tx?: Prisma.TransactionClient,
    ) {
        const amt = new Decimal(amount)
        if (tx) return HouseWalletService.execCredit(tx, amt, type, description, gameId, userId)
        return prisma.$transaction((t) => HouseWalletService.execCredit(t, amt, type, description, gameId, userId))
    }

    /**
     * Debit the house wallet. Pass `tx` to run atomically inside the caller's transaction.
     */
    static async debit(
        amount: Decimal | number,
        type: 'COMMISSION' | 'BOT_PRIZE_WIN' | 'REFUND_ISSUED',
        description: string,
        gameId?: string,
        userId?: string,
        tx?: Prisma.TransactionClient,
    ) {
        const amt = new Decimal(amount)
        if (tx) return HouseWalletService.execDebit(tx, amt, type, description, gameId, userId)
        return prisma.$transaction((t) => HouseWalletService.execDebit(t, amt, type, description, gameId, userId))
    }

    /**
     * Return current house wallet balance.
     */
    static async getBalance(): Promise<Decimal> {
        const wallet = await HouseWalletService.getOrCreate()
        return new Decimal(wallet.balance)
    }

    /**
     * Paginated transaction history, optionally filtered by type.
     */
    static async getTransactions(
        page = 1,
        limit = 20,
        type?: 'COMMISSION' | 'BOT_PRIZE_WIN' | 'REFUND_ISSUED',
    ) {
        const where = type ? { type } : {}
        const [transactions, total] = await Promise.all([
            prisma.houseTransaction.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            prisma.houseTransaction.count({ where }),
        ])
        return { transactions, total }
    }

    /**
     * Return one row per bot user with spend, game activity stats, and per-template spend limit.
     * Bots are identified by username prefix 'bot_t' (per-template bots).
     */
    static async getBotActivity(): Promise<BotActivityRow[]> {
        const bots = await prisma.user.findMany({
            where: { username: { startsWith: 'bot_t' } },
            select: {
                id: true,
                username: true,
                isActive: true,
                botTotalSpent: true,
                entries: {
                    select: {
                        gameId: true,
                        game: { select: { templateId: true } },
                    },
                },
            },
        })

        // Collect unique template IDs to batch-fetch botMaxSpend
        const templateIds = [
            ...new Set(
                bots.flatMap((b) => b.entries.map((e) => e.game.templateId).filter(Boolean) as string[]),
            ),
        ]
        const templates = await prisma.gameTemplate.findMany({
            where: { id: { in: templateIds } },
            select: { id: true, botMaxSpend: true },
        })
        const templateMap = new Map(templates.map((t) => [t.id, t]))

        return Promise.all(
            bots.map(async (bot) => {
                const gamesPlayed = new Set(bot.entries.map((e) => e.gameId)).size
                const gamesWon = await prisma.game.count({ where: { winnerId: bot.id } })
                // Derive per-template spend limit from the bot's most recent game entry
                const latestTemplateId = bot.entries[bot.entries.length - 1]?.game.templateId
                const template = latestTemplateId ? templateMap.get(latestTemplateId) : undefined
                return {
                    userId: bot.id,
                    username: bot.username ?? '',
                    totalSpent: Number(bot.botTotalSpent),
                    gamesPlayed,
                    gamesWon,
                    gamesLost: Math.max(0, gamesPlayed - gamesWon),
                    isActive: bot.isActive,
                    templateBotMaxSpend: template?.botMaxSpend != null ? Number(template.botMaxSpend) : null,
                }
            }),
        )
    }

    /**
     * Aggregate totals by type for summary chips on the admin page.
     */
    static async getSummary() {
        const rows = await prisma.houseTransaction.groupBy({
            by: ['type'],
            _sum: { amount: true },
        })
        const summary: Record<string, number> = {
            COMMISSION: 0,
            BOT_PRIZE_WIN: 0,
            REFUND_ISSUED: 0,
        }
        for (const r of rows) {
            summary[r.type] = Number(r._sum.amount ?? 0)
        }
        return summary
    }
}
