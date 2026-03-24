import prisma from '../lib/prisma'
import { checkPattern, PatternName } from '@world-bingo/game-logic'
import { getCalledBalls } from '../lib/game-state'

export class BotService {
    /**
     * Inject bot players into a waiting game based on the game's template bot configuration.
     *
     * Bots are only injected for template-based games where botEnabled is true.
     * Each bot gets a wallet funded to exactly (ticketPrice * botCount) before joining.
     * Bot accounts are upserted (reused across games) and never deleted.
     */
    static async injectBots(gameId: string): Promise<void> {
        try {
            // 1. Load game and its template
            const game = await prisma.game.findUnique({
                where: { id: gameId },
                include: { template: true },
            })

            if (!game || !game.templateId || !game.template) {
                console.log(`[BotService] Game ${gameId} has no template, skipping bot injection`)
                return
            }

            const template = game.template

            if (!template.botEnabled) {
                console.log(`[BotService] Bots disabled for template ${template.id}, skipping`)
                return
            }

            // 2. Count current unique players
            const playerGroups = await prisma.gameEntry.groupBy({
                by: ['userId'],
                where: { gameId },
            })
            const playerCount = playerGroups.length

            // 3. Determine how many bots are needed
            let botsNeeded: number
            if (template.botFillToMin) {
                botsNeeded = Math.min(
                    Math.max(0, game.minPlayers - playerCount),
                    template.botCount,
                )
            } else {
                botsNeeded = template.botCount
            }

            if (botsNeeded <= 0) {
                console.log(`[BotService] No bots needed for game ${gameId}`)
                return
            }

            console.log(`[BotService] Injecting ${botsNeeded} bots into game ${gameId}`)

            // 4. Find available (unclaimed) cartelas for this game
            const takenCartelaIds = (
                await prisma.gameEntry.findMany({
                    where: { gameId },
                    select: { cartelaId: true },
                })
            ).map((e) => e.cartelaId)

            const availableCartelas = await prisma.cartela.findMany({
                where: takenCartelaIds.length > 0 ? { id: { notIn: takenCartelaIds } } : {},
                take: botsNeeded,
                orderBy: { serial: 'asc' },
            })

            if (availableCartelas.length === 0) {
                console.warn(`[BotService] No cartelas available for game ${gameId}`)
                return
            }

            const actualBots = Math.min(botsNeeded, availableCartelas.length)
            if (actualBots < botsNeeded) {
                console.warn(
                    `[BotService] Only ${actualBots} cartelas available for game ${gameId} (needed ${botsNeeded})`,
                )
            }

            // 5. Top up wallet and join each bot
            // Bot usernames are per-template (bot_t<templateId>_<slot>) so the same bot
            // identity is reused across all games of a template — enabling spend tracking.
            const ticketPrice = Number(game.ticketPrice)
            const templateKey = template.id.replace(/-/g, '')

            const { GameService } = await import('./game.service.js')

            for (let i = 0; i < actualBots; i++) {
                const botUsername = `bot_t${templateKey}_${i}`
                const cartela = availableCartelas[i]

                // Upsert bot user — phone is null to avoid uniqueness collisions
                const botUser = await prisma.user.upsert({
                    where: { username: botUsername },
                    update: { isActive: true },
                    create: {
                        username: botUsername,
                        phone: null,
                        role: 'PLAYER',
                        passwordHash: 'BOT_ACCOUNT',
                        isActive: true,
                    },
                    select: { id: true },
                })

                // Fund bot wallet with exactly one ticket's worth (idempotent top-up)
                await prisma.wallet.upsert({
                    where: { userId: botUser.id },
                    update: { balance: ticketPrice },
                    create: {
                        userId: botUser.id,
                        balance: ticketPrice,
                        currency: 'ETB',
                    },
                })

                // Enforce bot spend limit
                const globalLimitRow = await prisma.siteSetting.findUnique({ where: { key: 'bot_max_spend_etb' } })
                const globalLimit = Number(globalLimitRow?.value ?? 500)
                const effectiveLimit = template.botMaxSpend != null ? Number(template.botMaxSpend) : globalLimit
                const currentBot = await prisma.user.findUnique({
                    where: { id: botUser.id },
                    select: { botTotalSpent: true },
                })
                const totalSpent = Number(currentBot?.botTotalSpent ?? 0)
                if (totalSpent >= effectiveLimit) {
                    console.log(
                        `[BotService] Bot ${botUsername} has reached spend limit (${totalSpent}/${effectiveLimit} ETB) — skipping`,
                    )
                    continue
                }

                // Join the game — reuses existing join logic (wallet deduction, socket events, lobby counts)
                await GameService.joinGame(botUser.id, gameId, [cartela.serial])

                // Increment bot's cumulative spend
                await prisma.user.update({
                    where: { id: botUser.id },
                    data: { botTotalSpent: { increment: ticketPrice } },
                })
            }

            console.log(`[BotService] Successfully injected ${actualBots} bots into game ${gameId}`)
        } catch (err) {
            console.error(`[BotService] injectBots failed for game ${gameId}:`, err)
        }
    }

