import { FastifyReply, FastifyRequest } from 'fastify'
import { NotificationService } from '../services/notification.service'

export class NotificationController {
    static async getUnread(request: FastifyRequest, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        const notifications = await NotificationService.getUnread(userId)
        return notifications
    }

    static async markAsRead(
        request: FastifyRequest<{ Params: { id: string } }>,
        reply: FastifyReply,
    ) {
        // @ts-ignore
        const userId = request.user.id
        const { id } = request.params
        await NotificationService.markAsRead(id, userId)
        return { message: 'Notification marked as read' }
    }

    static async markAllRead(request: FastifyRequest, reply: FastifyReply) {
        // @ts-ignore
        const userId = request.user.id
        await NotificationService.markAllRead(userId)
        return { message: 'All notifications marked as read' }
    }
}
