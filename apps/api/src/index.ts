import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import helmet from '@fastify/helmet'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import staticFiles from '@fastify/static'
import * as dotenv from 'dotenv'
import path from 'path'
import { initSocket } from './lib/socket'
import { stopAllEngines } from './lib/game-engine'
import prisma from './lib/prisma'
import { stopAllRoomCountdowns } from './services/room-timer.service'
import { closeAllQueues } from './lib/queue'
import { register as metricsRegistry, httpRequestsTotal } from './lib/metrics'
import authRoutes from './routes/auth'
import gameRoutes from './routes/game'
import walletRoutes from './routes/wallet'
import adminRoutes from './routes/admin'
import notificationRoutes from './routes/user/index.js'
import referralRoutes from './routes/referral'
import tournamentRoutes from './routes/tournament'
import settingsRoutes from './routes/settings'
import { registerBullBoard } from './routes/bull-board.js'
import './@types/fastify.d.ts'
import { registerGameHandlers } from './gateways/game.gateway'
import { jwtPrivateKey, jwtPublicKey } from './lib/jwt-keys.js'

// Import workers so they auto-start with the server process
import './workers/game-countdown.worker.js'
import './workers/game-scheduler.worker.js'
import './workers/game-engine.worker.js'

dotenv.config()

if (!jwtPrivateKey || !jwtPublicKey) {
    console.error('FATAL: JWT keys not set. Provide JWT_PRIVATE_KEY_BASE64/JWT_PUBLIC_KEY_BASE64 or JWT_PRIVATE_KEY/JWT_PUBLIC_KEY')
    process.exit(1)
}

const isProd = process.env.NODE_ENV === 'production'

const server = Fastify({
    logger: isProd
        ? true
        : {
            transport: {
                target: 'pino-pretty',
            },
        },
    // Prevent server information leakage
    disableRequestLogging: false,
    trustProxy: true, // Required when behind nginx/load balancer for correct IP in rate limiting
})

// Security headers
await server.register(helmet, {
    // Allow WebSocket upgrade
    contentSecurityPolicy: isProd
        ? undefined
        : false,
})

// CORS — strict in production, permissive in dev
await server.register(cors, {
    origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:3000', 'http://localhost:3001'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
})

await server.register(jwt, {
    secret: {
        private: jwtPrivateKey,
        public: jwtPublicKey,
    },
    sign: { algorithm: 'RS256', expiresIn: '15m' },
})

// Global rate limiting: 100 requests / minute per IP
await server.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
        return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip
    },
    errorResponseBuilder: () => ({
        statusCode: 429,
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please slow down.',
    }),
})

await server.register(import('@fastify/formbody'))
await server.register(import('@fastify/multipart'), {
    limits: {
        fileSize: 5 * 1024 * 1024, // 5 MB max upload
    },
})

await server.register(swagger, {
    openapi: {
        info: {
            title: 'World Bingo API',
            description: 'REST + WebSocket API for World Bingo',
            version: '1.0.0',
        },
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                },
            },
        },
    },
})

await server.register(swaggerUi, {
    routePrefix: '/docs',
})

server.setErrorHandler((error, request, reply) => {
    // Map common service errors to appropriate status codes
    if (error.message === 'Invalid credentials' || error.message === 'Invalid refresh token') {
        return reply.status(401).send({
            statusCode: 401,
            error: 'Unauthorized',
            message: error.message
        })
    }

    if (error.message === 'User already exists') {
        return reply.status(409).send({
            statusCode: 409,
            error: 'Conflict',
            message: error.message
        })
    }

    if (error.message === 'User not found') {
        return reply.status(404).send({
            statusCode: 404,
            error: 'Not Found',
            message: error.message
        })
    }

    // Default error handler
    const statusCode = error.statusCode || 500
    return reply.status(statusCode).send({
        statusCode,
        error: error.name || 'Internal Server Error',
        message: error.message
    })
})

server.decorate('authenticate', async function (request: any, reply: any) {
    try {
        await request.jwtVerify()
    } catch (err) {
        reply.send(err)
    }
})

