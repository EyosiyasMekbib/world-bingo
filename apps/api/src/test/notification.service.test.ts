import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NotificationService } from '../services/notification.service'
import { prisma } from './setup'
import { NotificationType } from '@world-bingo/shared-types'

// Mock socket.io to avoid initialization errors in tests
vi.mock('../lib/socket', () => ({
    getIo: () => ({
        to: () => ({
            emit: vi.fn(),
        }),
    }),
}))

describe('NotificationService (T17/T20)', () => {
    let testUserId: string

    beforeEach(async () => {
        const user = await prisma.user.create({
            data: {
                username: 'notif_test_user',
                phone: '+251900200001',
                passwordHash: 'hashed:testpass',
                wallet: { create: { balance: 0 } },
            },
        })
        testUserId = user.id
    })

    describe('create', () => {
        it('should create a notification in the database', async () => {
            const notif = await NotificationService.create(
                testUserId,
                NotificationType.DEPOSIT_APPROVED,
                'Deposit Approved',
                'Your deposit of 500 ETB has been approved.',
                { transactionId: 'tx-abc' },
            )

            expect(notif.id).toBeDefined()
            expect(notif.userId).toBe(testUserId)
            expect(notif.type).toBe(NotificationType.DEPOSIT_APPROVED)
            expect(notif.title).toBe('Deposit Approved')
            expect(notif.body).toContain('500 ETB')
            expect(notif.isRead).toBe(false)
        })

        it('should store metadata as JSON', async () => {
            const notif = await NotificationService.create(
                testUserId,
                NotificationType.GAME_WON,
                'You Won!',
                'You won 900 ETB!',
                { gameId: 'game-123', prize: 900 },
            )

            const stored = await prisma.notification.findUnique({ where: { id: notif.id } })
            const metadata = stored?.metadata as Record<string, unknown>
            expect(metadata.gameId).toBe('game-123')
            expect(metadata.prize).toBe(900)
        })
    })

    describe('getUnread', () => {
        it('should return only unread notifications', async () => {
            await NotificationService.create(testUserId, NotificationType.DEPOSIT_APPROVED, 'A', 'Body A')
            await NotificationService.create(testUserId, NotificationType.GAME_STARTING, 'B', 'Body B')

            // Mark one as read
            const all = await prisma.notification.findMany({ where: { userId: testUserId } })
            await NotificationService.markAsRead(all[0].id, testUserId)

            const unread = await NotificationService.getUnread(testUserId)
            expect(unread.length).toBe(1)
            expect(unread[0].isRead).toBe(false)
        })

        it('should order by most recent first', async () => {
            await NotificationService.create(testUserId, NotificationType.DEPOSIT_APPROVED, 'First', 'Body')
            // Small delay to ensure different timestamps
            await new Promise(resolve => setTimeout(resolve, 50))
            const n2 = await NotificationService.create(testUserId, NotificationType.GAME_WON, 'Second', 'Body')

            const unread = await NotificationService.getUnread(testUserId)
            expect(unread[0].id).toBe(n2.id)
        })
    })

    describe('markAsRead', () => {
        it('should mark a specific notification as read', async () => {
            const notif = await NotificationService.create(
                testUserId,
                NotificationType.WITHDRAWAL_PROCESSED,
                'Withdrawal Done',
                'Your 100 ETB withdrawal is complete.',
            )

            await NotificationService.markAsRead(notif.id, testUserId)

            const updated = await prisma.notification.findUnique({ where: { id: notif.id } })
            expect(updated?.isRead).toBe(true)
        })

        it('should not mark other users\' notifications', async () => {
            const otherUser = await prisma.user.create({
                data: {
                    username: 'notif_other',
                    phone: '+251900200002',
                    passwordHash: 'hashed:pass2',
                    wallet: { create: { balance: 0 } },
                },
            })

            const notif = await NotificationService.create(
                otherUser.id,
                NotificationType.DEPOSIT_APPROVED,
                'Other',
                'Body',
            )

            // Try to mark it as read with testUserId (should not affect it)
            await NotificationService.markAsRead(notif.id, testUserId)

            const unchanged = await prisma.notification.findUnique({ where: { id: notif.id } })
            expect(unchanged?.isRead).toBe(false)
        })
    })

    describe('markAllRead', () => {
        it('should mark all unread notifications as read for a user', async () => {
            await NotificationService.create(testUserId, NotificationType.DEPOSIT_APPROVED, 'A', 'Body')
            await NotificationService.create(testUserId, NotificationType.GAME_WON, 'B', 'Body')
            await NotificationService.create(testUserId, NotificationType.REFUND_PROCESSED, 'C', 'Body')

            await NotificationService.markAllRead(testUserId)

            const unread = await NotificationService.getUnread(testUserId)
            expect(unread.length).toBe(0)
        })
    })

    describe('getRecent', () => {
        it('should return both read and unread notifications', async () => {
            const n1 = await NotificationService.create(testUserId, NotificationType.DEPOSIT_APPROVED, 'A', 'Body')
            await NotificationService.create(testUserId, NotificationType.GAME_WON, 'B', 'Body')
            await NotificationService.markAsRead(n1.id, testUserId)

            const recent = await NotificationService.getRecent(testUserId, 10)
            expect(recent.length).toBe(2)
        })

        it('should respect the limit parameter', async () => {
            for (let i = 0; i < 5; i++) {
                await NotificationService.create(testUserId, NotificationType.GAME_STARTING, `N${i}`, 'Body')
            }

            const limited = await NotificationService.getRecent(testUserId, 3)
            expect(limited.length).toBe(3)
        })
    })
})
