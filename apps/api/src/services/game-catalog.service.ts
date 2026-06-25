import prisma from '../lib/prisma.js'
import redis from '../lib/redis.js'
import { getGameProviderGateway } from '../gateways/game-provider/index.js'
import { PatternType } from '@world-bingo/shared-types'

const CURRENCY = process.env.GASEA_DEFAULT_CURRENCY ?? 'ETB'
const GAME_CACHE_TTL = 600 // 10 minutes

const PATTERN_LABELS: Record<PatternType, string> = {
    ANY_LINE: 'Any Line',
    DIAGONAL: 'Diagonal',
    FULL_CARD: 'Full Card',
    X_PATTERN: 'X Pattern',
    CORNERS: 'Four Corners',
}

function gameCacheKey(providerCode: string, category: string, page: number, pageSize: number): string {
    return `tp:games:${providerCode}:${category}:${page}:${pageSize}`
}

type SearchResult = {
    kind: 'provider' | 'bingo'
    id: string
    providerCode: string
    providerName: string
    vendorCode: string | null
    gameCode: string
    gameName: string
    categoryCode: string
    imageSquare: string | null
    imageLandscape: string | null
}

function normalizeQuery(query: string) {
    return query.trim().toLowerCase()
}

function dedupKey(vendorName: string, gameName: string): string {
    const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
    return `${clean(vendorName)}::${clean(gameName)}`
}

