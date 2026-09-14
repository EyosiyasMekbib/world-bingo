import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import { extname } from 'path'
import { deflateSync } from 'zlib'
import { prisma } from './setup'

vi.mock('../lib/redis', () => ({
  default: {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    keys: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('../lib/storage', () => ({
  uploadFile: vi.fn(),
}))

import { uploadFile } from '../lib/storage'
import adminRoutes from '../routes/admin/index'
import heroBannerRoutes from '../routes/hero-banners/index'

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

const DESKTOP_PNG = png(1440, 300)
const MOBILE_PNG = png(780, 452)

// ── Multipart bodies ──────────────────────────────────────────────────────────

const BOUNDARY = 'heroBannerTestBoundary'
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

function image(name: 'desktop' | 'mobile', value: Buffer, filename = `${name}.png`, contentType = 'image/png'): Part {
  return { name, filename, contentType, value }
}

const validImages = (): Part[] => [image('desktop', DESKTOP_PNG), image('mobile', MOBILE_PNG)]

// ── App ───────────────────────────────────────────────────────────────────────

async function buildApp(requireAdmin: (req: any, reply: any) => Promise<any> = async () => {}) {
  const app = Fastify({ logger: false })
  app.decorate('authenticate', async () => {})
  app.decorate('requireAdmin', requireAdmin)
  app.decorate('requireSuperAdmin', async () => {})
  app.decorate('requireAdminOrClerk', async () => {})
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } })
  await app.register(adminRoutes, { prefix: '/admin' })
  await app.register(heroBannerRoutes, { prefix: '/hero-banners' })
  await app.ready()
  return app
}

type App = Awaited<ReturnType<typeof buildApp>>

function postBanner(app: App, parts: Part[]) {
  return app.inject({
    method: 'POST',
    url: '/admin/hero-banners',
    headers: multipartHeaders,
    payload: multipartBody(parts),
  })
}

async function seedBanners(app: App, altTexts: string[]) {
  const items = []
  for (const altText of altTexts) {
    const res = await postBanner(app, [...validImages(), { name: 'altText', value: altText }])
    expect(res.statusCode).toBe(201)
    items.push(res.json().item)
  }
  return items
}

async function adminList(app: App) {
  const res = await app.inject({ method: 'GET', url: '/admin/hero-banners' })
  expect(res.statusCode).toBe(200)
  return res.json().items as Array<{ id: string; altText: string; position: number; isActive: boolean }>
}

describe('admin hero-banner routes', () => {
  let uploads = 0

  beforeEach(async () => {
    await prisma.heroBanner.deleteMany()
    vi.mocked(uploadFile).mockReset()
    vi.mocked(uploadFile).mockImplementation(async (buffer, filename, mimetype) => {
      uploads += 1
      const name = `stored-${uploads}${extname(filename)}`
      return { url: `/uploads/${name}`, filename: name, size: buffer.byteLength, mimetype }
    })
  })

  afterAll(async () => {
    await prisma.heroBanner.deleteMany()
  })

  describe('POST /admin/hero-banners', () => {
    it('creates an active banner from a valid desktop/mobile pair and puts it last', async () => {
      const app = await buildApp()

      const res = await postBanner(app, [
        ...validImages(),
        { name: 'altText', value: '  Weekend jackpot  ' },
        { name: 'linkUrl', value: '/games' },
      ])

      expect(res.statusCode).toBe(201)
      const { item } = res.json()
      expect(item).toMatchObject({
        altText: 'Weekend jackpot',
        linkUrl: '/games',
        isActive: true,
        position: 0,
      })
      expect(item.desktopImageUrl).toMatch(/^\/uploads\/stored-\d+\.png$/)
      expect(item.mobileImageUrl).toMatch(/^\/uploads\/stored-\d+\.png$/)
      expect(item.desktopImageUrl).not.toBe(item.mobileImageUrl)
      expect(typeof item.createdAt).toBe('string')

      const calls = vi.mocked(uploadFile).mock.calls
      expect(calls.map(([, filename, mimetype]) => [filename, mimetype]).sort()).toEqual([
        ['hero-desktop.png', 'image/png'],
        ['hero-mobile.png', 'image/png'],
      ])
      const storedDesktop = calls.find(([, filename]) => filename === 'hero-desktop.png')![0]
      expect(storedDesktop.equals(DESKTOP_PNG)).toBe(true)

      const second = await postBanner(app, validImages())
      expect(second.statusCode).toBe(201)
      expect(second.json().item).toMatchObject({ position: 1, altText: '', linkUrl: null })

      expect(await prisma.heroBanner.count()).toBe(2)
      await app.close()
    })

    it('accepts the 1x mobile size', async () => {
      const app = await buildApp()
      const res = await postBanner(app, [image('desktop', DESKTOP_PNG), image('mobile', png(390, 226))])
      expect(res.statusCode).toBe(201)
      await app.close()
    })

    it('rejects an image with the wrong aspect ratio', async () => {
      const app = await buildApp()

      const res = await postBanner(app, [image('desktop', png(1440, 400)), image('mobile', MOBILE_PNG)])

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/desktop image must be 1440×300/)
      expect(uploadFile).not.toHaveBeenCalled()
      expect(await prisma.heroBanner.count()).toBe(0)
      await app.close()
    })

    it('rejects an image that has the right shape but is too narrow', async () => {
      const app = await buildApp()

      const res = await postBanner(app, [image('desktop', png(720, 150)), image('mobile', MOBILE_PNG)])

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/at least 1440px wide/)
      expect(uploadFile).not.toHaveBeenCalled()
      await app.close()
    })

    it('rejects a banner without a mobile image', async () => {
      const app = await buildApp()

      const res = await postBanner(app, [image('desktop', DESKTOP_PNG), { name: 'altText', value: 'Promo' }])

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('The mobile image is required')
      expect(uploadFile).not.toHaveBeenCalled()
      expect(await prisma.heroBanner.count()).toBe(0)
      await app.close()
    })

    it('does not store the desktop image when the mobile one fails', async () => {
      const app = await buildApp()

      const res = await postBanner(app, [image('desktop', DESKTOP_PNG), image('mobile', png(1440, 300))])

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/mobile image must be 780×452/)
      expect(uploadFile).not.toHaveBeenCalled()
      await app.close()
    })

    it('rejects non-image bytes even when the part claims image/png', async () => {
      const app = await buildApp()

      const res = await postBanner(app, [
        image('desktop', Buffer.from('<html><script>alert(1)</script></html>')),
        image('mobile', MOBILE_PNG),
      ])

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/desktop image is not a readable JPEG, PNG or WebP/)
      expect(uploadFile).not.toHaveBeenCalled()
      await app.close()
    })

    it('rejects a mimetype outside the allowed list', async () => {
      const app = await buildApp()

      const res = await postBanner(app, [
        image('desktop', DESKTOP_PNG, 'desktop.png', 'text/html'),
        image('mobile', MOBILE_PNG),
      ])

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/must be a JPEG, PNG or WebP/)
      expect(uploadFile).not.toHaveBeenCalled()
      await app.close()
    })

    it('rejects a file over the size limit', async () => {
      const app = await buildApp()
      const oversized = Buffer.concat([DESKTOP_PNG, Buffer.alloc(5 * 1024 * 1024)])

      const res = await postBanner(app, [image('desktop', oversized), image('mobile', MOBILE_PNG)])

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/5MB or smaller/)
      expect(uploadFile).not.toHaveBeenCalled()
      await app.close()
    })

    it('stores a file named .html with the extension of its real image type', async () => {
      const app = await buildApp()

      const res = await postBanner(app, [
        image('desktop', DESKTOP_PNG, 'evil.html'),
        image('mobile', MOBILE_PNG, 'evil.svg', 'image/webp'),
      ])

      expect(res.statusCode).toBe(201)
      const filenames = vi.mocked(uploadFile).mock.calls.map(([, filename]) => filename)
      expect(filenames.sort()).toEqual(['hero-desktop.png', 'hero-mobile.png'])
      for (const [, filename, mimetype] of vi.mocked(uploadFile).mock.calls) {
        expect(filename).not.toMatch(/html|svg/)
        expect(mimetype).toBe('image/png')
      }
      await app.close()
    })

    it.each(['javascript:alert(1)', '//evil.example', '/\\evil.example', 'http://insecure.example/promo'])(
      'rejects the unsafe link %s',
      async (linkUrl) => {
        const app = await buildApp()

        const res = await postBanner(app, [...validImages(), { name: 'linkUrl', value: linkUrl }])

        expect(res.statusCode).toBe(400)
        expect(res.json().error).toMatch(/Link must be a site path/)
        expect(uploadFile).not.toHaveBeenCalled()
        expect(await prisma.heroBanner.count()).toBe(0)
        await app.close()
      },
    )

    it('rejects a request that is not multipart', async () => {
      const app = await buildApp()

      const res = await app.inject({ method: 'POST', url: '/admin/hero-banners', payload: { altText: 'x' } })

      expect(res.statusCode).toBe(400)
      expect(typeof res.json().error).toBe('string')
      await app.close()
    })
  })

  it('lists every banner in position order', async () => {
    const app = await buildApp()
    await seedBanners(app, ['A', 'B', 'C'])

    const items = await adminList(app)

    expect(items.map((b) => [b.altText, b.position])).toEqual([
      ['A', 0],
      ['B', 1],
      ['C', 2],
    ])
    await app.close()
  })

  describe('PATCH /admin/hero-banners/:id', () => {
    it('updates isActive and linkUrl, and clears the link with an empty string', async () => {
      const app = await buildApp()
      const [banner] = await seedBanners(app, ['A'])

      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/hero-banners/${banner.id}`,
        payload: { isActive: false, linkUrl: 'https://promo.example.com/weekend' },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().item).toMatchObject({
        id: banner.id,
        isActive: false,
        linkUrl: 'https://promo.example.com/weekend',
        altText: 'A',
        position: 0,
      })

      const cleared = await app.inject({
        method: 'PATCH',
        url: `/admin/hero-banners/${banner.id}`,
        payload: { linkUrl: '' },
      })
      expect(cleared.statusCode).toBe(200)
      expect(cleared.json().item).toMatchObject({ linkUrl: null, isActive: false })

      await app.close()
    })

    it('rejects an unsafe link', async () => {
      const app = await buildApp()
      const [banner] = await seedBanners(app, ['A'])

      const res = await app.inject({
        method: 'PATCH',
        url: `/admin/hero-banners/${banner.id}`,
        payload: { linkUrl: 'javascript:alert(1)' },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/Link must be a site path/)
      await app.close()
    })

    it('returns 404 for an unknown banner', async () => {
      const app = await buildApp()

      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/hero-banners/00000000-0000-4000-8000-000000000000',
        payload: { isActive: false },
      })

      expect(res.statusCode).toBe(404)
      expect(typeof res.json().error).toBe('string')
      await app.close()
    })
  })

  describe('PUT /admin/hero-banners/order', () => {
    it('rejects a partial or duplicated id list and leaves the order alone', async () => {
      const app = await buildApp()
      const [a, b, c] = await seedBanners(app, ['A', 'B', 'C'])

      const partial = await app.inject({
        method: 'PUT',
        url: '/admin/hero-banners/order',
        payload: { ids: [c.id, a.id] },
      })
      expect(partial.statusCode).toBe(400)
      expect(partial.json().error).toMatch(/every banner/)

      const duplicated = await app.inject({
        method: 'PUT',
        url: '/admin/hero-banners/order',
        payload: { ids: [c.id, a.id, a.id] },
      })
      expect(duplicated.statusCode).toBe(400)

      const unknown = await app.inject({
        method: 'PUT',
        url: '/admin/hero-banners/order',
        payload: { ids: [c.id, a.id, '00000000-0000-4000-8000-000000000000'] },
      })
      expect(unknown.statusCode).toBe(400)

      expect((await adminList(app)).map((x) => x.id)).toEqual([a.id, b.id, c.id])
      await app.close()
    })

    it('applies the full id list', async () => {
      const app = await buildApp()
      const [a, b, c] = await seedBanners(app, ['A', 'B', 'C'])

      const res = await app.inject({
        method: 'PUT',
        url: '/admin/hero-banners/order',
        payload: { ids: [c.id, a.id, b.id] },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json().items.map((x: any) => [x.altText, x.position])).toEqual([
        ['C', 0],
        ['A', 1],
        ['B', 2],
      ])
      expect((await adminList(app)).map((x) => x.altText)).toEqual(['C', 'A', 'B'])
      await app.close()
    })
  })

  describe('DELETE /admin/hero-banners/:id', () => {
    it('removes the banner and compacts the remaining positions', async () => {
      const app = await buildApp()
      const [, b] = await seedBanners(app, ['A', 'B', 'C', 'D'])

      const res = await app.inject({ method: 'DELETE', url: `/admin/hero-banners/${b.id}` })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true })
      expect((await adminList(app)).map((x) => [x.altText, x.position])).toEqual([
        ['A', 0],
        ['C', 1],
        ['D', 2],
      ])

      const created = await postBanner(app, validImages())
      expect(created.json().item.position).toBe(3)

      const again = await app.inject({ method: 'DELETE', url: `/admin/hero-banners/${b.id}` })
      expect(again.statusCode).toBe(404)
      expect(typeof again.json().error).toBe('string')
      await app.close()
    })
  })

  it('refuses every admin route when requireAdmin rejects', async () => {
    const app = await buildApp(async (_req, reply) => reply.status(403).send({ error: 'Forbidden' }))

    const list = await app.inject({ method: 'GET', url: '/admin/hero-banners' })
    const create = await postBanner(app, validImages())

    expect(list.statusCode).toBe(403)
    expect(create.statusCode).toBe(403)
    expect(uploadFile).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('GET /hero-banners', () => {
  beforeEach(async () => {
    await prisma.heroBanner.deleteMany()
  })

  afterAll(async () => {
    await prisma.heroBanner.deleteMany()
  })

  it('returns an empty list when there are no banners', async () => {
    const app = await buildApp()

    const res = await app.inject({ method: 'GET', url: '/hero-banners' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ items: [] })
    await app.close()
  })

  it('returns only active banners, in order, with a short public cache', async () => {
    const rows = await Promise.all(
      [
        { altText: 'Third', position: 2, isActive: true, linkUrl: 'https://promo.example.com/x' },
        { altText: 'Hidden', position: 1, isActive: false, linkUrl: null },
        { altText: 'First', position: 0, isActive: true, linkUrl: '/games' },
      ].map((data) =>
        prisma.heroBanner.create({
          data: { ...data, desktopImageUrl: `/uploads/${data.altText}-d.png`, mobileImageUrl: `/uploads/${data.altText}-m.png` },
        }),
      ),
    )
    const first = rows.find((r) => r.altText === 'First')!
    // Even an admin-less caller gets the list: the public route has no auth hook.
    const app = await buildApp(async (_req, reply) => reply.status(403).send({ error: 'Forbidden' }))

    const res = await app.inject({ method: 'GET', url: '/hero-banners' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=30')
    const { items } = res.json()
    expect(items.map((b: any) => b.altText)).toEqual(['First', 'Third'])
    expect(items[0]).toEqual({
      id: first.id,
      desktopImageUrl: '/uploads/First-d.png',
      mobileImageUrl: '/uploads/First-m.png',
      altText: 'First',
      linkUrl: '/games',
    })
    await app.close()
  })
})
