import { Redis } from 'ioredis'
import { Server } from 'socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import type { Server as HttpServer } from 'http'
import {
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData,
} from '@world-bingo/shared-types'

let io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>

export function initSocket(httpServer: HttpServer, redisUrl: string) {
    const pubClient = new Redis(redisUrl)
    const subClient = pubClient.duplicate()

    pubClient.on('error', (err) => console.error('[Socket Redis pub] error:', err.message))
    subClient.on('error', (err) => console.error('[Socket Redis sub] error:', err.message))

    io = new Server(httpServer, {
        cors: {
            origin: process.env.CORS_ORIGIN?.split(',') ?? '*',
            methods: ['GET', 'POST'],
            credentials: true,
        },
        adapter: createAdapter(pubClient, subClient),
    })

    io.on('connection', (socket) => {
        console.log(`Socket connected: ${socket.id}`)

        socket.on('disconnect', () => {
            console.log(`Socket disconnected: ${socket.id}`)
        })
    })

    return io
}

export function getIo() {
    if (!io) {
        throw new Error('Socket.io not initialized!')
    }
    return io
}
