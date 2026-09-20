import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { extname } from 'path'
import { deflateSync } from 'zlib'
import { prisma } from './setup'

vi.mock('../lib/storage', () => ({
    uploadFile: vi.fn(),
}))

import { uploadFile } from '../lib/storage'
import promoArtworkRoutes from '../routes/admin/promo-artwork'

// ── Real PNG bytes ────────────────────────────────────────────────────────────
// The route sniffs dimensions from the bytes, so fixtures must be genuine images.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
})

function crc32(buf: Buffer): number {
    let c = 0xffffffff
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
}

/** A black 8-bit grayscale PNG. */
function png(width: number, height: number): Buffer {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(width, 0)
    header.writeUInt32BE(height, 4)
    header[8] = 8
    // One filter byte per scanline, then one gray byte per pixel — all zero.
    const pixels = Buffer.alloc((width + 1) * height)
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(pixels)),
        pngChunk('IEND', Buffer.alloc(0)),
    ])
}

const PROMO_PNG = png(900, 300)

// ── Multipart bodies ──────────────────────────────────────────────────────────

const BOUNDARY = 'promoArtworkTestBoundary'
const multipartHeaders = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }

type Part = { name: string; filename?: string; contentType?: string; value: Buffer | string }

function multipartBody(parts: Part[]): Buffer {
    const chunks: Buffer[] = []
    for (const part of parts) {
        let head = `--${BOUNDARY}\r\n`
        if (part.filename !== undefined) {
            head += `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`
            head += `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`
        } else {
            head += `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`
        }
        chunks.push(Buffer.from(head, 'utf8'))
        chunks.push(typeof part.value === 'string' ? Buffer.from(part.value, 'utf8') : part.value)
        chunks.push(Buffer.from('\r\n', 'utf8'))
    }
    chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, 'utf8'))
    return Buffer.concat(chunks)
}

function image(value: Buffer, filename = 'promo.png', contentType = 'image/png'): Part {
    return { name: 'image', filename, contentType, value }
}

// ── App ───────────────────────────────────────────────────────────────────────

// Registered on its own rather than through routes/admin/index: the plugin
// exports no auth hook of its own, and mounting it directly keeps this suite
// from depending on where the admin plugin happens to attach it.
async function buildApp() {
    const app = Fastify({ logger: false })
    await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } })
    await app.register(promoArtworkRoutes, { prefix: '/admin/promo-artwork' })
    await app.ready()
    return app
}

type App = Awaited<ReturnType<typeof buildApp>>

function putArtwork(app: App, kind: string, refId: string, parts: Part[]) {
    return app.inject({
        method: 'PUT',
        url: `/admin/promo-artwork/${kind}/${refId}`,
        headers: multipartHeaders,
        payload: multipartBody(parts),
    })
}

async function adminList(app: App) {
    const res = await app.inject({ method: 'GET', url: '/admin/promo-artwork' })
    expect(res.statusCode).toBe(200)
    return res.json().items as Array<{
        kind: string
        refId: string
        imageUrl: string
        altText: string
        position: number | null
    }>
}

