import { Socket } from 'socket.io'
import { getIo } from '../lib/socket.js'
import { GameService } from '../services/game.service.js'
import { ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData } from '@world-bingo/shared-types'
import { verifyJwt } from '../lib/auth.js'
import { getRoomStatus, getRoomPlayerCount, getPot } from '../lib/room-state.js'
import prisma from '../lib/prisma.js'

// Helper to type the socket
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>

export function registerGameHandlers(io: any) {
    io.on('connection', (socket: GameSocket) => {
        // Authenticate socket
        const token = socket.handshake.auth.token
        if (!token) {
            // socket.disconnect() // or allow viewing without playing? Spec implies real-money so auth required.
            // keeping it loose for now, but strict actions need auth
        } else {
             try {
                const user = verifyJwt(token)
                socket.data.userId = user.id
                socket.data.username = user.username
                socket.join(`user:${user.id}`)
             } catch (e) {
                 console.error('Invalid socket token')
             }
        }

        // ── Spectator / room entry ─────────────────────────────────────────
        // T24: Non-paying spectator room entry (for watching or for players already joined via REST)
        socket.on('game:join-room', async ({ gameId }) => {
            socket.join(`game:${gameId}`)
            socket.data.gameId = gameId

            // Send the current room snapshot to the newly joined spectator
            try {
                const [redisPlayerCount, pot, secondsLeft] = await Promise.all([
                    getRoomPlayerCount(gameId),
                    getPot(gameId),
                    // timer is a Redis GET — import inline to avoid circular dep
                    import('../lib/room-state.js').then(m => m.getTimer(gameId)),
                ])

                // If Redis is cold (restarted / first join), fall back to DB count
                let playerCount = redisPlayerCount
                if (playerCount === 0) {
                    const dbCount = await prisma.gameEntry.findMany({
                        where: { gameId },
                        distinct: ['userId'],
                        select: { userId: true },
                    })
                    playerCount = dbCount.length
                }

                ;(socket as any).emit('player_count_update', { gameId, playerCount })
                ;(socket as any).emit('pot_update', { gameId, pot })
                // Only send timer if there's an active countdown
                if (secondsLeft != null && secondsLeft > 0) {
                    ;(socket as any).emit('timer_update', { gameId, secondsLeft })
                }
            } catch {
                // Non-critical — client will get next broadcast tick
            }
        })

        // ── Buy Tickets (WAITING phase) ────────────────────────────────────
        /**
         * Spec: client emits 'buy_tickets' during WAITING phase.
         * Server must:
         *   1. Reject if room is LOCKING or beyond.
         *   2. Delegate to GameService.joinGame for atomic DB write.
         *   3. Broadcast updated player_count + pot to the room.
         */
        ;(socket as any).on('buy_tickets', async ({ gameId, cartelaIds }: { gameId: string; cartelaIds: string[] }) => {
            if (!socket.data.userId) {
                return (socket as any).emit('error', { message: 'Unauthorized', code: '401' })
            }

            // LOCKING gate — reject ticket purchases once timer hits 0
            const roomPhase = await getRoomStatus(gameId).catch(() => null)
            if (roomPhase && roomPhase !== 'WAITING') {
                return (socket as any).emit('error', {
                    message: 'Ticket sales are closed. The game is about to start.',
                    code: '423', // Locked
                })
            }

            try {
                await GameService.joinGame(socket.data.userId, gameId, cartelaIds)
                socket.join(`game:${gameId}`)
                socket.data.gameId = gameId

                // Broadcast updated player count and pot to the entire room
                const [playerCount, pot] = await Promise.all([
                    getRoomPlayerCount(gameId),
                    getPot(gameId),
                ])

                const roomIo = getIo()
                ;(roomIo.to(`game:${gameId}`) as any).emit('player_count_update', { gameId, playerCount })
                ;(roomIo.to(`game:${gameId}`) as any).emit('pot_update', { gameId, pot })
            } catch (e: any) {
                ;(socket as any).emit('error', { message: e.message, code: '400' })
            }
        })

        // ── Legacy single-cartela join (kept for back-compat) ──────────────
        socket.on('game:join', async ({ gameId, cartelaId }) => {
            if (!socket.data.userId) return socket.emit('error', { message: 'Unauthorized', code: '401' })

            // LOCKING gate
            const roomPhase = await getRoomStatus(gameId).catch(() => null)
            if (roomPhase && roomPhase !== 'WAITING') {
                return socket.emit('error', {
                    message: 'Ticket sales are closed. The game is about to start.',
                    code: '423',
                })
            }

            try {
                await GameService.joinGame(socket.data.userId, gameId, [cartelaId])
                socket.join(`game:${gameId}`)
                socket.data.gameId = gameId

                const [playerCount, pot] = await Promise.all([
                    getRoomPlayerCount(gameId),
                    getPot(gameId),
                ])

                const roomIo = getIo()
                ;(roomIo.to(`game:${gameId}`) as any).emit('player_count_update', { gameId, playerCount })
                ;(roomIo.to(`game:${gameId}`) as any).emit('pot_update', { gameId, pot })
            } catch (e: any) {
                socket.emit('error', { message: e.message, code: '400' })
            }
        })

        // ── Claim Bingo (client-side win assertion) ────────────────────────
        socket.on('game:claim-bingo', async ({ gameId, cartelaId }) => {
             if (!socket.data.userId) return socket.emit('error', { message: 'Unauthorized', code: '401' })
             try {
                 await GameService.claimBingo(socket.data.userId, gameId, cartelaId)
             } catch (e: any) {
                 socket.emit('error', { message: e.message, code: '400' })
             }
        })

        // ── Lobby ──────────────────────────────────────────────────────────
        socket.on('lobby:subscribe', () => {
             socket.join('lobby')
        })

        socket.on('lobby:unsubscribe', () => {
            socket.leave('lobby')
       })
    })
}
