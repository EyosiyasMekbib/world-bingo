import { FastifyPluginAsync } from 'fastify'
import { PromotionsService } from '../../services/promotions.service'

const promotionsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (_req, _reply) => {
    return PromotionsService.getPromotions()
  })
}

export default promotionsRoutes
