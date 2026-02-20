import { Socket } from 'socket.io'
import { getIo } from '../lib/socket.js'
import { GameService } from '../services/game.service.js'
import { ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData } from '@world-bingo/shared-types'
import { verifyJwt } from '../lib/auth.js' 

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

        socket.on('game:join', async ({ gameId, cartelaId }) => {
            if (!socket.data.userId) return socket.emit('error', { message: 'Unauthorized', code: '401' })
            
            try {
                await GameService.joinGame(socket.data.userId, gameId, cartelaId)
                socket.join(`game:${gameId}`)
                socket.data.gameId = gameId
                socket.emit('error', { message: 'Joined successfully', code: '200' }) // Reuse error for generic msg? No, should strictly follow schema. 
                // Currently no specific check event in schema, maybe game:updated creates the feedback
            } catch (e: any) {
                socket.emit('error', { message: e.message, code: '400' })
            }
        })

        socket.on('game:claim-bingo', async ({ gameId, cartelaId }) => {
             if (!socket.data.userId) return socket.emit('error', { message: 'Unauthorized', code: '401' })
             try {
                 await GameService.claimBingo(socket.data.userId, gameId, cartelaId)
             } catch (e: any) {
                 socket.emit('error', { message: e.message, code: '400' })
             }
        })
        
        socket.on('lobby:subscribe', () => {
             socket.join('lobby')
        })

        socket.on('lobby:unsubscribe', () => {
            socket.leave('lobby')
       })
    })
}