function matchesBingoSearch(game: {
    title: string
    ticketPrice: unknown
    status: string
    pattern: string
}, query: string) {
    const q = normalizeQuery(query)
    if (!q) return false

    const patternLabel = PATTERN_LABELS[game.pattern as PatternType]
    return [
        game.title,
        String(game.ticketPrice),
        game.status,
        game.pattern,
        patternLabel,
    ].some((value) => String(value).toLowerCase().includes(q))
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
    static async syncGames(
        providerCode: string,
        vendorCode: string,
    ): Promise<{ total: number; reenabled: number; autoHidden: number }> {
        const gateway = getGameProviderGateway(providerCode)
        const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } })
        if (!provider) throw new Error(`Provider not found: ${providerCode}`)

        const vendor = await prisma.gameVendor.findUnique({
            where: { providerId_code: { providerId: provider.id, code: vendorCode } },
        })
        if (!vendor) throw new Error(`Vendor not found: ${vendorCode}`)

        let page = 1
        let total = 0
        const seenCodes: string[] = []

        while (true) {
            const result = await gateway.getGames(vendorCode, page, 100, CURRENCY, 'en')

            for (const g of result.games) {
                seenCodes.push(g.gameCode)
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

        // Self-heal: re-enable games we auto-hid that the provider is listing again.
        // Bounded by the (small) number of auto-hidden games — never touches games an
        // admin disabled manually (those have autoHidden=false).
        const autoHidden = await prisma.providerGame.findMany({
            where: { providerId: provider.id, autoHidden: true },
            select: { id: true, gameCode: true },
        })
        const seen = new Set(seenCodes)
        const reenableIds = autoHidden.filter((g) => seen.has(g.gameCode)).map((g) => g.id)
        let reenabled = 0
        if (reenableIds.length > 0) {
            await prisma.providerGame.updateMany({
                where: { id: { in: reenableIds } },
                data: { isActive: true, autoHidden: false },
            })
            reenabled = reenableIds.length
            console.log(`[GameCatalog] Re-enabled ${reenabled} previously auto-hidden games for ${providerCode}/${vendorCode}`)
        }

        // Inverse self-heal: auto-hide games we still list as active but the provider
        // no longer returns (delisted / turned off upstream) so a dead tile vanishes
        // without a player having to hit it. Scoped to this vendor; never touches
        // admin-disabled games (autoHidden=false). Guarded on a non-empty sync so a
        // transient empty response can't wipe the whole vendor.
        let autoHiddenCount = 0
        if (seenCodes.length > 0) {
            const delisted = await prisma.providerGame.updateMany({
                where: {
                    providerId: provider.id,
                    vendorId: vendor.id,
                    isActive: true,
                    gameCode: { notIn: seenCodes },
                },
                data: { isActive: false, autoHidden: true },
            })
            autoHiddenCount = delisted.count
            if (autoHiddenCount > 0) {
                console.log(`[GameCatalog] Auto-hid ${autoHiddenCount} delisted games for ${providerCode}/${vendorCode}`)
            }
        }

        // Invalidate Redis cache for this provider (games + categories)
        const keys = await redis.keys(`tp:games:${providerCode}:*`)
        if (keys.length > 0) await redis.del(...keys)
        await redis.del(`tp:categories:${providerCode}`)

        console.log(`[GameCatalog] Synced ${total} games for ${providerCode}/${vendorCode}`)
        return { total, reenabled, autoHidden: autoHiddenCount }
    }

    /**
     * Full sync: vendors + all games.
     */
    static async syncAll(
        providerCode: string,
    ): Promise<{ total: number; reenabled: number; autoHidden: number }> {
        await GameCatalogService.syncVendors(providerCode)

        const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } })
        if (!provider) throw new Error(`Provider not found: ${providerCode}`)

        const vendors = await prisma.gameVendor.findMany({
            where: { providerId: provider.id, isActive: true },
        })

        const summary = { total: 0, reenabled: 0, autoHidden: 0 }
        for (const vendor of vendors) {
            const r = await GameCatalogService.syncGames(providerCode, vendor.code).catch((err) => {
                console.error(`[GameCatalog] Failed to sync games for ${providerCode}/${vendor.code}:`, err.message)
                return null
            })
            if (r) {
                summary.total += r.total
                summary.reenabled += r.reenabled
                summary.autoHidden += r.autoHidden
            }
        }

        console.log(`[GameCatalog] Full sync complete for ${providerCode}`)
        return summary
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
        const cacheKey = (search || vendorCode) ? null : gameCacheKey(providerCode, category ?? 'ALL', page, pageSize)

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
     * Get distinct game categories for a provider (Redis-cached).
     * Stable data — same TTL and bust path as the games cache (tp:games:*).
     */
    static async getCategories(providerCode: string): Promise<string[]> {
        const cacheKey = `tp:categories:${providerCode}`
        const cached = await redis.get(cacheKey)
        if (cached) return JSON.parse(cached)

        const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } })
        if (!provider) return []

        const rows = await prisma.providerGame.findMany({
            where: { providerId: provider.id, isActive: true },
            select: { categoryCode: true },
            distinct: ['categoryCode'],
        })
        const categories = rows.map((r) => r.categoryCode).sort()

        await redis.setex(cacheKey, GAME_CACHE_TTL, JSON.stringify(categories))
        return categories
    }

    /**
     * Active bingo rooms for the lobby, with a live player count.
     * Mirrors GameController.list so the lobby bootstrap can return bingo inline.
     */
    static async getActiveBingoGames() {
        const games = await prisma.game.findMany({
            where: { status: { in: ['WAITING', 'STARTING', 'IN_PROGRESS'] } },
            include: { _count: { select: { entries: true } } },
            orderBy: { createdAt: 'desc' },
        })
        return games.map((g: any) => ({ ...g, currentPlayers: g._count?.entries ?? 0 }))
    }

    /**
     * Lobby bootstrap — everything the landing page needs for first paint in a
     * single round-trip: providers, the active provider's categories + first
     * games page, and active bingo rooms. Dependent reads run server-side where
     * round-trip latency is negligible.
     */
    static async getLobby(opts: { pageSize?: number } = {}) {
        const pageSize = opts.pageSize ?? 60

        const [providers, bingoGames] = await Promise.all([
            prisma.gameProvider.findMany({
                where: { status: 'ACTIVE' },
                select: { code: true, name: true, currency: true },
            }),
            GameCatalogService.getActiveBingoGames(),
        ])

        const activeProviderCode = providers[0]?.code ?? null
        let categories: string[] = []
        let games: any[] = []
        let gamesTotal = 0

        if (activeProviderCode) {
            const [cats, page] = await Promise.all([
                GameCatalogService.getCategories(activeProviderCode),
                GameCatalogService.getGames({ providerCode: activeProviderCode, page: 1, pageSize }),
            ])
            categories = cats
            games = page.games
            gamesTotal = page.totalItems
        }

        return { providers, activeProviderCode, categories, games, gamesTotal, pageSize, bingoGames }
    }

    static async searchCatalog(query: string) {
        const normalized = normalizeQuery(query)
        if (!normalized) {
            return { query: normalized, results: [] as SearchResult[] }
        }

        const providerGames = await prisma.providerGame.findMany({
            where: {
                isActive: true,
                provider: { is: { status: 'ACTIVE' } },
                vendor: { is: { isActive: true } },
                OR: [
                    { gameName: { contains: normalized, mode: 'insensitive' } },
                    { gameCode: { contains: normalized, mode: 'insensitive' } },
                    { categoryCode: { contains: normalized, mode: 'insensitive' } },
                    { provider: { is: { code: { contains: normalized, mode: 'insensitive' } } } },
                    { provider: { is: { name: { contains: normalized, mode: 'insensitive' } } } },
                    { vendor: { is: { code: { contains: normalized, mode: 'insensitive' } } } },
                    { vendor: { is: { name: { contains: normalized, mode: 'insensitive' } } } },
                ],
            },
            orderBy: [
                { provider: { name: 'asc' } },
                { sortOrder: 'asc' },
                { gameName: 'asc' },
            ],
            select: {
                id: true,
                gameCode: true,
                gameName: true,
                categoryCode: true,
                imageSquare: true,
                imageLandscape: true,
                provider: { select: { code: true, name: true, isPrimary: true } },
                vendor: { select: { code: true, name: true } },
            },
        })

        // Dedup: when multiple providers serve the same game (same vendor+game name),
        // show only the primary provider's version. Primary providers sort first.
        const sortedForDedup = [...providerGames].sort((a, b) => {
            if (a.provider.isPrimary && !b.provider.isPrimary) return -1
            if (!a.provider.isPrimary && b.provider.isPrimary) return 1
            return 0
        })
        const seenDedupKeys = new Map<string, true>()
        const dedupedGames = sortedForDedup.filter((game) => {
            if (!game.vendor?.name) return true // no vendor info → always include
            const key = dedupKey(game.vendor.name, game.gameName)
            if (seenDedupKeys.has(key)) return false
            seenDedupKeys.set(key, true)
            return true
        })

        const bingoGames = await prisma.game.findMany({
            where: {
                status: {
                    in: ['WAITING', 'STARTING', 'LOCKING', 'IN_PROGRESS'],
                },
            },
            select: {
                id: true,
                title: true,
                ticketPrice: true,
                status: true,
                pattern: true,
            },
            orderBy: { createdAt: 'desc' },
        })

        const results: SearchResult[] = dedupedGames.map((game) => ({
            kind: 'provider',
            id: game.id,
            providerCode: game.provider.code,
            providerName: game.provider.name,
            vendorCode: game.vendor?.code ?? null,
            gameCode: game.gameCode,
            gameName: game.gameName,
            categoryCode: game.categoryCode,
            imageSquare: game.imageSquare,
            imageLandscape: game.imageLandscape,
        }))

        const bingoMatch = bingoGames.find((game) => matchesBingoSearch(game, normalized))
        if (bingoMatch) {
            results.unshift({
                kind: 'bingo',
                id: bingoMatch.id,
                providerCode: 'world-bingo',
                providerName: 'World Bingo',
                vendorCode: null,
                gameCode: 'bingo',
                gameName: 'Bingo',
                categoryCode: 'BINGO',
                imageSquare: null,
                imageLandscape: null,
            })
        }

        return {
            query: normalized,
            results,
        }
    }
}
