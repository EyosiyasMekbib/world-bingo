import { initSentry, Sentry, reportError } from './lib/sentry.js'
import { initPostHog, shutdownPostHog } from './lib/posthog'

// Initialise error reporting before anything else so early failures are captured.
// No-op when SENTRY_DSN is unset.
initSentry()
initPostHog()

import Fastify, { type FastifyError } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import helmet from '@fastify/helmet'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import staticFiles from '@fastify/static'
import path from 'path'
import { initSocket } from './lib/socket'
import { stopAllEngines } from './lib/game-engine'
import prisma from './lib/prisma'
import { stopAllRoomCountdowns } from './services/room-timer.service'
import { closeAllQueues } from './lib/queue'
import { register as metricsRegistry, httpRequestsTotal } from './lib/metrics'
import { registerRuntimeCollectors } from './lib/metrics-collectors.js'
import { genReqId, redactPaths } from './lib/logger.js'
import { enterLogContext } from './lib/log-context.js'
import authRoutes from './routes/auth'
import gameRoutes from './routes/game'
import walletRoutes from './routes/wallet'
import adminRoutes from './routes/admin'
import notificationRoutes from './routes/user/index.js'
import referralRoutes from './routes/referral'
import tournamentRoutes from './routes/tournament'
import settingsRoutes from './routes/settings'
import brandRoutes from './routes/brand'
import supportRoutes from './routes/support'
import promotionsRoutes from './routes/promotions'
import paymentMethodRoutes from './routes/payment-methods/index.js'
import { registerBullBoard } from './routes/bull-board.js'
import aggregatorWalletRoutes from './routes/aggregator/wallet.js'
import { palaceCallbackRoute } from './routes/palace/callback.js'
import zarecashWebhookRoute from './routes/zarecash/webhook.js'
import { deploymentConfig } from './gateways/hub/deployment-config.js'
import { spokeCallbackRoute } from './routes/hub/spoke-callback.js'
import { atlasVCallbackRoutes } from './routes/atlasv/callback.js'
import { atlasVSpokeCallbackRoute } from './routes/hub/atlasv-spoke-callback.js'
import { internalProviderRoute } from './routes/hub/internal-provider.js'
import gameProviderRoutes from './routes/game-provider/index.js'
import eventsRoutes from './routes/events/index.js'
import predictionRoutes from './routes/prediction/index.js'
import adminPredictionRoutes from './routes/admin/prediction/index.js'
import './@types/fastify.d.ts'
import { registerGameHandlers } from './gateways/game.gateway'
import { registerPredictionHandlers } from './gateways/prediction.gateway.js'
import { registerSupportHandlers } from './gateways/support.gateway.js'
import { jwtPrivateKey, jwtPublicKey } from './lib/jwt-keys.js'
import { isZareCashEnabled } from './gateways/payment/zarecash/config.js'
import { verifiedUserRateLimitKey } from './lib/rate-limit-key'
import { mapErrorToResponse } from './lib/error-handler'

// Import workers so they auto-start with the server process
import './workers/game-countdown.worker.js'
import './workers/game-scheduler.worker.js'
import './workers/game-engine.worker.js'
import './workers/game-catalog-sync.worker.js'
import './workers/cashback-checker.worker.js'
import './workers/prune-events.worker.js'
import './workers/deposit-verification.worker.js'
import './workers/player-metrics.worker.js'
import './workers/crm-campaign.worker.js'
import './workers/bonus-expiry.worker.js'
import './workers/account-status-expiry.worker.js'
import './workers/prediction.worker.js'
import './workers/zarecash-deposit.worker.js'
import './workers/zarecash-event.worker.js'
import './workers/zarecash-withdrawal.worker.js'
import './workers/zarecash-sweep.worker.js'
import { scheduleZareCashSweep } from './workers/zarecash-sweep.worker.js'
import { ZareCashService, ZareCashModeMismatchError } from './services/zarecash.service.js'
import { AccountStatusService } from './services/account-status.service.js'
import { AccountStatus } from '@world-bingo/shared-types'

