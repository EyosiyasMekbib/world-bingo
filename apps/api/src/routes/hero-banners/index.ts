import { FastifyPluginAsync } from 'fastify'
import { HeroBannerService } from '../../services/hero-banner.service'

const heroBannerRoutes: FastifyPluginAsync = async (fastify) => {
  // ── Public: GET /hero-banners ───────────────────────────────────────
  // No auth — the lobby reads this on load. An empty list means the lobby
  // shows its built-in slides.
  fastify.get('/', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=30')
    return { items: await HeroBannerService.listActive() }
  })
}

export default heroBannerRoutes
