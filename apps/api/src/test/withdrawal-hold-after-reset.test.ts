/**
 * Withdrawal hold after a support-assisted password reset.
 *
 * AuthService.adminResetPassword hands a temporary password to whoever
 * convinced support they own the account. The web app sends that person to
 * the set-password page, but the api is what moves money: an impostor can skip
 * the web app and POST /wallet/withdraw directly, and a ZareCash-routed method
 * goes straight to the payout queue with no clerk in the loop. So the hold
 * lives in WalletService.requestWithdrawal, and it outlasts the password
 * change.
 *
 * A new file rather than withdrawal.service.test.ts, whose pre-existing
 * failures would bury these.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'

const { add } = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/queue', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/queue')>()
    return { ...actual, getQueue: () => ({ add }) }
})

import walletRoutes from '../routes/wallet/index'
import { mapErrorToResponse } from '../lib/error-handler'
import { AuthService } from '../services/auth.service'
import { WalletService, WITHDRAWAL_HOLD_AFTER_RESET_MS } from '../services/wallet.service'
import { clearMethodCache } from '../gateways/payment/zarecash/method-config'
import { prisma } from './setup'

const HOUR_MS = 60 * 60 * 1000
const ZC_METHOD = 'zc_hold_telebirr'
const MANUAL_METHOD = 'manual_hold_cbe'

let seq = 0
async function seedPlayer(data: { mustChangePassword?: boolean; passwordResetAt?: Date | null } = {}) {
    seq += 1
    return prisma.user.create({
        data: {
            username: `hold_p_${Date.now().toString(36)}${seq}`,
            phone: `+2519${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
            passwordHash: 'hashed:original-pass',
            role: 'PLAYER',
            wallet: { create: { realBalance: 1000 } },
            ...data,
        },
    })
}

function withdraw(userId: string, paymentMethod = MANUAL_METHOD) {
    return WalletService.requestWithdrawal(userId, { amount: 300, paymentMethod, accountNumber: '0912345678' })
}

/** Refused before anything moved: no debit, no row, nothing queued. */
async function expectUntouched(userId: string) {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } })
    expect(Number(wallet.realBalance)).toBe(1000)
    expect(await prisma.transaction.count({ where: { userId } })).toBe(0)
    expect(add).not.toHaveBeenCalled()
}

const HOLD = { statusCode: 403, code: 'withdrawal_hold_after_reset' }

beforeEach(async () => {
    vi.clearAllMocks()
    await prisma.paymentMethod.deleteMany({ where: { code: { in: [ZC_METHOD, MANUAL_METHOD] } } })
    await prisma.paymentMethod.createMany({
        data: [
            { code: ZC_METHOD, name: 'TeleBirr (ZareCash)', type: 'WITHDRAWAL', gateway: 'zarecash', gatewayMethodCode: 'telebirr' },
            { code: MANUAL_METHOD, name: 'CBE (manual)', type: 'WITHDRAWAL', gateway: 'manual' },
        ],
    })
    clearMethodCache()
})

afterEach(async () => {
    await prisma.paymentMethod.deleteMany({ where: { code: { in: [ZC_METHOD, MANUAL_METHOD] } } })
    clearMethodCache()
    // cleanDb() in setup.ts leaves the audit trail alone.
    await prisma.auditLog.deleteMany({ where: { action: 'user.password_reset' } })
})

describe('WalletService.requestWithdrawal after a password reset', () => {
    it('holds for 24 hours', () => {
        expect(WITHDRAWAL_HOLD_AFTER_RESET_MS).toBe(24 * HOUR_MS)
    })

    it('refuses while the account still has to change its temporary password', async () => {
        // Reset long ago, never changed: the flag alone is enough.
        const player = await seedPlayer({ mustChangePassword: true, passwordResetAt: new Date(Date.now() - 72 * HOUR_MS) })

        await expect(withdraw(player.id, ZC_METHOD)).rejects.toMatchObject(HOLD)
        await expectUntouched(player.id)
    })

    it('refuses within 24 hours of a reset even after the player chose a new password', async () => {
        const player = await seedPlayer()
        const admin = await prisma.user.create({
            data: { username: `hold_admin_${Date.now().toString(36)}`, passwordHash: 'hashed:staff', role: 'ADMIN' },
        })
        const { temporaryPassword } = await AuthService.adminResetPassword(player.id, admin.id)
        await AuthService.changePassword(player.id, { currentPassword: temporaryPassword, newPassword: 'chosen-by-player' })

        const row = await prisma.user.findUniqueOrThrow({ where: { id: player.id } })
        expect(row.mustChangePassword).toBe(false)

        await expect(withdraw(player.id)).rejects.toMatchObject(HOLD)
        await expect(withdraw(player.id, ZC_METHOD)).rejects.toMatchObject(HOLD)
        await expectUntouched(player.id)
    })

    it('still refuses just inside the window', async () => {
        const player = await seedPlayer({ passwordResetAt: new Date(Date.now() - 23 * HOUR_MS - 59 * 60_000) })

        await expect(withdraw(player.id)).rejects.toMatchObject(HOLD)
        await expectUntouched(player.id)
    })

    it('allows a withdrawal once 24 hours have passed since the reset', async () => {
        const player = await seedPlayer({ passwordResetAt: new Date(Date.now() - 24 * HOUR_MS - 60_000) })

        const tx = await withdraw(player.id, ZC_METHOD)

        expect(tx.status).toBe('PENDING_REVIEW')
        const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: player.id } })
        expect(Number(wallet.realBalance)).toBe(700)
        expect(add).toHaveBeenCalledWith('submit', expect.objectContaining({ transactionId: tx.id }), expect.any(Object))
    })
})

describe('POST /wallet/withdraw during the hold', () => {
    it('answers 403 with the code and a message the player can read', async () => {
        const player = await seedPlayer({ passwordResetAt: new Date(Date.now() - HOUR_MS) })
        const app = Fastify({ logger: false })
        app.setErrorHandler(mapErrorToResponse)
        app.decorate('authenticate', async (request: any) => {
            request.user = { id: player.id, role: 'PLAYER' }
        })
        app.decorate('requireActiveAccount', async () => {})
        await app.register(walletRoutes, { prefix: '/wallet' })
        await app.ready()

        const res = await app.inject({
            method: 'POST',
            url: '/wallet/withdraw',
            payload: { amount: 300, paymentMethod: MANUAL_METHOD, accountNumber: '0912345678' },
        })

        expect(res.statusCode).toBe(403)
        const body = res.json()
        expect(body.code).toBe('withdrawal_hold_after_reset')
        expect(body.message).toMatch(/24 hours/)
        await expectUntouched(player.id)
        await app.close()
    })
})