if (!jwtPrivateKey || !jwtPublicKey) {
    console.error('FATAL: JWT keys not set. Provide JWT_PRIVATE_KEY_BASE64/JWT_PUBLIC_KEY_BASE64 or JWT_PRIVATE_KEY/JWT_PUBLIC_KEY')
    process.exit(1)
}

const isProd = process.env.NODE_ENV === 'production'

/**
 * How many reverse-proxy hops sit in front of this service. A security
 * boundary, not a tuning knob — see the `trustProxy` note below.
 *
 * Validated hard, because the failure is silent: `Infinity` or `1e9` would
 * make Fastify trust the entire X-Forwarded-For chain, which is exactly the
 * `trustProxy: true` behaviour this exists to remove — measured at 0 × 429
 * against a rotating spoof. Anything that is not a whole number in range
 * falls back to the default rather than being coerced.
 */
const TRUST_PROXY_HOPS = ((): number => {
    const DEFAULT = 1
    // 4 is well past any realistic topology (Traefik, plus Nitro's
    // server-side /api proxy, plus a CDN, plus one spare).
    const MAX = 4
    const raw = process.env.TRUST_PROXY_HOPS
    if (raw === undefined || raw.trim() === '') return DEFAULT
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1 || n > MAX) return DEFAULT
    return n
})()

const server = Fastify({
    logger: isProd
        ? { redact: { paths: redactPaths, censor: '[redacted]' } }
        : {
            transport: { target: 'pino-pretty' },
            redact: { paths: redactPaths, censor: '[redacted]' },
        },
    // We honor x-request-id ourselves in genReqId, so disable Fastify's built-in
    // header lookup (default 'request-id') to keep one source of truth.
    requestIdHeader: false,
    genReqId,
    disableRequestLogging: false,
    // A COUNT of trusted proxy hops, not `true`. With `true`, Fastify believes
    // the whole X-Forwarded-For chain and `request.ip` becomes its leftmost
    // entry — which the client writes. Traefik appends rather than replaces,
    // so a caller sending `X-Forwarded-For: <anything>` chose their own
    // `request.ip`, and with it their own rate-limit bucket: a fresh value per
    // request defeated the limiter entirely.
    //
    // With a count, Fastify walks the chain from the right, skips exactly that
    // many trusted hops, and takes the next address — a spoofed prefix is
    // ignored however long it is (measured: a 10-entry fake prefix still
    // resolves to the real client).
    //
    // Default 1. Dokploy's Traefik is the only hop that APPENDS to the chain,
    // verified against the live deployment (no Cloudflare `cf-ray`, Traefik's
    // own `alt-svc: h3`). Note the player path is browser → Traefik → Nitro's
    // server-side /api proxy → here, which is two proxies: h3's
    // `getProxyRequestHeaders` forwards X-Forwarded-For unchanged and appends
    // nothing of its own, so the chain still carries exactly one appended hop
    // and 1 is right. If that ever changes — h3 starts appending, or the
    // proxy is swapped for one that does — this must change with it.
    //
    // Setting this too HIGH does NOT fail loudly: it walks `request.ip` LEFT,
    // back into the part of the chain the client wrote, handing every caller
    // its own `request.ip` again (measured at hops=2 against a one-entry
    // spoof: 30 × 200, 0 × 429 — the original hole, restored silently). Raise
    // it only in lockstep with a proxy that genuinely appends a hop.
    trustProxy: TRUST_PROXY_HOPS,
})

