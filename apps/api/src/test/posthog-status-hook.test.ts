import { describe, it, expect, vi, beforeEach } from 'vitest'

const tx = vi.hoisted(() => ({
    user: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    accountStatusChange: { create: vi.fn(), findFirst: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
}))
vi.mock('../lib/prisma', () => ({
    default: {
        $transaction: vi.fn(async (fn: any) => fn(tx)),
        user: { findUnique: vi.fn() },
        accountStatusChange: { findMany: vi.fn().mockResolvedValue([]) },
    },
}))
const redisMock = vi.hoisted(() => ({
    get: vi.fn(),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
}))
vi.mock('../lib/redis', () => ({ default: redisMock }))
vi.mock('../services/notification.service', () => ({
    NotificationService: { create: vi.fn().mockResolvedValue({}) },
}))
vi.mock('../services/zarecash.service', () => ({
    ZareCashService: { syncPlayerFreeze: vi.fn().mockResolvedValue({ ok: true, skipped: false }) },
}))
const { captureEvent } = vi.hoisted(() => ({ captureEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/posthog', () => ({ captureEvent }))

import { AccountStatusService } from '../services/account-status.service'

beforeEach(() => {
    vi.clearAllMocks()
    tx.user.findUnique.mockResolvedValue({ accountStatus: 'ACTIVE', username: 'abebe' })
    tx.accountStatusChange.create.mockImplementation(async ({ data }: any) => ({ id: 'chg1', ...data }))
    tx.accountStatusChange.findFirst.mockResolvedValue({ id: 'existing' })
    redisMock.get.mockResolvedValue(null)
})

describe('AccountStatusService PostHog hook', () => {
    it('emits account_status_changed on a real transition', async () => {
        await AccountStatusService.restrict('user-1', {
            reason: 'duplicate receipts',
            category: 'RECEIPT_FRAUD',
            actorId: 'clerk-1',
            expiresAt: new Date('2026-10-01T00:00:00Z'),
        })
        expect(captureEvent).toHaveBeenCalledWith('user-1', 'account_status_changed', {
            from: 'ACTIVE',
            to: 'RESTRICTED',
            category: 'RECEIPT_FRAUD',
            has_expiry: true,
        })
    })

    it('stays silent when the status is unchanged', async () => {
        tx.user.findUnique.mockResolvedValue({ accountStatus: 'RESTRICTED', username: 'abebe' })
        await AccountStatusService.restrict('user-1', { reason: 'again', actorId: 'clerk-1' })
        expect(captureEvent).not.toHaveBeenCalled()
    })
})
