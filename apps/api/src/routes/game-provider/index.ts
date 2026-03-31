import type { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import redis from '../../lib/redis.js'
import prisma from '../../lib/prisma.js'
import { GameCatalogService } from '../../services/game-catalog.service.js'
import { getGameProviderGateway } from '../../gateways/game-provider/index.js'

const TOKEN_TTL = 4 * 60 * 60 // 4-hour session token cache

/**
 * Player-facing provider/game routes.
 * All mounted under /providers (configured in index.ts).
 * All require JWT authentication.
 */
const gameProviderRoutes: FastifyPluginAsync = async (fastify) => {
    // ── List active providers ──────────────────────────────────────────────────
    fastify.get('/', {
        preValidation: [fastify.authenticate],
        handler: async () => {
            return prisma.gameProvider.findMany({
                where: { status: 'ACTIVE' },
                select: { code: true, name: true, currency: true },
            })
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
        preValidation: [fastify.authenticate],
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
        preValidation: [fastify.authenticate],
        handler: async (req) => {
            const { providerCode } = req.params as { providerCode: string }
            return GameCatalogService.getCategories(providerCode)
        },
    })

    // ── Launch a game ──────────────────────────────────────────────────────────
    // Returns a game URL the frontend opens in an iframe.
    fastify.post('/:providerCode/games/:gameCode/launch', {
        preValidation: [fastify.authenticate],
        handler: async (req) => {
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
            const lobbyUrl = `${process.env.WEB_BASE_URL ?? 'https://www.aradabingo.bet'}/`

            const { gameUrl, token } = await gateway.getGameUrl({
                username: user.username,
                gameCode,
                language,
                platform,
                currency: process.env.GASEA_DEFAULT_CURRENCY ?? 'ETB',
                lobbyUrl,
                ipAddress,
            })

            // Store token → userId mapping in Redis for callback validation
            if (token) {
                await redis.setex(`tp:token:${token}`, TOKEN_TTL, user.id)
            }

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