describe('admin promo-artwork routes', () => {
    let uploads = 0

    beforeEach(async () => {
        await prisma.promoArtwork.deleteMany()
        vi.mocked(uploadFile).mockReset()
        vi.mocked(uploadFile).mockImplementation(async (buffer, filename, mimetype) => {
            uploads += 1
            const name = `stored-${uploads}${extname(filename)}`
            return { url: `/uploads/${name}`, filename: name, size: buffer.byteLength, mimetype }
        })
    })

    afterAll(async () => {
        await prisma.promoArtwork.deleteMany()
    })

    describe('PUT /admin/promo-artwork/:kind/:refId', () => {
        it('stores a 3:1 image against the promotion', async () => {
            const app = await buildApp()

            const res = await putArtwork(app, 'CASHBACK', 'promo-1', [
                image(PROMO_PNG),
                { name: 'altText', value: '  10% back every week  ' },
                { name: 'position', value: '2' },
            ])

            expect(res.statusCode).toBe(200)
            expect(res.json().item).toEqual({
                kind: 'CASHBACK',
                refId: 'promo-1',
                imageUrl: expect.stringMatching(/^\/uploads\/stored-\d+\.png$/),
                altText: '10% back every week',
                position: 2,
            })

            const [[buffer, filename, mimetype]] = vi.mocked(uploadFile).mock.calls
            expect(buffer.equals(PROMO_PNG)).toBe(true)
            expect(filename).toBe('promo-cashback.png')
            expect(mimetype).toBe('image/png')

            expect(await prisma.promoArtwork.count()).toBe(1)
            await app.close()
        })

        it('accepts any other 3:1 export and leaves the position unset', async () => {
            const app = await buildApp()

            const res = await putArtwork(app, 'WELCOME', 'welcome', [image(png(1800, 600))])

            expect(res.statusCode).toBe(200)
            expect(res.json().item).toMatchObject({ altText: '', position: null })
            await app.close()
        })

        it('refuses an image that is not 3:1 rather than cropping it', async () => {
            const app = await buildApp()

            const res = await putArtwork(app, 'CASHBACK', 'promo-1', [image(png(900, 675))])

            expect(res.statusCode).toBe(400)
            expect(res.json().error).toMatch(/must be 900×300/)
            expect(uploadFile).not.toHaveBeenCalled()
            expect(await prisma.promoArtwork.count()).toBe(0)
            await app.close()
        })

        it('refuses a 3:1 image that is too small to stay sharp', async () => {
            const app = await buildApp()

            const res = await putArtwork(app, 'CASHBACK', 'promo-1', [image(png(300, 100))])

            expect(res.statusCode).toBe(400)
            expect(res.json().error).toMatch(/at least 450px wide/)
            expect(uploadFile).not.toHaveBeenCalled()
            await app.close()
        })

        it('refuses a file over the 1MB limit', async () => {
            const app = await buildApp()
            const oversized = Buffer.concat([PROMO_PNG, Buffer.alloc(1024 * 1024 + 1)])

            const res = await putArtwork(app, 'CASHBACK', 'promo-1', [image(oversized)])

            expect(res.statusCode).toBe(400)
            expect(res.json().error).toMatch(/1MB or smaller/)
            expect(uploadFile).not.toHaveBeenCalled()
            expect(await prisma.promoArtwork.count()).toBe(0)
            await app.close()
        })

        it('refuses non-image bytes even when the part claims image/png', async () => {
            const app = await buildApp()

            const res = await putArtwork(app, 'CASHBACK', 'promo-1', [
                image(Buffer.from('<html><script>alert(1)</script></html>')),
            ])

            expect(res.statusCode).toBe(400)
            expect(res.json().error).toMatch(/not a readable JPEG, PNG or WebP/)
            expect(uploadFile).not.toHaveBeenCalled()
            await app.close()
        })

        it('stores a file named .html with the extension of its real image type', async () => {
            const app = await buildApp()

            const res = await putArtwork(app, 'REFERRAL', 'referral', [
                image(PROMO_PNG, 'evil.html', 'image/webp'),
            ])

            expect(res.statusCode).toBe(200)
            const [[, filename, mimetype]] = vi.mocked(uploadFile).mock.calls
            expect(filename).toBe('promo-referral.png')
            expect(mimetype).toBe('image/png')
            await app.close()
        })

        it('replaces the image on a second upload for the same promotion', async () => {
            const app = await buildApp()
            const first = await putArtwork(app, 'DEPOSIT_RULE', 'rule-1', [
                image(PROMO_PNG),
                { name: 'altText', value: 'First' },
                { name: 'position', value: '1' },
            ])
            expect(first.statusCode).toBe(200)

            const second = await putArtwork(app, 'DEPOSIT_RULE', 'rule-1', [
                image(png(1200, 400)),
                { name: 'altText', value: 'Second' },
            ])

            expect(second.statusCode).toBe(200)
            const item = second.json().item
            expect(item.altText).toBe('Second')
            expect(item.imageUrl).not.toBe(first.json().item.imageUrl)
            // Re-uploading only the image keeps the ordering the admin already set.
            expect(item.position).toBe(1)

            // A different promotion is a different row, not a replacement.
            await putArtwork(app, 'DEPOSIT_RULE', 'rule-2', [image(PROMO_PNG)])

            const items = await adminList(app)
            expect(items.map((x) => [x.kind, x.refId, x.altText])).toEqual([
                ['DEPOSIT_RULE', 'rule-1', 'Second'],
                ['DEPOSIT_RULE', 'rule-2', ''],
            ])
            await app.close()
        })

        it('rejects a kind outside the PromoKind enum', async () => {
            const app = await buildApp()

            const res = await putArtwork(app, 'cashback', 'promo-1', [image(PROMO_PNG)])

            expect(res.statusCode).toBe(400)
            expect(res.json().error).toMatch(/Unknown promo kind/)
            expect(uploadFile).not.toHaveBeenCalled()
            expect(await prisma.promoArtwork.count()).toBe(0)
            await app.close()
        })

        it('rejects a request that is not multipart', async () => {
            const app = await buildApp()

            const res = await app.inject({
                method: 'PUT',
                url: '/admin/promo-artwork/CASHBACK/promo-1',
                payload: { altText: 'x' },
            })

            expect(res.statusCode).toBe(400)
            expect(typeof res.json().error).toBe('string')
            await app.close()
        })
    })

    describe('GET /admin/promo-artwork', () => {
        it('returns every row, positioned art first', async () => {
            const app = await buildApp()

            await putArtwork(app, 'WELCOME', 'welcome', [image(PROMO_PNG)])
            await putArtwork(app, 'CASHBACK', 'promo-1', [image(PROMO_PNG), { name: 'position', value: '0' }])

            expect((await adminList(app)).map((x) => [x.refId, x.position])).toEqual([
                ['promo-1', 0],
                ['welcome', null],
            ])
            await app.close()
        })
    })

    describe('PATCH /admin/promo-artwork/:kind/:refId', () => {
        it('updates altText and position without touching the image', async () => {
            const app = await buildApp()
            const created = await putArtwork(app, 'CASHBACK', 'promo-1', [
                image(PROMO_PNG),
                { name: 'altText', value: 'Before' },
            ])
            const { imageUrl } = created.json().item

            const res = await app.inject({
                method: 'PATCH',
                url: '/admin/promo-artwork/CASHBACK/promo-1',
                payload: { altText: 'After', position: 3 },
            })

            expect(res.statusCode).toBe(200)
            expect(res.json().item).toEqual({
                kind: 'CASHBACK',
                refId: 'promo-1',
                imageUrl,
                altText: 'After',
                position: 3,
            })

            const kept = await app.inject({
                method: 'PATCH',
                url: '/admin/promo-artwork/CASHBACK/promo-1',
                payload: { position: 4 },
            })
            expect(kept.json().item).toMatchObject({ altText: 'After', position: 4 })
            await app.close()
        })

        it('rejects a position outside the orderable range', async () => {
            const app = await buildApp()
            await putArtwork(app, 'CASHBACK', 'promo-1', [image(PROMO_PNG)])

            const res = await app.inject({
                method: 'PATCH',
                url: '/admin/promo-artwork/CASHBACK/promo-1',
                payload: { position: 1000 },
            })

            expect(res.statusCode).toBe(400)
            expect(typeof res.json().error).toBe('string')
            await app.close()
        })

        it('returns 404 for a promotion with no artwork', async () => {
            const app = await buildApp()

            const res = await app.inject({
                method: 'PATCH',
                url: '/admin/promo-artwork/CASHBACK/nope',
                payload: { altText: 'x' },
            })

            expect(res.statusCode).toBe(404)
            expect(typeof res.json().error).toBe('string')
            await app.close()
        })
    })

    describe('DELETE /admin/promo-artwork/:kind/:refId', () => {
        it('removes the row so the generated card comes back', async () => {
            const app = await buildApp()
            await putArtwork(app, 'CASHBACK', 'promo-1', [image(PROMO_PNG)])
            await putArtwork(app, 'WELCOME', 'welcome', [image(PROMO_PNG)])

            const res = await app.inject({ method: 'DELETE', url: '/admin/promo-artwork/CASHBACK/promo-1' })

            expect(res.statusCode).toBe(200)
            expect(res.json()).toEqual({ ok: true })
            expect((await adminList(app)).map((x) => x.refId)).toEqual(['welcome'])

            const again = await app.inject({ method: 'DELETE', url: '/admin/promo-artwork/CASHBACK/promo-1' })
            expect(again.statusCode).toBe(404)
            expect(typeof again.json().error).toBe('string')
            await app.close()
        })

        it('rejects a kind outside the PromoKind enum', async () => {
            const app = await buildApp()

            const res = await app.inject({ method: 'DELETE', url: '/admin/promo-artwork/BOGUS/promo-1' })

            expect(res.statusCode).toBe(400)
            expect(res.json().error).toMatch(/Unknown promo kind/)
            await app.close()
        })
    })
})
