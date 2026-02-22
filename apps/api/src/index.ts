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
import { closeAllQueues } from './lib/queue'
import { register as metricsRegistry, httpRequestsTotal } from './lib/metrics'
import authRoutes from './routes/auth'
import gameRoutes from './routes/game'
import walletRoutes from './routes/wallet'
import adminRoutes from './routes/admin'
import notificationRoutes from './routes/user/index.js'
import { registerBullBoard } from './routes/bull-board.js'
import './@types/fastify.d.ts'
import { registerGameHandlers } from './gateways/game.gateway'

dotenv.config()

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
    secret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
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
    await closeAllQueues().catch(() => {})
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

const port = Number(process.env.PORT) || 8080
const host = process.env.HOST ?? '0.0.0.0'

try {
    await server.ready()
    const io = initSocket(server.server, process.env.REDIS_URL || 'redis://localhost:6379')
    registerGameHandlers(io)
    
    await server.listen({ port, host })
} catch (err) {
    server.log.error(err)
    process.exit(1)
}
