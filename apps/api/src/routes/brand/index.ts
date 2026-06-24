import { FastifyPluginAsync } from 'fastify'
import { BrandService } from '../../services/brand.service'
import { uploadFile } from '../../lib/storage'

const brandRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Public: GET /brand ──────────────────────────────────────────────
  // No auth — the web app reads this on every page load (SSR).
  fastify.get('/', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=30')
    return BrandService.getBrand()
  })

  // ── Admin: PUT /brand ───────────────────────────────────────────────
  fastify.put('/', { preValidation: [fastify.requireAdmin] }, async (req, reply) => {
    try {
      return await BrandService.updateBrand((req.body ?? {}) as any)
    } catch (err: any) {
      return reply.status(400).send({ error: err?.message ?? 'Invalid brand config' })
    }
  })

  // ── Admin: POST /brand/logo and /brand/favicon ──────────────────────
  for (const kind of ['logo', 'favicon'] as const) {
    fastify.post(`/${kind}`, { preValidation: [fastify.requireAdmin] }, async (req, reply) => {
      const part = await (req as any).file()
      if (!part) return reply.status(400).send({ error: 'No file uploaded' })
      try {
        const buffer = await part.toBuffer()
        const result = await uploadFile(buffer, part.filename, part.mimetype)
        return { url: result.url }
      } catch (err: any) {
        return reply.status(400).send({ error: err?.message ?? 'Upload failed' })
      }
    })
  }
}

export default brandRoutes