// Bind req.log (which carries reqId) for the whole request's async context, so
// module-level code (resolveUser, the Palace gateway, the wallet dispatcher)
// logs with the same correlation id without threading a logger everywhere.
server.addHook('onRequest', (req, _reply, done) => {
    enterLogContext(req.log)
    done()
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
    origin: process.env.CORS_ORIGIN === '*' ? true : (process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:3000', 'http://localhost:3001']),
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
const rateLimitWhitelist = new Set(
    (process.env.RATE_LIMIT_WHITELIST ?? '').split(',').map((s) => s.trim()).filter(Boolean),
)
await server.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    // Keyed on a *verified* bearer-token user id so a shared carrier NAT
    // address doesn't throttle a whole neighbourhood of players onto one
    // 100/min budget. `@fastify/rate-limit` runs this at the `onRequest`
    // hook, strictly before the `authenticate` preHandler/preValidation hook
    // that populates `request.user` — so `request.user` is never available
    // here. We verify the token ourselves instead (never just decode it:
    // an unverified payload lets anyone forge an `id` claim and hand
    // themselves an unlimited budget). Any request with no token, a
    // malformed header, or a token that fails verification (wrong
    // signature, expired — both common and expected) falls back to the IP
    // key exactly as before. This can never throw and so can never fail the
    // request it's rate-limiting.
    keyGenerator: (req) => {
        return verifiedUserRateLimitKey({
            authorizationHeader: req.headers.authorization,
            verify: (token) => server.jwt.verify(token),
            ip: req.ip,
        })
    },
    // Skip rate limiting for GASea wallet callbacks — server-to-server traffic
    // from GASea's IP must never be throttled mid-game-session.
    // Also skip IPs explicitly whitelisted via RATE_LIMIT_WHITELIST env var.
    allowList: (req) => {
        if (req.url.startsWith('/v1/aggregator/')) return true
        if (req.url.startsWith('/v1/palace/')) return true
        if (req.url.startsWith('/v1/atlasv/')) return true
        // `req.ip` (trusted-hop resolved), never the raw header — otherwise a
        // caller could name a whitelisted address and skip the limiter outright.
        const ip = req.ip
        return rateLimitWhitelist.has(ip)
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

// The mapping itself lives in lib/error-handler.ts, extracted so that
// test/auth-refresh-route.test.ts can exercise this exact function through a
// real server.inject request instead of asserting against a copy that could
// silently drift from what production actually sends on the wire.
server.setErrorHandler<FastifyError>(mapErrorToResponse)

// Wire Sentry's Fastify error capture AFTER our custom handler so it observes
// errors without replacing our response mapping. No-op when Sentry is disabled.
Sentry.setupFastifyErrorHandler(server)

server.decorate('authenticate', async function (request: any, reply: any) {
    try {
        await request.jwtVerify()
    } catch (err) {
        return reply.send(err)
    }

    // A JWT proves who you are, not that you are still allowed in. Without this
    // a suspension would only take effect whenever the token happened to
    // expire, which is not a containment window anyone would choose. Status is
    // read through a 30s Redis cache, so this is not a per-request query.
    const status = await AccountStatusService.current(request.user.id)
    if (status === AccountStatus.SUSPENDED) {
        return reply
            .status(401)
            .send({ error: 'This account has been suspended. Please contact support.', code: 'account_suspended' })
    }
})

/**
 * Blocks anything other than ACTIVE. Applied to the routes that move money or
 * enter a game — RESTRICTED accounts pass `authenticate` deliberately, so this
 * is what stops them doing those things.
 */
server.decorate('requireActiveAccount', async function (request: any, reply: any) {
    const status = await AccountStatusService.current(request.user?.id)
    if (status !== AccountStatus.ACTIVE) {
        return reply.status(403).send({
            error: 'Your account is under review. Deposits, withdrawals and games are paused — please contact support.',
            code: 'account_restricted',
        })
    }
})

server.decorate('requireAdmin', async function (request: any, reply: any) {
    try {
        await request.jwtVerify()
    } catch (err) {
        return reply.send(err)
    }
    if (request.user.role !== 'ADMIN' && request.user.role !== 'SUPER_ADMIN') {
        return reply.status(403).send({ error: 'Forbidden: Admin access only' })
    }
})

server.decorate('requireSuperAdmin', async function (request: any, reply: any) {
    try {
        await request.jwtVerify()
    } catch (err) {
        return reply.send(err)
    }
    if (request.user.role !== 'SUPER_ADMIN') {
        return reply.status(403).send({ error: 'Forbidden: Super admin access only' })
    }
})

server.decorate('requireAdminOrClerk', async function (request: any, reply: any) {
    try {
        await request.jwtVerify()
    } catch (err) {
        return reply.send(err)
    }
    const { role } = request.user
    if (role !== 'ADMIN' && role !== 'SUPER_ADMIN' && role !== 'CLERK') {
        return reply.status(403).send({ error: 'Forbidden: Insufficient permissions' })
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
await server.register(brandRoutes, { prefix: '/brand' })
await server.register(supportRoutes, { prefix: '/support' })
await server.register(promotionsRoutes, { prefix: '/promotions' })
await server.register(paymentMethodRoutes, { prefix: '/payment-methods' })
await server.register(aggregatorWalletRoutes, { prefix: '/v1/aggregator/wallet' })
await server.register(palaceCallbackRoute, { prefix: '/v1/palace/callback' })
await server.register(atlasVCallbackRoutes, { prefix: '/v1/atlasv/callback' })
await server.register(zarecashWebhookRoute, { prefix: '/v1/zarecash/webhook' })
if (deploymentConfig().role === 'spoke') {
    await server.register(spokeCallbackRoute, { prefix: '/v1/hub/spoke-callback' })
    await server.register(atlasVSpokeCallbackRoute, { prefix: '/v1/hub/atlasv-spoke-callback' })
}
if (deploymentConfig().role === 'hub') {
    await server.register(internalProviderRoute, { prefix: '/v1/hub/provider' })
}
await server.register(gameProviderRoutes, { prefix: '/providers' })
await server.register(eventsRoutes)
await server.register(predictionRoutes, { prefix: '/prediction' })
await server.register(adminPredictionRoutes, { prefix: '/admin/prediction' })

// T49 — BullMQ Dashboard at /admin/queues
await registerBullBoard(server)

// Serve the uploads directory written by lib/storage.ts (STORAGE_PROVIDER=local).
// Must be registered in prod too — receipts are stored locally there as well.
{
    const uploadsDir = path.resolve(process.cwd(), 'uploads')
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

// Attach async gauge collectors (games_active, wb_bullmq_jobs) sampled per scrape.
registerRuntimeCollectors()

// T52 — Track HTTP request counts. Use the Fastify v5 matched-route TEMPLATE
// (e.g. /games/:id), NOT the concrete URL — the raw URL contains per-game/
// per-user ids and would make this metric's cardinality unbounded. Unmatched
// routes (404s) have no routeOptions.url, so fall back to a constant.
server.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url ?? 'unknown'
    httpRequestsTotal.labels(request.method, route, String(reply.statusCode)).inc()
})

// Graceful shutdown
const shutdown = async (signal: string) => {
    server.log.info(`Received ${signal}. Starting graceful shutdown...`)
    stopAllEngines()
    stopAllRoomCountdowns()
    await closeAllQueues().catch(() => { })
    await shutdownPostHog()
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
    // Without this nothing can join `prediction:<marketId>`, so every book,
    // trade and status broadcast would be emitted into an empty room.
    registerPredictionHandlers(io)
    registerSupportHandlers(io)

    // Refuse to bind the port if we're talking to the wrong ZareCash keyspace —
    // a genuine mode mismatch must abort startup, not degrade into a warning.
    //
    // ONLY that. This block sits inside the try whose catch calls process.exit(1),
    // so anything else escaping here kills the API over a payment provider. Two
    // paths used to do exactly that: a truncated 200 from GET /v1/float (now
    // rejected at the source in client.ts, but still not a mode mismatch), and
    // scheduleZareCashSweep's getQueue().add() when Redis is down at startup.
    // Bingo games have nothing to do with ZareCash's — or Redis's — uptime.
    if (isZareCashEnabled()) {
        try {
            await ZareCashService.assertMode()
            await scheduleZareCashSweep()
        } catch (err) {
            if (err instanceof ZareCashModeMismatchError) throw err
            console.error('[ZareCash] boot setup failed (continuing without it):', (err as Error)?.message)
            reportError(err, { phase: 'zarecash-boot' })
        }
    }

    await server.listen({ port, host })

    // Say the effective value out loud. Over-setting this hands `request.ip`
    // back to the client with no other symptom (see the trustProxy note), so
    // one boot line is the only chance to notice a bad value.
    server.log.info({ trustProxyHops: TRUST_PROXY_HOPS }, '[security] trusted proxy hop count')

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
