import { FastifyPluginAsync } from 'fastify'
import { AdminController } from '../../controllers/admin.controller'

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
}

export default adminRoutes
