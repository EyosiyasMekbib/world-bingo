import type { PromoArtwork, Prisma } from '@prisma/client'
import type { PromoArtworkDto, PromoKind } from '@world-bingo/shared-types'
import prisma from '../lib/prisma.js'

export class PromoArtworkNotFoundError extends Error {
    constructor() {
        super('Artwork not found')
        this.name = 'PromoArtworkNotFoundError'
    }
}

/**
 * Which promotion a row belongs to. Unlike a hero banner there is no id to hand
 * back to the client: the promotion already has one, so the artwork is addressed
 * by what it decorates and a second upload replaces the first.
 */
export type PromoArtworkKey = {
    kind: PromoKind
    refId: string
}

export type PromoArtworkUpsertInput = {
    imageUrl: string
    altText: string
    /** Undefined leaves an existing row's position alone; a new row gets none. */
    position?: number
}

export type PromoArtworkPatch = {
    altText?: string
    position?: number
}

// Postgres sorts NULLs last on an ascending sort, which is what we want: art
// the admin never explicitly ordered trails the art they did.
const DISPLAY_ORDER: Prisma.PromoArtworkOrderByWithRelationInput[] = [{ position: 'asc' }, { createdAt: 'asc' }]

function toDto(row: PromoArtwork): PromoArtworkDto {
    return {
        kind: row.kind as PromoKind,
        refId: row.refId,
        imageUrl: row.imageUrl,
        altText: row.altText,
        position: row.position,
    }
}

/** The `@@unique([kind, refId])` selector, spelled once. */
function whereKey(key: PromoArtworkKey) {
    return { kind_refId: { kind: key.kind, refId: key.refId } }
}

export class PromoArtworkService {
    static async listAll(): Promise<PromoArtworkDto[]> {
        const rows = await prisma.promoArtwork.findMany({ orderBy: DISPLAY_ORDER })
        return rows.map(toDto)
    }

    /**
     * Stores the image for one promotion, replacing whatever was there. The
     * unique key does the work, so two admins uploading at once end with one of
     * the two images rather than a duplicate row.
     */
    static async upsert(key: PromoArtworkKey, input: PromoArtworkUpsertInput): Promise<PromoArtworkDto> {
        const row = await prisma.promoArtwork.upsert({
            where: whereKey(key),
            create: {
                kind: key.kind,
                refId: key.refId,
                imageUrl: input.imageUrl,
                altText: input.altText,
                position: input.position ?? null,
            },
            update: {
                imageUrl: input.imageUrl,
                altText: input.altText,
                ...(input.position === undefined ? {} : { position: input.position }),
            },
        })
        return toDto(row)
    }

    /** Text and ordering only — a new image has to come through `upsert`. */
    static async update(key: PromoArtworkKey, patch: PromoArtworkPatch): Promise<PromoArtworkDto> {
        const data: Prisma.PromoArtworkUpdateInput = {}
        if (patch.altText !== undefined) data.altText = patch.altText
        if (patch.position !== undefined) data.position = patch.position
        // Check first so a stale key is a quiet 404 rather than a logged Prisma error.
        const exists = await prisma.promoArtwork.findUnique({ where: whereKey(key), select: { id: true } })
        if (!exists) throw new PromoArtworkNotFoundError()
        try {
            return toDto(await prisma.promoArtwork.update({ where: whereKey(key), data }))
        } catch (err: any) {
            if (err?.code === 'P2025') throw new PromoArtworkNotFoundError()
            throw err
        }
    }

    /**
     * Drops the row, which is how an admin reverts to the generated card — the
     * tile draws its own artwork whenever there is none stored. Stored image
     * files are left in place.
     */
    static async remove(key: PromoArtworkKey): Promise<void> {
        const { count } = await prisma.promoArtwork.deleteMany({ where: { kind: key.kind, refId: key.refId } })
        if (count === 0) throw new PromoArtworkNotFoundError()
    }
}
