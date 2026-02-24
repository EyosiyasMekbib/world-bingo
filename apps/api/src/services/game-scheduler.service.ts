/**
 * GameSchedulerService — Auto-replenishing game templates
 *
 * Ensures that for every active GameTemplate, there is always at least one
 * game in WAITING status in the lobby. When a game completes or is cancelled,
 * a new one is automatically created from the same template.
 *
 * Also handles the 60-second countdown auto-start:
 *   - When a game reaches minPlayers, schedule a countdown job.
 *   - When the countdown expires, start the game engine.
 *   - If the game is cancelled before countdown ends, the job is removed.
 */

import prisma from '../lib/prisma'
import { GameStatus } from '@world-bingo/shared-types'
import { getIo } from '../lib/socket'
import { getQueue, QUEUE_NAMES } from '../lib/queue'

export class GameSchedulerService {
    /**
     * Check all active templates and ensure each has at least one WAITING game.
     * Called periodically by the game-scheduler worker.
     */
    static async replenishAll(): Promise<void> {
        const templates = await prisma.gameTemplate.findMany({
            where: { active: true },
        })

        for (const template of templates) {
            await GameSchedulerService.replenishTemplate(template.id)
        }
    }

    /**
     * Ensure a specific template has at least one WAITING game.
     */
    static async replenishTemplate(templateId: string): Promise<void> {
        const template = await prisma.gameTemplate.findUnique({
            where: { id: templateId },
        })
        if (!template || !template.active) return

        // Count WAITING games for this template
        const waitingCount = await prisma.game.count({
            where: {
                templateId: template.id,
                status: GameStatus.WAITING,
            },
        })

        if (waitingCount > 0) return // Already have a game waiting

        // Create a new game from the template
        await GameSchedulerService.createFromTemplate(templateId)
    }

    /**
     * Create a new WAITING game from a template and notify the lobby.
     */
    static async createFromTemplate(templateId: string): Promise<string> {
        const template = await prisma.gameTemplate.findUnique({
            where: { id: templateId },
        })
        if (!template) throw new Error(`Template ${templateId} not found`)

        const game = await prisma.game.create({
            data: {
                title: template.title,
                ticketPrice: template.ticketPrice,
                maxPlayers: template.maxPlayers,
                minPlayers: template.minPlayers,
                houseEdgePct: template.houseEdgePct,
                pattern: template.pattern,
                status: GameStatus.WAITING,
                calledBalls: [],
                templateId: template.id,
            },
        })

        // Broadcast new game to lobby
        try {
            const io = getIo()
            io.to('lobby').emit('lobby:game-added', game as any)
        } catch {
            // Socket not initialized yet (during startup)
        }

        console.log(
            `[GameScheduler] Created game ${game.id} from template "${template.title}" (${template.ticketPrice} ETB)`,
        )

        return game.id
    }

    /**
     * Called after a player joins a game. If the game now has >= minPlayers
     * and doesn't already have a countdown scheduled, schedule one.
     */
    static async checkAndStartCountdown(gameId: string): Promise<void> {
        const game = await prisma.game.findUnique({
            where: { id: gameId },
            include: {
                _count: { select: { entries: true } },
                template: true,
            },
        })

        if (!game || game.status !== GameStatus.WAITING) return

        // Count distinct players (a player with 3 cartelas counts as 1)
        const distinctPlayers = await prisma.gameEntry.groupBy({
            by: ['userId'],
            where: { gameId },
        })

        const playerCount = distinctPlayers.length
        if (playerCount < game.minPlayers) return

        const countdownSecs = game.template?.countdownSecs ?? 60

        // Check if a countdown job is already scheduled for this game
        const countdownQueue = getQueue(QUEUE_NAMES.GAME_COUNTDOWN)
        const existingJobs = await countdownQueue.getJobs(['delayed', 'waiting'])
        const alreadyScheduled = existingJobs.some(
            (j) => j.data?.gameId === gameId,
        )

        if (alreadyScheduled) return

        // Schedule the countdown job
        await countdownQueue.add(
            `countdown-${gameId}`,
            { gameId },
            {
                delay: countdownSecs * 1000,
                removeOnComplete: { count: 50 },
                removeOnFail: { count: 50 },
                jobId: `countdown-${gameId}`, // Dedup key
            },
        )

        // Notify all clients in the game room about the countdown
        try {
            const io = getIo()
            io.to(`game:${gameId}`).emit('game:countdown', {
                gameId,
                countdownSecs,
                startsAt: new Date(Date.now() + countdownSecs * 1000).toISOString(),
            } as any)
            // Also update lobby
            io.to('lobby').emit('game:countdown', {
                gameId,
                countdownSecs,
                startsAt: new Date(Date.now() + countdownSecs * 1000).toISOString(),
            } as any)
        } catch {
            // Socket might not be ready
        }

        console.log(
            `[GameScheduler] Countdown started for game ${gameId}: ${countdownSecs}s`,
        )
    }

    /**
     * Called when the countdown expires. Auto-starts the game via the engine.
     */
    static async handleCountdownExpired(gameId: string): Promise<void> {
        const game = await prisma.game.findUnique({
            where: { id: gameId },
            include: {
                entries: { distinct: ['userId'], select: { userId: true } },
            },
        })

        if (!game) return
        if (game.status !== GameStatus.WAITING) {
            console.log(
                `[GameScheduler] Game ${gameId} is no longer WAITING (${game.status}), skipping auto-start`,
            )
            return
        }

        const playerCount = game.entries.length
        if (playerCount < game.minPlayers) {
            console.log(
                `[GameScheduler] Game ${gameId} has ${playerCount}/${game.minPlayers} players, not enough to start — skipping`,
            )
            return
        }

        // Auto-start: update status to STARTING and fire game engine
        console.log(`[GameScheduler] Auto-starting game ${gameId} with ${playerCount} players`)

        // Dynamic import to avoid circular dependency
        const { GameService } = await import('../services/game.service.js')
        await GameService.startGame(gameId)
    }

    /**
     * Called when a templated game ends (completed/cancelled).
     * Replenish the template so a new WAITING game appears.
     */
    static async onGameEnded(gameId: string): Promise<void> {
        const game = await prisma.game.findUnique({
            where: { id: gameId },
            select: { templateId: true },
        })

        if (!game?.templateId) return // Not a templated game

        // Small delay so players see the result screen before a new game appears
        setTimeout(() => {
            GameSchedulerService.replenishTemplate(game.templateId!).catch((err) => {
                console.error(`[GameScheduler] Failed to replenish template ${game.templateId}:`, err)
            })
        }, 5_000)
    }
}
