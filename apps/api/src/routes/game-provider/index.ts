import type { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import redis from '../../lib/redis.js'
import prisma from '../../lib/prisma.js'
import { GameCatalogService } from '../../services/game-catalog.service.js'
import { getGameProviderGateway } from '../../gateways/game-provider/index.js'
import { EventService } from '../../services/event.service.js'

const TOKEN_TTL = 4 * 60 * 60 // 4-hour session token cache

/**
 * Player-facing provider/game routes.
 * All mounted under /providers (configured in index.ts).
 * Listing endpoints (providers, games, categories) are public.
 * Launch and terminate require JWT authentication.
 */
const gameProviderRoutes: FastifyPluginAsync = async (fastify) => {
    // ── List active providers ──────────────────────────────────────────────────
    fastify.get('/', {
        handler: async () => {
            return prisma.gameProvider.findMany({
                where: { status: 'ACTIVE' },
                select: { code: true, name: true, currency: true },
            })
        },
    })

    // ── Search the full catalog across all providers ─────────────────────────
    fastify.get('/search', {
        handler: async (req) => {
            const { q = '' } = req.query as { q?: string }
            return GameCatalogService.searchCatalog(q)
        },
    })

    // ── List vendors for a provider ────────────────────────────────────────────
    fastify.get('/:providerCode/vendors', {
        preValidation: [fastify.authenticate],
        handler: async (req, reply) => {
            const { providerCode } = req.params as { providerCode: string }
            const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } })
            if (!provider) return reply.status(404).send({ error: 'Provider not found' })
            return prisma.gameVendor.findMany({
                where: { providerId: provider.id, isActive: true },
                select: { code: true, name: true, categoryCode: true },
                orderBy: { name: 'asc' },
            })
        },
    })

    // ── List games for a provider (paginated, filterable) ─────────────────────
    fastify.get('/:providerCode/games', {
        handler: async (req) => {
            const { providerCode } = req.params as { providerCode: string }
            const { category, page = '1', pageSize = '50', search, vendorCode } =
                req.query as {
                    category?: string
                    page?: string
                    pageSize?: string
                    search?: string
                    vendorCode?: string
                }

            const pg = Math.max(1, parseInt(page, 10))
            const ps = Math.min(200, Math.max(1, parseInt(pageSize, 10)))

            return GameCatalogService.getGames({
                providerCode,
                category,
                page: pg,
                pageSize: ps,
                search,
                vendorCode,
            })
        },
    })

    // ── Get game categories for a provider ────────────────────────────────────
    fastify.get('/:providerCode/categories', {
        handler: async (req) => {
            const { providerCode } = req.params as { providerCode: string }
            return GameCatalogService.getCategories(providerCode)
        },
    })

    // ── Launch a game ──────────────────────────────────────────────────────────
    // Returns a game URL the frontend opens in an iframe.
    fastify.post('/:providerCode/games/:gameCode/launch', {
        preValidation: [fastify.authenticate],
        handler: async (req, reply) => {
            const { providerCode, gameCode } = req.params as {
                providerCode: string
                gameCode: string
            }
            const user = (req as any).user as { id: string; username: string }
            const { language = 'en', platform = 'WEB' } =
                req.body as { language?: string; platform?: 'WEB' | 'H5' }

            const ipAddress =
                (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip

            const gateway = getGameProviderGateway(providerCode)
            const rawBase = process.env.WEB_BASE_URL || 'https://www.aradabingo.bet'
            const lobbyUrl = rawBase.startsWith('http') ? rawBase.replace(/\/$/, '') + '/' : `https://${rawBase.replace(/\/$/, '')}/`

            // GASea requires 3–40 alphanumeric username. Derive a stable identifier
            // from the user's UUID by stripping dashes (32 hex chars, always valid).
            const gaseaUsername = user.id.replace(/-/g, '')

            let gameUrl: string
            let token: string
            try {
                const launched = await gateway.getGameUrl({
                    username: gaseaUsername,
                    gameCode,
                    language,
                    platform,
                    currency: process.env.GASEA_DEFAULT_CURRENCY ?? 'ETB',
                    lobbyUrl,
                    ipAddress,
                })
                gameUrl = launched.gameUrl
                token = launched.token
            } catch (err: any) {
                const msg: string = err?.message ?? ''

                // Provider reports the game is turned off on their side (e.g. GASea
                // SC_GAME_DISABLED). Hide the dead tile from our catalog so other
                // players stop hitting it, then return a friendly 409 instead of a 500.
                if (/disabled/i.test(msg)) {
                    await prisma.providerGame
                        .updateMany({
                            where: { provider: { code: providerCode }, gameCode },
                            data: { isActive: false, autoHidden: true },
                        })
                        .catch(() => {})
                    const keys = await redis.keys(`tp:games:${providerCode}:*`)
                    if (keys.length > 0) await redis.del(...keys)

                    req.log.warn(
                        { providerCode, gameCode, userId: user.id, err: msg },
                        'game disabled upstream — hidden from catalog',
                    )
                    return reply.status(409).send({
                        statusCode: 409,
                        error: 'GameUnavailable',
                        message: 'This game is currently unavailable. Please try another.',
                    })
                }

                req.log.error(
                    { providerCode, gameCode, userId: user.id, err: msg },
                    'provider launch failed',
                )
                throw err
            }

            // Surface bad/empty/non-https URLs that pass as HTTP 200 but won't load client-side.
            if (!gameUrl || !/^https:\/\//i.test(gameUrl)) {
                req.log.error(
                    { providerCode, gameCode, userId: user.id, gameUrl },
                    'provider returned an unusable game url',
                )
            } else {
                req.log.info({ providerCode, gameCode, userId: user.id, gameUrl }, 'provider launch ok')
            }

            // Store token → userId mapping in Redis for callback validation
            if (token) {
                await redis.setex(`tp:token:${token}`, TOKEN_TTL, user.id)
            }

            // Fire analytics event non-blocking — never fail the launch
            Promise.all([
                prisma.wallet.findUnique({ where: { userId: user.id }, select: { realBalance: true } }),
            ]).then(([wallet]) => {
                EventService.record([{
                    name: 'provider_game_launched',
                    props: {
                        providerCode,
                        gameCode,
                        balanceBefore: wallet ? Number(wallet.realBalance) : null,
                    },
                }], { userId: user.id }).catch(() => {})
            }).catch(() => {})

            return { gameUrl, token }
        },
    })

    // ── Terminate a player's game session ─────────────────────────────────────
    fastify.post('/:providerCode/terminate', {
        preValidation: [fastify.authenticate],
        handler: async (req) => {
            const { providerCode } = req.params as { providerCode: string }
            const user = (req as any).user as { username: string }
            const gateway = getGameProviderGateway(providerCode)
            await gateway.terminateSession(user.username)
            return { success: true }
        },
    })
}

export default gameProviderRoutes
