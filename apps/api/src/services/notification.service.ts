import prisma from '../lib/prisma'
import { Prisma } from '@prisma/client'
import { NotificationType } from '@world-bingo/shared-types'
import { getIo } from '../lib/socket'
import { randomUUID } from 'node:crypto'

/** Rows inserted per round trip when a broadcast fans out to every player. */
const BROADCAST_BATCH_SIZE = 1000

/**
 * Who a broadcast reaches: every player account that may still act. Bots are
 * PLAYER rows too (BotService names them `bot_t<template>_<slot>`), so they are
 * excluded by that prefix. `username` is nullable (phone/Telegram sign-ups) and
 * a bare NOT would drop those rows, since NOT (NULL LIKE ...) is NULL in SQL.
 */
const BROADCAST_RECIPIENTS: Prisma.UserWhereInput = {
    role: 'PLAYER',
    accountStatus: { not: 'SUSPENDED' },
    OR: [{ username: null }, { NOT: { username: { startsWith: 'bot_t' } } }],
}

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
     * Send one announcement to every player: a notification row each (so it
     * sits in the bell until read, for players offline right now too) plus a
     * live `notification:new` push to each player's room.
     *
     * Walks users by id cursor in batches, so memory stays flat however large
     * the player base is. Ids are generated here because createMany does not
     * return them and the socket payload needs the id for mark-as-read.
     */
    static async broadcast(input: {
        title: string
        body: string
        sentById?: string | null
        sentByName?: string | null
    }) {
        const broadcast = await prisma.notificationBroadcast.create({
            data: {
                title: input.title,
                body: input.body,
                sentById: input.sentById ?? null,
                sentByName: input.sentByName ?? null,
            },
        })
        const metadata = { broadcastId: broadcast.id }

        let io: ReturnType<typeof getIo> | null = null
        try {
            io = getIo()
        } catch {
            // Socket might not be initialized in tests — rows are still written
        }

        let recipientCount = 0
        let cursor: string | undefined
        for (;;) {
            const users = await prisma.user.findMany({
                where: BROADCAST_RECIPIENTS,
                select: { id: true },
                orderBy: { id: 'asc' },
                take: BROADCAST_BATCH_SIZE,
                ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
            })
            if (users.length === 0) break

            const createdAt = new Date()
            const rows = users.map((u) => ({
                id: randomUUID(),
                userId: u.id,
                type: NotificationType.ANNOUNCEMENT,
                title: input.title,
                body: input.body,
                metadata,
                createdAt,
            }))
            await prisma.notification.createMany({ data: rows })
            recipientCount += rows.length

            for (const row of rows) {
                io?.to(`user:${row.userId}`).emit('notification:new', { ...row, isRead: false })
            }

            if (users.length < BROADCAST_BATCH_SIZE) break
            cursor = users[users.length - 1].id
        }

        return prisma.notificationBroadcast.update({
            where: { id: broadcast.id },
            data: { recipientCount },
        })
    }

    /** Most recent broadcasts first, for the admin history list. */
    static async listBroadcasts(limit = 50) {
        return prisma.notificationBroadcast.findMany({
            orderBy: { createdAt: 'desc' },
            take: limit,
        })
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
