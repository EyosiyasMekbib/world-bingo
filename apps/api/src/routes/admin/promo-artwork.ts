import { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { Multipart } from '@fastify/multipart'
import { imageSize } from 'image-size'
import { z, type ZodError } from 'zod'
import {
    PROMO_CARD_SPEC,
    PromoArtworkFieldsSchema,
    PromoKind,
    promoCardImageProblem,
} from '@world-bingo/shared-types'
import { uploadFile } from '../../lib/storage'
import {
    PromoArtworkNotFoundError,
    PromoArtworkService,
    type PromoArtworkPatch,
} from '../../services/promo-artwork.service'

/**
 * Artwork for the promo tiles under the lobby hero. Mounted inside the admin
 * plugin's requireAdmin scope, so it inherits that auth hook.
 *
 * One image per promotion, addressed by (kind, refId) rather than by an id of
 * its own: the promotion is the thing being decorated, so a second upload for
 * the same promotion replaces the first instead of stacking up.
 */

const TEXT_FIELDS = ['altText', 'position']
const FILE_FIELD = 'image'
const MAX_MB = PROMO_CARD_SPEC.maxFileBytes / (1024 * 1024)
const UNREADABLE = 'The image is not a readable JPEG, PNG or WebP file'

// Keyed by the format image-size detects in the bytes. The stored extension and
// content type come from here, never from the client's filename or mimetype:
// uploadFile takes the extension from the filename, and /uploads serves by
// extension, so `x.html` sent as image/png would otherwise be served as HTML.
const SNIFFED_FORMATS: Record<string, { mimetype: string; ext: string }> = {
    jpg: { mimetype: 'image/jpeg', ext: '.jpg' },
    png: { mimetype: 'image/png', ext: '.png' },
    webp: { mimetype: 'image/webp', ext: '.webp' },
}

const MULTIPART_ERRORS: Record<string, string> = {
    FST_INVALID_MULTIPART_CONTENT_TYPE: 'Expected a multipart/form-data upload',
    FST_REQ_FILE_TOO_LARGE: `The image must be ${MAX_MB}MB or smaller`,
    FST_FILES_LIMIT: `Send exactly one "${FILE_FIELD}" file`,
    FST_FIELDS_LIMIT: 'Too many form fields',
    FST_PARTS_LIMIT: 'Too many form fields',
}

class UploadRejected extends Error {}

/**
 * PATCH bodies are JSON, and JSON is a different wire format from the multipart
 * PUT: values arrive already typed, so PromoArtworkFieldsSchema is the wrong
 * schema here. Its `position` is `z.coerce.number()`, and coercion only skips
 * `undefined` -- a JSON `null`, `true` or `[]` would each be quietly turned into
 * a number instead of being rejected. Nothing is coerced below, and `null` is
 * accepted as the explicit "clear the ordering" signal. The bounds mirror the
 * multipart schema's position field.
 */
const PatchBodySchema = z.object({
    altText: z.string().trim().max(160).optional(),
    position: z.number().int().min(0).max(999).nullable().optional(),
})

type BufferedFile = { buffer: Buffer; mimetype: string }

type ParsedUpload = {
    file: BufferedFile | undefined
    fields: Record<string, string>
}

type CheckedImage = { buffer: Buffer; mimetype: string; ext: string }

const KINDS = Object.values(PromoKind) as string[]

function isKind(value: string): value is PromoKind {
    return KINDS.includes(value)
}

function zodMessage(error: ZodError): string {
    const issue = error.issues[0]
    if (!issue) return 'Invalid request'
    return issue.code === 'custom' || issue.path.length === 0
        ? issue.message
        : `${issue.path.join('.')}: ${issue.message}`
}

/** Buffers the file and the text fields; nothing is validated or stored yet. */
async function readUpload(req: FastifyRequest): Promise<ParsedUpload> {
    let file: BufferedFile | undefined
    const fields: ParsedUpload['fields'] = {}
    const parts: AsyncIterableIterator<Multipart> = req.parts({
        limits: { files: 1, fields: 10, fieldSize: 4096 },
    })

    for await (const part of parts) {
        if (part.type === 'file') {
            if (part.fieldname !== FILE_FIELD) {
                throw new UploadRejected(`Only an "${FILE_FIELD}" file field is accepted`)
            }
            if (file) throw new UploadRejected('Send only one image')
            const buffer = await part.toBuffer()
            if (part.file.truncated) throw new UploadRejected(MULTIPART_ERRORS.FST_REQ_FILE_TOO_LARGE)
            file = { buffer, mimetype: part.mimetype }
        } else if (TEXT_FIELDS.includes(part.fieldname)) {
            if (part.valueTruncated) throw new UploadRejected(`The ${part.fieldname} field is too long`)
            fields[part.fieldname] = String(part.value ?? '')
        }
    }

    return { file, fields }
}

function inspectImage(file: BufferedFile | undefined): { error: string } | { image: CheckedImage } {
    if (!file) return { error: 'An image is required' }
    if (!(PROMO_CARD_SPEC.allowedMimeTypes as readonly string[]).includes(file.mimetype)) {
        return { error: 'The image must be a JPEG, PNG or WebP file' }
    }
    if (file.buffer.byteLength > PROMO_CARD_SPEC.maxFileBytes) {
        return { error: `The image must be ${MAX_MB}MB or smaller` }
    }

    let size: ReturnType<typeof imageSize>
    try {
        size = imageSize(file.buffer)
    } catch {
        return { error: UNREADABLE }
    }
    const format = size.type ? SNIFFED_FORMATS[size.type] : undefined
    if (!format) return { error: UNREADABLE }

    // EXIF orientations 5-8 turn the image a quarter, so browsers display it
    // with width and height swapped.
    const quarterTurn = (size.orientation ?? 1) >= 5
    // An off-ratio upload is refused, not cropped: the tile is 3:1 at every
    // breakpoint, and trimming a 4:3 source to fit would cut off whatever the
    // promotion was trying to show. Hero banners already refuse rather than
    // guess; this follows that precedent.
    const problem = promoCardImageProblem(
        quarterTurn ? size.height : size.width,
        quarterTurn ? size.width : size.height,
    )
    if (problem) return { error: problem }

    return { image: { buffer: file.buffer, ...format } }
}

// The refId is not part of the filename: it is free-form path text (a rule id,
// or the literal 'welcome'), and uploadFile feeds the name straight to
// path.join. The enum-checked kind is enough to tell stored files apart.
function storeImage(kind: PromoKind, image: CheckedImage) {
    return uploadFile(image.buffer, `promo-${kind.toLowerCase()}${image.ext}`, image.mimetype)
}

type ArtworkParams = { kind: string; refId: string }

const promoArtworkAdminRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/', async () => ({ items: await PromoArtworkService.listAll() }))

    fastify.put('/:kind/:refId', async (req, reply) => {
        const { kind, refId } = req.params as ArtworkParams
        if (!isKind(kind)) return reply.status(400).send({ error: `Unknown promo kind "${kind}"` })

        let upload: ParsedUpload
        try {
            upload = await readUpload(req)
        } catch (err: any) {
            const error = err instanceof UploadRejected
                ? err.message
                : (MULTIPART_ERRORS[err?.code] ?? 'Could not read the upload')
            return reply.status(400).send({ error })
        }

        const checked = inspectImage(upload.file)
        if ('error' in checked) return reply.status(400).send({ error: checked.error })
        const fields = PromoArtworkFieldsSchema.safeParse(upload.fields)
        if (!fields.success) return reply.status(400).send({ error: zodMessage(fields.error) })

        const stored = await storeImage(kind, checked.image)
        const item = await PromoArtworkService.upsert(
            { kind, refId },
            { imageUrl: stored.url, altText: fields.data.altText ?? '', position: fields.data.position },
        )
        return { item }
    })

    fastify.patch('/:kind/:refId', async (req, reply) => {
        const { kind, refId } = req.params as ArtworkParams
        if (!isKind(kind)) return reply.status(400).send({ error: `Unknown promo kind "${kind}"` })

        const parsed = PatchBodySchema.safeParse(req.body ?? {})
        if (!parsed.success) return reply.status(400).send({ error: zodMessage(parsed.error) })

        // Zod drops absent keys, so `in` is what separates "left out" (keep what
        // is stored) from an explicit null (clear the ordering).
        const patch: { altText?: string; position?: number | null } = {}
        if ('altText' in parsed.data) patch.altText = parsed.data.altText
        if ('position' in parsed.data) patch.position = parsed.data.position ?? null

        try {
            // The service spells position as `number`, but it forwards every
            // non-undefined value to a column that is nullable, so the null
            // lands as NULL. Cast rather than widen the shared service type.
            const item = await PromoArtworkService.update({ kind, refId }, patch as PromoArtworkPatch)
            return { item }
        } catch (err) {
            if (err instanceof PromoArtworkNotFoundError) return reply.status(404).send({ error: err.message })
            throw err
        }
    })

    fastify.delete('/:kind/:refId', async (req, reply) => {
        const { kind, refId } = req.params as ArtworkParams
        if (!isKind(kind)) return reply.status(400).send({ error: `Unknown promo kind "${kind}"` })

        try {
            await PromoArtworkService.remove({ kind, refId })
            return { ok: true }
        } catch (err) {
            if (err instanceof PromoArtworkNotFoundError) return reply.status(404).send({ error: err.message })
            throw err
        }
    })
}

export default promoArtworkAdminRoutes