// Register route prefixes
await server.register(authRoutes, { prefix: '/auth' })
await server.register(gameRoutes, { prefix: '/games' })
await server.register(walletRoutes, { prefix: '/wallet' })
await server.register(adminRoutes, { prefix: '/admin' })
await server.register(notificationRoutes, { prefix: '/user' })
await server.register(referralRoutes, { prefix: '/referral' })
await server.register(tournamentRoutes, { prefix: '/tournaments' })
await server.register(settingsRoutes, { prefix: '/settings' })

// T49 — BullMQ Dashboard at /admin/queues
await registerBullBoard(server)

// Serve local uploads directory (dev only)
if (!isProd) {
    const uploadsDir = new URL('../uploads', import.meta.url).pathname
    const fs = await import('fs')
    if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true })
    }
    await server.register(staticFiles, {
        root: uploadsDir,
        prefix: '/uploads/',
    })
}

server.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

// T52 — Prometheus metrics endpoint (internal/admin use)
server.get('/metrics', {
    config: { rateLimit: false },
}, async (_req, reply) => {
    reply.header('Content-Type', metricsRegistry.contentType)
    return reply.send(await metricsRegistry.metrics())
})

// T52 — Track HTTP request counts
server.addHook('onResponse', async (request, reply) => {
    const route = (request as any).routerPath ?? request.url.split('?')[0]
    httpRequestsTotal.labels(request.method, route, String(reply.statusCode)).inc()
})

// Graceful shutdown
const shutdown = async (signal: string) => {
    server.log.info(`Received ${signal}. Starting graceful shutdown...`)
    stopAllEngines()
    stopAllRoomCountdowns()
    await closeAllQueues().catch(() => { })
    await prisma.$disconnect().catch(() => { })
    try {
        await server.close()
        server.log.info('Server closed cleanly.')
        process.exit(0)
    } catch (err) {
        server.log.error(err, 'Error during graceful shutdown')
        process.exit(1)
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (reason, promise) => {
    server.log.error({ reason, promise }, 'Unhandled promise rejection — potential crash avoided')
})
process.on('uncaughtException', (err) => {
    server.log.error(err, 'Uncaught exception — shutting down')
    shutdown('uncaughtException')
})

const port = Number(process.env.PORT) || 8080
const host = process.env.HOST ?? '0.0.0.0'

try {
    await server.ready()
    const io = initSocket(server.server, process.env.REDIS_URL || 'redis://localhost:6379')
    registerGameHandlers(io)

    await server.listen({ port, host })

    // Recovery: restart countdowns for any WAITING games that already have players
    // and push LOCKING/STARTING games into the engine
    setTimeout(async () => {
        try {
            const { GameSchedulerService } = await import('./services/game-scheduler.service.js')
            const { GameService } = await import('./services/game.service.js')
            const prismaClient = (await import('./lib/prisma.js')).default

            const stuckGames = await prismaClient.game.findMany({
                where: { status: { in: ['WAITING', 'LOCKING', 'STARTING'] as any } },
                include: { entries: { distinct: ['userId'], select: { userId: true } } },
            })

            for (const game of stuckGames) {
                const playerCount = game.entries.length
                if ((game.status as any) === 'WAITING') {
                    if (playerCount > 0) {
                        console.log(`[Startup] Recovering countdown for WAITING game ${game.id} (${playerCount} players)`)
                        await GameSchedulerService.checkAndStartCountdown(game.id).catch((err) => console.error(`[Startup] Recovery failed for game ${game.id}:`, err))
                    }
                } else if ((game.status as any) === 'LOCKING' || (game.status as any) === 'STARTING') {
                    if (playerCount > 0) {
                        console.log(`[Startup] Recovering ${game.status} game ${game.id} → startGame`)
                        await GameService.startGame(game.id).catch((err) => console.error(`[Startup] Recovery failed for game ${game.id}:`, err))
                    } else {
                        console.log(`[Startup] Cancelling empty ${game.status} game ${game.id}`)
                        await GameService.cancelGame(game.id).catch((err) => console.error(`[Startup] Recovery failed for game ${game.id}:`, err))
                    }
                }
            }
        } catch (err) {
            console.error('[Startup] Game recovery failed:', err)
        }
    }, 3_000)
} catch (err) {
    server.log.error(err)
    process.exit(1)
}
