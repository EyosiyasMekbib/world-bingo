import { FastifyPluginAsync } from 'fastify'
import { CreateGameSchema, JoinGameSchema, ClaimBingoSchema } from '@world-bingo/shared-types'
import { GameController } from '../../controllers/game.controller'
import { GameService } from '../../services'
import zodToJsonSchema from 'zod-to-json-schema'

const gameRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.post('/', {
        preValidation: [fastify.authenticate],
        schema: {
            body: zodToJsonSchema(CreateGameSchema),
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

    fastify.post('/:id/join', {
        preValidation: [fastify.authenticate],
        schema: {
            body: zodToJsonSchema(JoinGameSchema),
        },
        handler: async (req, reply) => {
            // @ts-ignore
            const userId = req.user.id
            // @ts-ignore
            const gameId = req.params.id
            const { cartelaSerials } = req.body as { cartelaSerials: string[] }
            return await GameService.joinGame(userId, gameId, cartelaSerials)
        },
    })

    fastify.post('/:id/claim', {
        preValidation: [fastify.authenticate],
        schema: {
            body: zodToJsonSchema(ClaimBingoSchema),
        },
        handler: async (req, reply) => {
            // @ts-ignore
            const userId = req.user.id
            // @ts-ignore
            const gameId = req.params.id
            const { cartelaId } = req.body as { cartelaId: string }
            return await GameService.claimBingo(userId, gameId, cartelaId)
        },
    })
    
    fastify.post('/:id/start', {
        preValidation: [fastify.authenticate],
        handler: async (req, reply) => {
             // @ts-ignore
             if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPER_ADMIN') return reply.status(403).send('Forbidden')
             // @ts-ignore
             return await GameService.startGame(req.params.id)
        }
    })
}

export default gameRoutes

