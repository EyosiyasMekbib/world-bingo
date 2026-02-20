import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import * as dotenv from 'dotenv'
import { initSocket } from './lib/socket'
import authRoutes from './routes/auth'
import gameRoutes from './routes/game'
import walletRoutes from './routes/wallet'
import './@types/fastify'

dotenv.config()

const server = Fastify({
    logger: {
        transport: {
            target: 'pino-pretty',
        },
    },
})

await server.register(cors, {
    origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:3000', 'http://localhost:3001'],
    credentials: true,
})

await server.register(jwt, {
    secret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
})

await server.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
})

await server.register(import('@fastify/formbody'))
await server.register(import('@fastify/multipart'))

await server.register(swagger, {
    openapi: {
        info: {
            title: 'World Bingo API',
            description: 'REST + WebSocket API for World Bingo',
            version: '1.0.0',
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

await server.register(authRoutes, { prefix: '/auth' })
await server.register(gameRoutes, { prefix: '/games' })
await server.register(walletRoutes, { prefix: '/wallet' })

server.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

const port = Number(process.env.PORT) || 8080
const host = process.env.HOST ?? '0.0.0.0'

try {
    await server.ready()
    initSocket(server.server, process.env.REDIS_URL || 'redis://localhost:6379')
    await server.listen({ port, host })
} catch (err) {
    server.log.error(err)
    process.exit(1)
}
