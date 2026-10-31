/**
 * What the Telegram support bot leaves behind on an account's recovery
 * paths, against the real test database.
 *
 * A self-serve reset hands out account access exactly like a support-assisted
 * one, so it leaves the same audit trail. And a support-assisted reset is
 * how a taken-over account is recovered, so it also drops whatever Telegram
 * chat was linked: otherwise the chat that did the takeover keeps /status
 * and every push.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { consumePasswordResetToken } = vi.hoisted(() => ({ consumePasswordResetToken: vi.fn() }))
vi.mock('../services/telegram/link.service', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/telegram/link.service')>()),
    consumePasswordResetToken,
}))
vi.mock('../lib/posthog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/posthog')>()),
    captureEvent: vi.fn().mockResolvedValue(undefined),
}))

import { AuthService } from '../services/auth.service'
import { prisma } from './setup'

let seq = 0
async function seedLinkedPlayer() {
    seq += 1
    return prisma.user.create({
        data: {
            username: `tg_rec_${Date.now().toString(36)}${seq}`,
            phone: `+2519${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
            passwordHash: 'hashed:original-pass',
            role: 'PLAYER',
            telegramChatId: `chat-${Date.now()}-${seq}`,
            telegramLinkedAt: new Date(),
        },
    })
}

describe('Telegram account recovery trail', () => {
    beforeEach(() => vi.clearAllMocks())

    it('a self-serve reset through the bot writes an audit row', async () => {
        const player = await seedLinkedPlayer()
        consumePasswordResetToken.mockResolvedValue(player.id)

        await AuthService.consumePasswordReset('tok', 'a-new-password-123')

        const rows = await prisma.auditLog.findMany({ where: { target: `user:${player.id}` } })
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ action: 'user.password_reset_self', actorId: player.id })
        expect(rows[0].detail).toMatchObject({ via: 'telegram' })
    })

    it('a support-assisted reset unlinks the Telegram chat', async () => {
        const player = await seedLinkedPlayer()

        await AuthService.adminResetPassword(player.id, 'admin-actor')

        const after = await prisma.user.findUniqueOrThrow({ where: { id: player.id } })
        expect(after.telegramChatId).toBeNull()
        expect(after.telegramLinkedAt).toBeNull()
    })
})
