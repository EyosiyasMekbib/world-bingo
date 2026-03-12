/**
 * RoomTimerService — Per-second countdown broadcaster
 *
 * Manages a Node.js setInterval for each room in the WAITING phase.
 * Every second it:
 *   1. Decrements `room:{roomId}:timer` in Redis via DECR (atomic).
 *   2. Emits `timer_update` to the Socket.io room.
 *   3. When timer hits 0, fires the Phase-2 validation branch.
 *
 * Only one timer runs per room per process. For multi-instance deployments,
 * the Redlock-based engine already ensures only one leader drives the game;
 * the countdown timer is intentionally kept lightweight and can safely run on
 * any instance that created the room (the first API node to receive the
 * minPlayers-reached event starts the countdown via the BullMQ countdown worker).
 */

import {
    decrementTimer,
    getTimer,
    getRoomPlayerCount,
    setRoomStatus,
    clearRoomState,
    RoomPhase,
} from '../lib/room-state'
import { getIo } from '../lib/socket'
import { GameStatus } from '@world-bingo/shared-types'
import prisma from '../lib/prisma'

/** Map of active countdown timers keyed by roomId */
const activeTimers = new Map<string, NodeJS.Timeout>()

/**
 * Start a 1-second tick countdown for a room.
 *
 * @param roomId      - The game/room ID.
 * @param initialSecs - Countdown duration in seconds (default 60).
 *
 * This is idempotent — calling it again for the same room while a timer is
 * already running is a no-op.
 */
export function startRoomCountdown(roomId: string, initialSecs = 60): void {
    if (activeTimers.has(roomId)) return // Already running

    console.log(`[RoomTimer] Starting ${initialSecs}s countdown for room ${roomId}`)

    const tick = async () => {
        try {
            const secondsLeft = await decrementTimer(roomId)
            const io = getIo()

                // Broadcast per-second tick
                ; (io.to(`game:${roomId}`) as any).emit('timer_update', { gameId: roomId, secondsLeft })

            if (secondsLeft <= 0) {
                // Timer expired — clear the interval before async work
                stopRoomCountdown(roomId)
                await handleTimerExpired(roomId)
            }
        } catch (err) {
            console.error(`[RoomTimer] Tick error for room ${roomId}:`, err)
            stopRoomCountdown(roomId)
        }
    }

    const intervalId = setInterval(tick, 1_000)
    activeTimers.set(roomId, intervalId)
}

/**
 * Stop and remove the countdown timer for a room.
 * Safe to call even if no timer is running.
 */
export function stopRoomCountdown(roomId: string): void {
    const id = activeTimers.get(roomId)
    if (id !== undefined) {
        clearInterval(id)
        activeTimers.delete(roomId)
    }
}

/**
 * Stop all timers (e.g. on graceful shutdown).
 */
export function stopAllRoomCountdowns(): void {
    for (const [roomId] of activeTimers) {
        stopRoomCountdown(roomId)
    }
}

/**
 * Phase-2 Validation — called when the 60-second timer hits 0.
 *
 * Branch A (Refund):  playerCount < 2 → REFUNDING → cancel & refund
 * Branch B (Start):   playerCount >= 2 → LOCKING → then IN_PROGRESS
 */
async function handleTimerExpired(roomId: string): Promise<void> {
    const io = getIo()

    try {
        let playerCount = await getRoomPlayerCount(roomId)

        // If Redis key expired, fall back to DB for an accurate count
        if (playerCount === 0) {
            const dbEntries = await prisma.gameEntry.findMany({
                where: { gameId: roomId },
                distinct: ['userId'],
                select: { userId: true },
            })
            playerCount = dbEntries.length
        }

        const game = await prisma.game.findUnique({
            where: { id: roomId },
            select: { minPlayers: true }
        })
        const minPlayers = game?.minPlayers ?? 2

        if (playerCount < minPlayers) {
            // ── Branch A: Not enough players ────────────────────────────────
            console.log(`[RoomTimer] Room ${roomId}: only ${playerCount} player(s) — REFUNDING`)
            await setRoomStatus(roomId, 'REFUNDING')

            // Delegate to GameService for atomic DB refunds + notifications
            const { GameService } = await import('../services/game.service.js')
            await GameService.cancelGame(roomId)

                ; (io.to(`game:${roomId}`) as any).emit('game_cancelled', {
                    gameId: roomId,
                    reason: 'Not enough players to start the game.',
                })
        } else {
            // ── Branch B: Enough players — lock and start ────────────────────
            console.log(`[RoomTimer] Room ${roomId}: ${playerCount} player(s) — LOCKING → IN_PROGRESS`)
            await setRoomStatus(roomId, 'LOCKING')

            // Update Postgres to LOCKING so new buy_tickets events are rejected
            await prisma.game.update({
                where: { id: roomId },
                data: { status: 'LOCKING' as any },
            }).catch(() => {
                // LOCKING may not exist yet in the DB enum during migration
                // fall through to startGame which will transition to IN_PROGRESS
            })

            // Transition to IN_PROGRESS via the normal GameService path
            const { GameService } = await import('../services/game.service.js')
            await GameService.startGame(roomId)
        }
    } catch (err) {
        console.error(`[RoomTimer] handleTimerExpired error for room ${roomId}:`, err)
        await clearRoomState(roomId).catch(() => { })
    }
}

/** Returns true if a countdown is currently ticking for this room. */
export function isCountdownActive(roomId: string): boolean {
    return activeTimers.has(roomId)
}
