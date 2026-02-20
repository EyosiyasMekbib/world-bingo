import { FastifyPluginAsync } from 'fastify'
import { CreateGameSchema } from '@world-bingo/shared-types'
import { GameController } from '../../controllers/game.controller'

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
}

export default gameRoutes
