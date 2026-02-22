import { FastifyPluginAsync } from 'fastify'
import { AdminController } from '../../controllers/admin.controller'
import { GameService } from '../../services/game.service'

const adminRoutes: FastifyPluginAsync = async (fastify) => {
    // Both hooks will run sequentially
    fastify.addHook('preValidation', fastify.authenticate)
    fastify.addHook('preValidation', async (request: any, reply) => {
        if (request.user.role !== 'ADMIN' && request.user.role !== 'SUPER_ADMIN') {
            reply.status(403).send({ error: 'Forbidden: Admin access only' })
        }
    })

    fastify.get('/stats', AdminController.getStats)
    fastify.get('/transactions/pending', AdminController.getPendingDeposits)
    fastify.get('/transactions/history', AdminController.getOrdersHistory)
    fastify.get('/withdrawals', AdminController.getWithdrawals)

    fastify.post('/transactions/:id/approve', AdminController.approveTransaction)
    fastify.post('/transactions/:id/decline', AdminController.declineTransaction)

    // User management (T21 / T43)
    fastify.get('/users', AdminController.getUsers)
    fastify.patch('/users/:id/status', AdminController.updateUserStatus)

    // Game management (T21 / T42)
    fastify.get('/games', AdminController.getGames)
    fastify.post('/games/:id/cancel', async (req: any, reply) => {
        await GameService.cancelGame(req.params.id)
        return { success: true }
    })
    fastify.post('/games/:id/start', async (req: any, reply) => {
        return await GameService.startGame(req.params.id)
    })
}

export default adminRoutes

