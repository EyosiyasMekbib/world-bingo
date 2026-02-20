import { FastifyPluginAsync } from 'fastify'
import { CreateGameSchema } from '@world-bingo/shared-types'
import { GameController } from '../../controllers/game.controller'
import { GameService } from '../../services'

const gameRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.post('/', {
        preValidation: [fastify.authenticate],
        schema: {
            body: CreateGameSchema,
        },
        handler: GameController.create,
    })

    fastify.get('/', {
        handler: GameController.list,
    })

    fastify.get('/:id', {
        handler: GameController.get,
    })

    fastify.get('/:id/cartelas', {
        handler: GameController.getAvailableCartelas,
    })
    
    fastify.post('/:id/start', {
        preValidation: [fastify.authenticate], // Admin only ideally
        handler: async (req, reply) => {
             // @ts-ignore
             if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') return reply.status(403).send('Forbidden')
             // @ts-ignore
             return await GameService.startGame(req.params.id)
        }
    })
}

export default gameRoutes
