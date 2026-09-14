import { FastifyPluginAsync, FastifyRequest } from 'fastify'
import type { Multipart } from '@fastify/multipart'
import { imageSize } from 'image-size'
import type { ZodError } from 'zod'
import {
    HERO_BANNER_SPEC,
    HeroBannerCreateFieldsSchema,
    HeroBannerReorderSchema,
    HeroBannerUpdateSchema,
    heroBannerImageProblem,
    type HeroBannerVariant,
} from '@world-bingo/shared-types'
import { uploadFile } from '../../lib/storage'
import {
    HeroBannerNotFoundError,
    HeroBannerOrderError,
    HeroBannerService,
} from '../../services/hero-banner.service'

/**
 * Lobby hero banners. Mounted inside the admin plugin's requireAdmin scope, so
 * it inherits that auth hook.
 */

const TEXT_FIELDS = ['altText', 'linkUrl']
const MAX_MB = HERO_BANNER_SPEC.maxFileBytes / (1024 * 1024)
const UNREADABLE = (variant: HeroBannerVariant) => `The ${variant} image is not a readable JPEG, PNG or WebP file`

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
    FST_REQ_FILE_TOO_LARGE: `Each image must be ${MAX_MB}MB or smaller`,
    FST_FILES_LIMIT: 'Send exactly one desktop image and one mobile image',
    FST_FIELDS_LIMIT: 'Too many form fields',
    FST_PARTS_LIMIT: 'Too many form fields',
}

class UploadRejected extends Error {}

type BufferedFile = { buffer: Buffer; mimetype: string }

type ParsedUpload = {
    files: Partial<Record<HeroBannerVariant, BufferedFile>>
    fields: Record<string, string>
}

type CheckedImage = { buffer: Buffer; mimetype: string; ext: string }

function isVariant(name: string): name is HeroBannerVariant {
    return name === 'desktop' || name === 'mobile'
}

function zodMessage(error: ZodError): string {
    const issue = error.issues[0]
    if (!issue) return 'Invalid request'
    return issue.code === 'custom' || issue.path.length === 0
        ? issue.message
        : `${issue.path.join('.')}: ${issue.message}`
}

/** Buffers both files and the text fields; nothing is validated or stored yet. */
async function readUpload(req: FastifyRequest): Promise<ParsedUpload> {
    const files: ParsedUpload['files'] = {}
    const fields: ParsedUpload['fields'] = {}
    const parts: AsyncIterableIterator<Multipart> = req.parts({
        limits: { files: 2, fields: 10, fieldSize: 4096 },
    })

    for await (const part of parts) {
        if (part.type === 'file') {
            if (!isVariant(part.fieldname)) {
                throw new UploadRejected('Only "desktop" and "mobile" image fields are accepted')
            }
            if (files[part.fieldname]) throw new UploadRejected(`Send only one ${part.fieldname} image`)
            const buffer = await part.toBuffer()
            if (part.file.truncated) throw new UploadRejected(MULTIPART_ERRORS.FST_REQ_FILE_TOO_LARGE)
            files[part.fieldname] = { buffer, mimetype: part.mimetype }
        } else if (TEXT_FIELDS.includes(part.fieldname)) {
            if (part.valueTruncated) throw new UploadRejected(`The ${part.fieldname} field is too long`)
            fields[part.fieldname] = String(part.value ?? '')
        }
    }

    return { files, fields }
}

function inspectImage(variant: HeroBannerVariant, file: BufferedFile | undefined): { error: string } | { image: CheckedImage } {
    if (!file) return { error: `The ${variant} image is required` }
    if (!(HERO_BANNER_SPEC.allowedMimeTypes as readonly string[]).includes(file.mimetype)) {
        return { error: `The ${variant} image must be a JPEG, PNG or WebP file` }
    }
    if (file.buffer.byteLength > HERO_BANNER_SPEC.maxFileBytes) {
        return { error: `The ${variant} image must be ${MAX_MB}MB or smaller` }
    }

    let size: ReturnType<typeof imageSize>
    try {
        size = imageSize(file.buffer)
    } catch {
        return { error: UNREADABLE(variant) }
    }
    const format = size.type ? SNIFFED_FORMATS[size.type] : undefined
    if (!format) return { error: UNREADABLE(variant) }

    // EXIF orientations 5-8 turn the image a quarter, so browsers display it
    // with width and height swapped.
    const quarterTurn = (size.orientation ?? 1) >= 5
    const problem = heroBannerImageProblem(
        variant,
        quarterTurn ? size.height : size.width,
        quarterTurn ? size.width : size.height,
    )
    if (problem) return { error: problem }

    return { image: { buffer: file.buffer, ...format } }
}

function storeImage(variant: HeroBannerVariant, image: CheckedImage) {
    return uploadFile(image.buffer, `hero-${variant}${image.ext}`, image.mimetype)
}

const heroBannerAdminRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/', async () => ({ items: await HeroBannerService.listAll() }))

    fastify.post('/', async (req, reply) => {
        let upload: ParsedUpload
        try {
            upload = await readUpload(req)
        } catch (err: any) {
            const error = err instanceof UploadRejected
                ? err.message
                : (MULTIPART_ERRORS[err?.code] ?? 'Could not read the upload')
            return reply.status(400).send({ error })
        }

        const desktop = inspectImage('desktop', upload.files.desktop)
        if ('error' in desktop) return reply.status(400).send({ error: desktop.error })
        const mobile = inspectImage('mobile', upload.files.mobile)
        if ('error' in mobile) return reply.status(400).send({ error: mobile.error })
        const fields = HeroBannerCreateFieldsSchema.safeParse(upload.fields)
        if (!fields.success) return reply.status(400).send({ error: zodMessage(fields.error) })

        const [desktopStored, mobileStored] = await Promise.all([
            storeImage('desktop', desktop.image),
            storeImage('mobile', mobile.image),
        ])
        const item = await HeroBannerService.create({
            desktopImageUrl: desktopStored.url,
            mobileImageUrl: mobileStored.url,
            altText: fields.data.altText ?? '',
            linkUrl: fields.data.linkUrl ?? null,
        })
        return reply.status(201).send({ item })
    })

    fastify.put('/order', async (req, reply) => {
        const parsed = HeroBannerReorderSchema.safeParse(req.body)
        if (!parsed.success) return reply.status(400).send({ error: zodMessage(parsed.error) })
        try {
            return { items: await HeroBannerService.reorder(parsed.data.ids ?? []) }
        } catch (err) {
            if (err instanceof HeroBannerOrderError) return reply.status(400).send({ error: err.message })
            throw err
        }
    })

    fastify.patch('/:id', async (req, reply) => {
        const { id } = req.params as { id: string }
        const parsed = HeroBannerUpdateSchema.safeParse(req.body ?? {})
        if (!parsed.success) return reply.status(400).send({ error: zodMessage(parsed.error) })
        try {
            return { item: await HeroBannerService.update(id, parsed.data) }
        } catch (err) {
            if (err instanceof HeroBannerNotFoundError) return reply.status(404).send({ error: err.message })
            throw err
        }
    })

    fastify.delete('/:id', async (req, reply) => {
        const { id } = req.params as { id: string }
        try {
            await HeroBannerService.remove(id)
            return { ok: true }
        } catch (err) {
            if (err instanceof HeroBannerNotFoundError) return reply.status(404).send({ error: err.message })
            throw err
        }
    })
}

export default heroBannerAdminRoutes