    /**
     * Watch a game's ball calls and claim bingo immediately when any bot's cartela matches the pattern.
     *
     * Uses Redis for live ball data (Postgres calledBalls is only persisted at game end).
     * Polling interval is (ball_interval_secs * 1000 + 500)ms.
     * Stops automatically when the game reaches COMPLETED or CANCELLED status.
     */
    static async playBotTurns(gameId: string): Promise<void> {
        try {
            // 1. Load all bot entries for this game
            const botEntries = await prisma.gameEntry.findMany({
                where: {
                    gameId,
                    user: { username: { startsWith: 'bot_t' } },
                },
                include: { cartela: true, user: true },
            })

            if (botEntries.length === 0) {
                console.log(`[BotService] No bots found for game ${gameId}, skipping playBotTurns`)
                return
            }

            // Get ball interval from site settings
            const row = await prisma.siteSetting.findUnique({ where: { key: 'ball_interval_secs' } })
            const ballIntervalMs = (Number(row?.value ?? 3)) * 1000 + 500

            // Load game pattern (stable for the lifetime of the game)
            const initialGame = await prisma.game.findUnique({
                where: { id: gameId },
                select: { pattern: true },
            })
            if (!initialGame) return
            const pattern = initialGame.pattern as PatternName

            let processedBallCount = 0

            // 2. Poll for new balls
            while (true) {
                const currentGame = await prisma.game.findUnique({
                    where: { id: gameId },
                    select: { status: true },
                })

                if (!currentGame) break

                if (currentGame.status === 'COMPLETED' || currentGame.status === 'CANCELLED') {
                    console.log(`[BotService] Game ${gameId} ended (${currentGame.status}), stopping bot polling`)
                    break
                }

                if (currentGame.status === 'IN_PROGRESS') {
                    // Use Redis for up-to-date called balls (DB is only updated at game end)
                    const calledBalls = await getCalledBalls(gameId)

                    if (calledBalls.length > processedBallCount) {
                        processedBallCount = calledBalls.length
                        const calledSet = new Set<number>(calledBalls)

                        // 3. Check each bot's cartela for a winning pattern
                        for (const entry of botEntries) {
                            const grid = entry.cartela.grid as number[][]
                            const won = checkPattern(pattern, grid, calledSet)

                            if (won) {
                                console.log(
                                    `[BotService] Bot ${entry.userId} has winning pattern in game ${gameId}, claiming bingo`,
                                )
                                // 4. Claim bingo immediately
                                const { GameService } = await import('./game.service.js')
                                await GameService.claimBingo(
                                    entry.userId,
                                    gameId,
                                    entry.cartelaId,
                                ).catch((err) => {
                                    console.error(
                                        `[BotService] Bot claimBingo failed for game ${gameId}:`,
                                        err,
                                    )
                                })
                                return
                            }
                        }
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, ballIntervalMs))
            }
        } catch (err) {
            console.error(`[BotService] playBotTurns failed for game ${gameId}:`, err)
        }
    }

    /**
     * Deactivate all bot users that participated in a game after it ends.
     *
     * Bot accounts are kept in the DB for reuse — only isActive is set to false.
     * They will be re-activated (isActive = true) on the next injectBots call.
     */
    static async deactivateBots(gameId: string): Promise<void> {
        try {
            const botEntries = await prisma.gameEntry.findMany({
                where: { gameId, user: { username: { startsWith: 'bot_t' } } },
                select: { userId: true },
                distinct: ['userId'],
            })
            if (botEntries.length === 0) return
            const result = await prisma.user.updateMany({
                where: { id: { in: botEntries.map((e) => e.userId) } },
                data: { isActive: false },
            })
            console.log(`[BotService] Deactivated ${result.count} bots for game ${gameId}`)
        } catch (err) {
            console.error(`[BotService] deactivateBots failed for game ${gameId}:`, err)
        }
    }
}
