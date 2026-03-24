import prisma from '../lib/prisma'
import { Prisma } from '@prisma/client'
import { NotificationType } from '@world-bingo/shared-types'
import { getIo } from '../lib/socket'

export class NotificationService {
    /**
     * Create a notification and push it to the user's socket room.
     */
    static async create(
        userId: string,
        type: NotificationType,
        title: string,
        body: string,
        metadata?: Record<string, unknown>,
    ) {
        const notification = await prisma.notification.create({
            data: {
                userId,
                type,
                title,
                body,
                // Prisma requires Prisma.InputJsonValue — cast via JSON round-trip
                metadata: metadata ? (metadata as object) : Prisma.JsonNull,
            },
        })

        // Push real-time notification via WebSocket to user's personal room
        try {
            const io = getIo()
            io.to(`user:${userId}`).emit('notification:new', {
                id: notification.id,
                userId: notification.userId,
                type: notification.type as NotificationType,
                title: notification.title,
                body: notification.body,
                isRead: notification.isRead,
                metadata: (notification.metadata as Record<string, unknown>) ?? {},
                createdAt: notification.createdAt,
            })
        } catch {
            // Socket might not be initialized in tests — ignore
        }

        return notification
    }

    /**
     * Get all unread notifications for a user (most recent first, limit 50).
     */
    static async getUnread(userId: string) {
        return prisma.notification.findMany({
            where: { userId, isRead: false },
            orderBy: { createdAt: 'desc' },
            take: 50,
        })
    }

    /**
     * Get recent notifications for a user (read + unread).
     */
    static async getRecent(userId: string, limit = 20) {
        return prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: limit,
        })
    }

    static async markAsRead(notificationId: string, userId: string) {
        return prisma.notification.updateMany({
            where: { id: notificationId, userId },
            data: { isRead: true },
        })
    }

    static async markAllRead(userId: string) {
        return prisma.notification.updateMany({
            where: { userId, isRead: false },
            data: { isRead: true },
        })
    }

    /**
     * Push real-time wallet balance update to the user (dual-balance).
     */
    static pushWalletUpdate(userId: string, realBalance: number, bonusBalance: number) {
        try {
            const io = getIo()
            io.to(`user:${userId}`).emit('wallet:updated', { realBalance, bonusBalance })
        } catch {
            // Socket not initialized
        }
    }
}
