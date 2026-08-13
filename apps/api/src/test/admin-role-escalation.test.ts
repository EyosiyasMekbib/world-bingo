import { describe, it, expect, beforeEach } from 'vitest'
import { AdminService } from '../services/admin.service'
import { prisma } from './setup'

/**
 * Privilege-escalation guard.
 *
 * `updateUserRole` historically guarded only the TARGET'S CURRENT role, so an
 * ADMIN could promote any account — including one they control — to SUPER_ADMIN
 * and use it to satisfy any four-eyes / separation-of-duties check. SUPER_ADMIN
 * must never be reachable through the API; it is seed/DB-provisioned only.
 */
describe('AdminService.updateUserRole — SUPER_ADMIN is not an assignable role', () => {
    let playerId: string

    beforeEach(async () => {
        const player = await prisma.user.create({
            data: {
                username: 'escalation_target',
                phone: '+251900400001',
                passwordHash: 'hashed:pass',
                role: 'PLAYER',
            },
        })
        playerId = player.id
    })

    it('refuses to promote a player to SUPER_ADMIN', async () => {
        await expect(AdminService.updateUserRole(playerId, 'SUPER_ADMIN' as any)).rejects.toThrow(
            /SUPER_ADMIN/i,
        )

        const after = await prisma.user.findUnique({ where: { id: playerId } })
        expect(after?.role).toBe('PLAYER')
    })

    it('refuses to promote an existing ADMIN to SUPER_ADMIN', async () => {
        await prisma.user.update({ where: { id: playerId }, data: { role: 'ADMIN' } })

        await expect(AdminService.updateUserRole(playerId, 'SUPER_ADMIN' as any)).rejects.toThrow(
            /SUPER_ADMIN/i,
        )

        const after = await prisma.user.findUnique({ where: { id: playerId } })
        expect(after?.role).toBe('ADMIN')
    })

    it('still refuses to change the role of an existing SUPER_ADMIN', async () => {
        const root = await prisma.user.create({
            data: {
                username: 'existing_super_admin',
                phone: '+251900400002',
                passwordHash: 'hashed:pass',
                role: 'SUPER_ADMIN',
            },
        })

        await expect(AdminService.updateUserRole(root.id, 'PLAYER' as any)).rejects.toThrow(
            /SUPER_ADMIN/i,
        )

        const after = await prisma.user.findUnique({ where: { id: root.id } })
        expect(after?.role).toBe('SUPER_ADMIN')
    })

    it('still allows legitimate PLAYER → ADMIN promotion', async () => {
        const updated = await AdminService.updateUserRole(playerId, 'ADMIN' as any)

        expect(updated.role).toBe('ADMIN')
    })

    it('still allows legitimate ADMIN → PLAYER demotion', async () => {
        await prisma.user.update({ where: { id: playerId }, data: { role: 'ADMIN' } })

        const updated = await AdminService.updateUserRole(playerId, 'PLAYER' as any)

        expect(updated.role).toBe('PLAYER')
    })
})
