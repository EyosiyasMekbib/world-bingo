import { FastifyPluginAsync } from 'fastify'
import { NotificationController } from '../../controllers/notification.controller'

const userRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preValidation', fastify.authenticate)

    // GET /notifications — get unread notifications
    fastify.get('/notifications', NotificationController.getUnread)

    // POST /notifications/:id/read — mark single as read
    fastify.post('/notifications/:id/read', NotificationController.markAsRead)

    // POST /notifications/read-all — mark all as read
    fastify.post('/notifications/read-all', NotificationController.markAllRead)
}

export default userRoutes
