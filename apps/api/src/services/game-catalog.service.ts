import prisma from '../lib/prisma.js'
import redis from '../lib/redis.js'
import { getGameProviderGateway } from '../gateways/game-provider/index.js'
import { FeaturedGameService, PROVIDER_GAME_ORDER_BY, PROVIDER_ORDER_BY, toNameKey } from './featured-game.service.js'
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

        // Games this sync just created have no curated rank yet — re-project the
        // admin's list so a newly listed title lands in its pinned position.
        await FeaturedGameService.applyRanks()

        // New, re-enabled or delisted games change which provider's copy of a
        // title wins the lobby — recompute before the cache is dropped.
        await GameCatalogService.applyShadowing()

        // Invalidate Redis cache for this provider (games + categories). The
        // merged all-providers feed is keyed separately and changes too.
        await GameCatalogService.bustProviderCache(providerCode)

        console.log(`[GameCatalog] Synced ${total} games for ${providerCode}/${vendorCode}`)
        return { total, reenabled, autoHidden: autoHiddenCount }
    }

    /**
     * Full sync: vendors + all games.
     */
    static async syncAll(
        providerCode: string,
    ): Promise<{ total: number; reenabled: number; autoHidden: number }> {
        const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } })
        if (!provider) throw new Error(`Provider not found: ${providerCode}`)

        // Some providers (Atlas-V) have no vendor/game-listing API — their
        // catalog is maintained by hand in the seed script. Skip cleanly
        // instead of letting the 6-hourly sync worker log a "not supported"
        // error forever.
        if ((provider.config as { catalogSync?: boolean } | null)?.catalogSync === false) {
            console.log(`[GameCatalog] Skipping ${providerCode} — static catalog, no listing API`)
            return { total: 0, reenabled: 0, autoHidden: 0 }
        }

        await GameCatalogService.syncVendors(providerCode)

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
     * Project cross-provider duplicates onto provider_games.shadowed.
     *
     * Among the ACTIVE games of ACTIVE providers (with an active vendor), rows
     * are grouped by normalized vendor + game name, where "vendor" is the
     * vendor's dedupAlias when set and its name otherwise (providers name the
     * same studio differently, e.g. "Atlas-V" vs "ATLAS V2"). One row per group wins: the
     * provider with the lowest priority number, then the primary provider,
     * then the oldest provider. Every other row in the group is shadowed and
     * the all-providers lobby feed, categories and search leave it out.
     *
     * Rows that fall outside the ranking (inactive game / provider / vendor)
     * are un-shadowed, so a copy surfaces again the moment it qualifies — e.g.
     * when the winning provider is disabled. Runs at the end of every catalog
     * sync and after every provider / vendor / game status or priority change.
     */
    static async applyShadowing(): Promise<void> {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`
                WITH ranked AS (
                    SELECT g.id,
                           ROW_NUMBER() OVER (
                               PARTITION BY COALESCE(
                                                NULLIF(regexp_replace(lower(v."dedupAlias"), '[^a-z0-9]', '', 'g'), ''),
                                                regexp_replace(lower(v.name), '[^a-z0-9]', '', 'g')
                                            ),
                                            regexp_replace(lower(g."gameName"), '[^a-z0-9]', '', 'g')
                               ORDER BY p.priority ASC, p."isPrimary" DESC, p."createdAt" ASC, g.id ASC
                           ) AS rn
                    FROM provider_games g
                    JOIN game_providers p ON p.id = g."providerId"
                    JOIN game_vendors v ON v.id = g."vendorId"
                    WHERE g."isActive" = true AND p.status = 'ACTIVE' AND v."isActive" = true
                )
                UPDATE provider_games g
                SET "shadowed" = (r.rn > 1)
                FROM ranked r
                WHERE r.id = g.id AND g."shadowed" IS DISTINCT FROM (r.rn > 1)
            `
            await tx.$executeRaw`
                UPDATE provider_games g
                SET "shadowed" = false
                FROM game_providers p, game_vendors v
                WHERE p.id = g."providerId" AND v.id = g."vendorId"
                  AND g."shadowed" = true
                  AND (g."isActive" = false OR p.status <> 'ACTIVE' OR v."isActive" = false)
            `
        })
    }

    /**
     * Drop the cached games + categories pages for one provider AND the merged
     * all-providers feed (keyed `__all__`), which changes whenever any single
     * provider's catalog does.
     */
    static async bustProviderCache(providerCode: string): Promise<void> {
        const keys = await redis.keys(`tp:games:${providerCode}:*`)
        if (keys.length > 0) await redis.del(...keys)
        await redis.del(`tp:categories:${providerCode}`)
        await GameCatalogService.bustAllProvidersCache()
    }

    /** Drop only the merged all-providers feed + categories. */
    static async bustAllProvidersCache(): Promise<void> {
        const keys = await redis.keys('tp:games:__all__:*')
        if (keys.length > 0) await redis.del(...keys)
        await redis.del('tp:categories:__all__')
    }

    /**
     * Get paginated games from DB (with Redis cache). Omitting providerCode
     * queries across every ACTIVE provider — this is what the lobby's "ALL
     * games" feed actually wants (a curated pin should be able to outrank
     * another provider's game, not just games within its own provider), and
     * what /providers/games (no provider segment) exposes it as. The
     * provider-scoped /providers/:code/games route is unaffected.
     */
    static async getGames(params: {
        providerCode?: string
        category?: string
        page?: number
        pageSize?: number
        search?: string
        vendorCode?: string
    }) {
        const { providerCode, category, page = 1, pageSize = 50, search, vendorCode } = params
        const cacheKey = (search || vendorCode) ? null : gameCacheKey(providerCode ?? '__all__', category ?? 'ALL', page, pageSize)

        if (cacheKey) {
            const cached = await redis.get(cacheKey)
            if (cached) return JSON.parse(cached)
        }

        let providerId: string | undefined
        if (providerCode) {
            const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } })
            if (!provider) throw new Error(`Provider not found: ${providerCode}`)
            providerId = provider.id
        }

        let vendorId: string | undefined
        if (vendorCode && providerId) {
            const v = await prisma.gameVendor.findUnique({
                where: { providerId_code: { providerId, code: vendorCode } },
            })
            vendorId = v?.id
        }

        // Provider-scoped browsing shows that provider's whole catalog; only the
        // merged feed hides the copies a higher-priority provider shadows.
        const where: any = {
            isActive: true,
            ...(providerId ? { providerId } : { shadowed: false, provider: { is: { status: 'ACTIVE' } } }),
            ...(category && category !== 'ALL' ? { categoryCode: category } : {}),
            ...(search ? { gameName: { contains: search, mode: 'insensitive' } } : {}),
            ...(vendorId ? { vendorId } : {}),
        }

        const [rows, totalItems] = await Promise.all([
            prisma.providerGame.findMany({
                where,
                orderBy: PROVIDER_GAME_ORDER_BY,
                take: pageSize,
                skip: (page - 1) * pageSize,
                include: {
                    vendor: { select: { code: true, name: true } },
                    provider: { select: { code: true, name: true } },
                },
            }),
            prisma.providerGame.count({ where }),
        ])

        // Flatten vendor/provider onto each row — matches searchCatalog()'s
        // SearchResult shape and what the frontend's ProviderGame type expects.
        const games = rows.map((g: any) => ({
            ...g,
            vendorCode: g.vendor?.code ?? null,
            vendorName: g.vendor?.name ?? null,
            providerCode: g.provider?.code ?? null,
            providerName: g.provider?.name ?? null,
        }))

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
     * Get distinct game categories for a provider, or across every ACTIVE
     * provider when providerCode is omitted (Redis-cached either way). Same
     * TTL and bust path as the games cache (tp:games:* and tp:categories:*).
     */
    static async getCategories(providerCode?: string): Promise<string[]> {
        const cacheKey = `tp:categories:${providerCode ?? '__all__'}`
        const cached = await redis.get(cacheKey)
        if (cached) return JSON.parse(cached)

        const where: any = { isActive: true }
        if (providerCode) {
            const provider = await prisma.gameProvider.findUnique({ where: { code: providerCode } })
            if (!provider) return []
            where.providerId = provider.id
        } else {
            where.shadowed = false
            where.provider = { is: { status: 'ACTIVE' } }
        }

        const rows = await prisma.providerGame.findMany({
            where,
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
     * single round-trip: providers, categories + first games page merged
     * across every ACTIVE provider (so a curated pin can outrank a game from
     * a different provider — see getGames()), and active bingo rooms.
     * activeProviderCode is kept for callers that still want a single
     * default provider (e.g. /games' own provider switcher); it no longer
     * scopes games/categories here.
     */
    static async getLobby(opts: { pageSize?: number } = {}) {
        const pageSize = opts.pageSize ?? 60

        const [providers, bingoGames, categories, page] = await Promise.all([
            prisma.gameProvider.findMany({
                where: { status: 'ACTIVE' },
                orderBy: PROVIDER_ORDER_BY,
                select: { code: true, name: true, currency: true },
            }),
            GameCatalogService.getActiveBingoGames(),
            GameCatalogService.getCategories(),
            GameCatalogService.getGames({ page: 1, pageSize }),
        ])

        return {
            providers,
            activeProviderCode: providers[0]?.code ?? null,
            categories,
            games: page.games,
            gamesTotal: page.totalItems,
            pageSize,
            bingoGames,
        }
    }

    /**
     * The one catalog row a named entry point (the Aviator nav tab) launches.
     *
     * Game codes are provider-specific, so the lookup is by normalized name —
     * the same key featured pins use (toNameKey / featured_games.nameKey). Only
     * rows the lobby would show qualify (active game, ACTIVE provider, active
     * vendor, not shadowed), and among those the admin's provider priority
     * decides, so this launches the same copy the lobby tile does.
     * null when no ACTIVE provider carries the title right now.
     */
    static async findGameByName(nameKey: string): Promise<{
        providerCode: string
        providerName: string
        vendorCode: string | null
        gameCode: string
        gameName: string
        categoryCode: string
        imageSquare: string | null
        imageLandscape: string | null
    } | null> {
        const key = toNameKey(nameKey)
        if (!key) return null

        const rows = await prisma.$queryRaw<Array<{
            providerCode: string
            providerName: string
            vendorCode: string | null
            gameCode: string
            gameName: string
            categoryCode: string
            imageSquare: string | null
            imageLandscape: string | null
        }>>`
            SELECT p.code            AS "providerCode",
                   p.name            AS "providerName",
                   v.code            AS "vendorCode",
                   g."gameCode",
                   g."gameName",
                   g."categoryCode",
                   g."imageSquare",
                   g."imageLandscape"
            FROM provider_games g
            JOIN game_providers p ON p.id = g."providerId"
            JOIN game_vendors v ON v.id = g."vendorId"
            WHERE g."isActive" = true
              AND g."shadowed" = false
              AND p.status = 'ACTIVE'
              AND v."isActive" = true
              AND regexp_replace(lower(g."gameName"), '[^a-z0-9]', '', 'g') = ${key}
            ORDER BY p.priority ASC, p."isPrimary" DESC, p."createdAt" ASC, g."sortOrder" ASC, g.id ASC
            LIMIT 1
        `
        return rows[0] ?? null
    }

    static async searchCatalog(query: string) {
        const normalized = normalizeQuery(query)
        if (!normalized) {
            return { query: normalized, results: [] as SearchResult[] }
        }

        // Cross-provider duplicates are resolved by applyShadowing(): only the
        // highest-priority provider's copy of a title is unshadowed, so search
        // and the lobby feed agree on which one shows.
        const providerGames = await prisma.providerGame.findMany({
            where: {
                isActive: true,
                shadowed: false,
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
            orderBy: [{ provider: { name: 'asc' } }, ...PROVIDER_GAME_ORDER_BY],
            select: {
                id: true,
                gameCode: true,
                gameName: true,
                categoryCode: true,
                imageSquare: true,
                imageLandscape: true,
                provider: { select: { code: true, name: true } },
                vendor: { select: { code: true, name: true } },
            },
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

        const results: SearchResult[] = providerGames.map((game) => ({
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
