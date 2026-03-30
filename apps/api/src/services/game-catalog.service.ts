import prisma from '../lib/prisma.js'
import redis from '../lib/redis.js'
import { getGameProviderGateway } from '../gateways/game-provider/index.js'

const CURRENCY = process.env.GASEA_DEFAULT_CURRENCY ?? 'ETB'
const GAME_CACHE_TTL = 600 // 10 minutes

function gameCacheKey(providerCode: string, category: string, page: number): string {
    return `tp:games:${providerCode}:${category}:${page}`
}

export class GameCatalogService {
    /**
     * Sync all vendors for a provider from the aggregator API into the DB.
     */
    static async syncVendors(providerCode: string): Promise<void> {
        const gateway = getGameProviderGateway(providerCode)
        const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } })
        if (!provider) throw new Error(`Provider not found: ${providerCode}`)

        const vendors = await gateway.getVendors(CURRENCY, 'en')

        for (const v of vendors) {
            await prisma.gameVendor.upsert({
                where: { providerId_code: { providerId: provider.id, code: v.code } },
                update: {
                    name: v.name,
                    categoryCode: v.categoryCodes.join(','),
                    lastSyncedAt: new Date(),
                },
                create: {
                    providerId: provider.id,
                    code: v.code,
                    name: v.name,
                    categoryCode: v.categoryCodes.join(','),
                    lastSyncedAt: new Date(),
                },
            })
        }

        console.log(`[GameCatalog] Synced ${vendors.length} vendors for ${providerCode}`)
    }

    /**
     * Sync all games for a vendor from the aggregator API into the DB.
     */
    static async syncGames(providerCode: string, vendorCode: string): Promise<number> {
        const gateway = getGameProviderGateway(providerCode)
        const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } })
        if (!provider) throw new Error(`Provider not found: ${providerCode}`)

        const vendor = await prisma.gameVendor.findUnique({
            where: { providerId_code: { providerId: provider.id, code: vendorCode } },
        })
        if (!vendor) throw new Error(`Vendor not found: ${vendorCode}`)

        let page = 1
        let total = 0

        while (true) {
            const result = await gateway.getGames(vendorCode, page, 100, CURRENCY, 'en')

            for (const g of result.games) {
                await prisma.providerGame.upsert({
                    where: { providerId_gameCode: { providerId: provider.id, gameCode: g.gameCode } },
                    update: {
                        gameName: g.gameName,
                        categoryCode: g.categoryCode,
                        imageSquare: g.imageSquare,
                        imageLandscape: g.imageLandscape,
                        languageCodes: g.languageCodes,
                        platformCodes: g.platformCodes,
                        currencyCodes: g.currencyCodes,
                    },
                    create: {
                        providerId: provider.id,
                        vendorId: vendor.id,
                        gameCode: g.gameCode,
                        gameName: g.gameName,
                        categoryCode: g.categoryCode,
                        imageSquare: g.imageSquare,
                        imageLandscape: g.imageLandscape,
                        languageCodes: g.languageCodes,
                        platformCodes: g.platformCodes,
                        currencyCodes: g.currencyCodes,
                    },
                })
            }

            total += result.games.length

            if (page >= result.totalPages) break
            page++
        }

        // Invalidate Redis cache for this provider
        const keys = await redis.keys(`tp:games:${providerCode}:*`)
        if (keys.length > 0) await redis.del(...keys)

        console.log(`[GameCatalog] Synced ${total} games for ${providerCode}/${vendorCode}`)
        return total
    }

    /**
     * Full sync: vendors + all games.
     */
    static async syncAll(providerCode: string): Promise<void> {
        await GameCatalogService.syncVendors(providerCode)

        const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } })
        if (!provider) throw new Error(`Provider not found: ${providerCode}`)

        const vendors = await prisma.gameVendor.findMany({
            where: { providerId: provider.id, isActive: true },
        })

        for (const vendor of vendors) {
            await GameCatalogService.syncGames(providerCode, vendor.code).catch((err) => {
                console.error(`[GameCatalog] Failed to sync games for ${providerCode}/${vendor.code}:`, err.message)
            })
        }

        console.log(`[GameCatalog] Full sync complete for ${providerCode}`)
    }

    /**
     * Get paginated games from DB (with Redis cache).
     */
    static async getGames(params: {
        providerCode: string
        category?: string
        page?: number
        pageSize?: number
        search?: string
        vendorCode?: string
    }) {
        const { providerCode, category, page = 1, pageSize = 50, search, vendorCode } = params
        const cacheKey = (search || vendorCode) ? null : gameCacheKey(providerCode, category ?? 'ALL', page)

        if (cacheKey) {
            const cached = await redis.get(cacheKey)
            if (cached) return JSON.parse(cached)
        }

        const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } })
        if (!provider) throw new Error(`Provider not found: ${providerCode}`)

        let vendorId: string | undefined
        if (vendorCode) {
            const v = await prisma.gameVendor.findUnique({
                where: { providerId_code: { providerId: provider.id, code: vendorCode } },
            })
            vendorId = v?.id
        }

        const where: any = {
            providerId: provider.id,
            isActive: true,
            ...(category && category !== 'ALL' ? { categoryCode: category } : {}),
            ...(search ? { gameName: { contains: search, mode: 'insensitive' } } : {}),
            ...(vendorId ? { vendorId } : {}),
        }

        const [games, totalItems] = await Promise.all([
            prisma.providerGame.findMany({
                where,
                orderBy: [{ sortOrder: 'asc' }, { gameName: 'asc' }],
                take: pageSize,
                skip: (page - 1) * pageSize,
                include: { vendor: { select: { code: true, name: true } } },
            }),
            prisma.providerGame.count({ where }),
        ])

        const result = {
            games,
            currentPage: page,
            pageSize,
            totalItems,
            totalPages: Math.ceil(totalItems / pageSize),
        }

        if (cacheKey) {
            await redis.setex(cacheKey, GAME_CACHE_TTL, JSON.stringify(result))
        }

        return result
    }

    /**
     * Get distinct game categories for a provider.
     */
    static async getCategories(providerCode: string): Promise<string[]> {
        const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } })
        if (!provider) return []

        const rows = await prisma.providerGame.findMany({
            where: { providerId: provider.id, isActive: true },
            select: { categoryCode: true },
            distinct: ['categoryCode'],
        })
        return rows.map((r) => r.categoryCode).sort()
    }
}
