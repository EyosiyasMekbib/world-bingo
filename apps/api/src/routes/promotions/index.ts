import { FastifyPluginAsync } from 'fastify'
import { PromotionsService } from '../../services/promotions.service'

const promotionsRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.get('/', async (_req, _reply) => {
        return PromotionsService.getPromotions()
    })

    // Authenticated per route rather than with the plugin-wide preValidation
    // hook wallet uses: the tile list above has to stay readable by a
    // signed-out visitor, and progress is the only thing here that is per-player.
    fastify.get('/me', {
        preValidation: [fastify.authenticate],
        handler: async (req, _reply) => {
            // @ts-ignore
            return PromotionsService.getProgressFor(req.user.id)
        },
    })
}

export default promotionsRoutes
