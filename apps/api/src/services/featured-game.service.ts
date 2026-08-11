import type { Prisma } from '@prisma/client'
import prisma from '../lib/prisma.js'
import redis from '../lib/redis.js'

export type FeaturedGameInput = { nameKey: string; label: string }

export type FeaturedGameItem = {
    nameKey: string
    label: string
    position: number
    /** How many catalog rows this pin currently resolves to. 0 = not in the catalog. */
    matches: number
}

/**
 * A pin identifies a game by name rather than by provider + game code, so one
 * list covers every provider carrying the same title.
 *
 * The SQL projection in applyRanks() normalizes with
 * `regexp_replace(lower("gameName"), '[^a-z0-9]', '', 'g')` — keep the two in
 * step or pins stop matching.
 */
export function toNameKey(gameName: string): string {
    return (gameName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * The order players see. Curated rank first (unpinned games sort last), then the
 * per-provider sortOrder, then the name — so the ordering happens in the
 * database and survives pagination.
 */
export const PROVIDER_GAME_ORDER_BY: Prisma.ProviderGameOrderByWithRelationInput[] = [
    { featuredRank: { sort: 'asc', nulls: 'last' } },
    { sortOrder: 'asc' },
    { gameName: 'asc' },
]

export class FeaturedGameService {
    /**
     * The curated list in admin order, each pin annotated with how many catalog
     * rows it resolves to right now.
     */
    static async list(): Promise<FeaturedGameItem[]> {
        const [pins, counts] = await Promise.all([
            prisma.featuredGame.findMany({ orderBy: { position: 'asc' } }),
            prisma.$queryRaw<Array<{ nameKey: string; matches: bigint }>>`
                SELECT f."nameKey", COUNT(g.id) AS matches
                FROM featured_games f
                LEFT JOIN provider_games g
                    ON regexp_replace(lower(g."gameName"), '[^a-z0-9]', '', 'g') = f."nameKey"
                GROUP BY f."nameKey"
            `,
        ])

        const matchesByKey = new Map(counts.map((row) => [row.nameKey, Number(row.matches)]))

        return pins.map((pin) => ({
            nameKey: pin.nameKey,
            label: pin.label,
            position: pin.position,
            matches: matchesByKey.get(pin.nameKey) ?? 0,
        }))
    }

    /**
     * Replace the whole list — the array order is the priority order. Whole-list
     * replacement keeps a drag-and-drop save idempotent and removes any reorder
     * race between two admins.
     */
    static async replace(items: FeaturedGameInput[]): Promise<FeaturedGameItem[]> {
        const normalized = FeaturedGameService.normalize(items)

        await prisma.$transaction([
            prisma.featuredGame.deleteMany({}),
            ...normalized.map((item, position) =>
                prisma.featuredGame.create({
                    data: { nameKey: item.nameKey, label: item.label, position },
                }),
            ),
        ])

        await FeaturedGameService.applyRanks()
        await FeaturedGameService.bustCatalogCache()

        return FeaturedGameService.list()
    }

    /**
     * Project the list onto provider_games.featuredRank. Runs on every save and
     * at the end of a catalog sync, so games a sync has just created pick up
     * their rank without an admin touching anything.
     */
    static async applyRanks(): Promise<void> {
        const pins = await prisma.featuredGame.findMany({
            orderBy: { position: 'asc' },
            select: { nameKey: true, position: true },
        })

        const keys = pins.map((pin) => pin.nameKey)
        const ranks = pins.map((pin) => pin.position)

        await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`UPDATE provider_games SET "featuredRank" = NULL WHERE "featuredRank" IS NOT NULL`

            if (keys.length === 0) return

            await tx.$executeRaw`
                UPDATE provider_games g
                SET "featuredRank" = v.rank
                FROM (
                    SELECT unnest(${keys}::text[]) AS key, unnest(${ranks}::int[]) AS rank
                ) v
                WHERE regexp_replace(lower(g."gameName"), '[^a-z0-9]', '', 'g') = v.key
            `
        })
    }

    /**
     * Drop the cached catalog pages so a reorder shows up on the next request
     * instead of waiting out the 10-minute TTL.
     */
    static async bustCatalogCache(): Promise<void> {
        const keys = await redis.keys('tp:games:*')
        if (keys.length > 0) await redis.del(...keys)
    }

    private static normalize(items: FeaturedGameInput[]): FeaturedGameInput[] {
        const seen = new Set<string>()

        return items.map((item) => {
            const nameKey = toNameKey(item.nameKey || item.label)
            if (!nameKey) throw new Error('Game name cannot be empty')
            if (seen.has(nameKey)) throw new Error(`Duplicate game: ${nameKey}`)
            seen.add(nameKey)

            return { nameKey, label: item.label.trim() || nameKey }
        })
    }
}
