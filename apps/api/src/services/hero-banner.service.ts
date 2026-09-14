import type { HeroBanner, Prisma } from '@prisma/client'
import type { HeroBannerDto, PublicHeroBannerDto } from '@world-bingo/shared-types'
import prisma from '../lib/prisma.js'

export class HeroBannerNotFoundError extends Error {
    constructor() {
        super('Banner not found')
        this.name = 'HeroBannerNotFoundError'
    }
}

export class HeroBannerOrderError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'HeroBannerOrderError'
    }
}

export type HeroBannerCreateInput = {
    desktopImageUrl: string
    mobileImageUrl: string
    altText: string
    linkUrl: string | null
}

export type HeroBannerPatch = {
    altText?: string
    linkUrl?: string | null
    isActive?: boolean
}

const DISPLAY_ORDER: Prisma.HeroBannerOrderByWithRelationInput[] = [{ position: 'asc' }, { createdAt: 'asc' }]

function toDto(row: HeroBanner): HeroBannerDto {
    return {
        id: row.id,
        desktopImageUrl: row.desktopImageUrl,
        mobileImageUrl: row.mobileImageUrl,
        altText: row.altText,
        linkUrl: row.linkUrl,
        isActive: row.isActive,
        position: row.position,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    }
}

function toPublicDto(row: HeroBanner): PublicHeroBannerDto {
    return {
        id: row.id,
        desktopImageUrl: row.desktopImageUrl,
        mobileImageUrl: row.mobileImageUrl,
        altText: row.altText,
        linkUrl: row.linkUrl,
    }
}

// Create, reorder and delete all derive positions from the current rows, so two
// admins acting at once could otherwise leave duplicates or gaps.
async function lockPositions(tx: Prisma.TransactionClient) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hero_banners'))`
}

async function writePositions(
    tx: Prisma.TransactionClient,
    current: Array<{ id: string; position: number }>,
    orderedIds: string[],
) {
    const positionById = new Map(current.map((row) => [row.id, row.position]))
    for (const [position, id] of orderedIds.entries()) {
        if (positionById.get(id) !== position) {
            await tx.heroBanner.update({ where: { id }, data: { position } })
        }
    }
}

export class HeroBannerService {
    /** What the lobby renders: active banners in display order. */
    static async listActive(): Promise<PublicHeroBannerDto[]> {
        const rows = await prisma.heroBanner.findMany({ where: { isActive: true }, orderBy: DISPLAY_ORDER })
        return rows.map(toPublicDto)
    }

    static async listAll(): Promise<HeroBannerDto[]> {
        const rows = await prisma.heroBanner.findMany({ orderBy: DISPLAY_ORDER })
        return rows.map(toDto)
    }

    /** New banners are active and go last. */
    static async create(input: HeroBannerCreateInput): Promise<HeroBannerDto> {
        const row = await prisma.$transaction(async (tx) => {
            await lockPositions(tx)
            const { _max } = await tx.heroBanner.aggregate({ _max: { position: true } })
            return tx.heroBanner.create({
                data: {
                    desktopImageUrl: input.desktopImageUrl,
                    mobileImageUrl: input.mobileImageUrl,
                    altText: input.altText,
                    linkUrl: input.linkUrl,
                    position: (_max.position ?? -1) + 1,
                    isActive: true,
                },
            })
        })
        return toDto(row)
    }

    static async update(id: string, patch: HeroBannerPatch): Promise<HeroBannerDto> {
        const data: Prisma.HeroBannerUpdateInput = {}
        if (patch.altText !== undefined) data.altText = patch.altText
        if (patch.linkUrl !== undefined) data.linkUrl = patch.linkUrl
        if (patch.isActive !== undefined) data.isActive = patch.isActive
        // Check first so a stale id is a quiet 404 rather than a logged Prisma error.
        const exists = await prisma.heroBanner.findUnique({ where: { id }, select: { id: true } })
        if (!exists) throw new HeroBannerNotFoundError()
        try {
            return toDto(await prisma.heroBanner.update({ where: { id }, data }))
        } catch (err: any) {
            if (err?.code === 'P2025') throw new HeroBannerNotFoundError()
            throw err
        }
    }

    /**
     * Replace the whole order. `ids` must name every banner exactly once, so a
     * stale admin tab cannot silently drop a banner someone else just added.
     */
    static async reorder(ids: string[]): Promise<HeroBannerDto[]> {
        const rows = await prisma.$transaction(async (tx) => {
            await lockPositions(tx)
            const current = await tx.heroBanner.findMany({ select: { id: true, position: true } })
            const known = new Set(current.map((row) => row.id))

            if (new Set(ids).size !== ids.length) {
                throw new HeroBannerOrderError('The order lists a banner more than once')
            }
            if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
                throw new HeroBannerOrderError('The order must include every banner exactly once. Reload and try again.')
            }

            await writePositions(tx, current, ids)
            return tx.heroBanner.findMany({ orderBy: DISPLAY_ORDER })
        })
        return rows.map(toDto)
    }

    /** Removes the row and closes the gap. Stored image files are left in place. */
    static async remove(id: string): Promise<void> {
        await prisma.$transaction(async (tx) => {
            await lockPositions(tx)
            const { count } = await tx.heroBanner.deleteMany({ where: { id } })
            if (count === 0) throw new HeroBannerNotFoundError()

            const remaining = await tx.heroBanner.findMany({
                orderBy: DISPLAY_ORDER,
                select: { id: true, position: true },
            })
            await writePositions(
                tx,
                remaining,
                remaining.map((row) => row.id),
            )
        })
    }
}
