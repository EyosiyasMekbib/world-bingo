import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'

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

server.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

const port = Number(process.env.PORT) || 8080
const host = process.env.HOST ?? '0.0.0.0'

try {
    await server.listen({ port, host })
} catch (err) {
    server.log.error(err)
    process.exit(1)
}
