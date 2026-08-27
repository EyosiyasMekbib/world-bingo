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

const { create: notifyCreate } = vi.hoisted(() => ({ create: vi.fn().mockResolvedValue({}) }))
vi.mock('../services/notification.service', () => ({ NotificationService: { create: notifyCreate } }))

const { syncPlayerFreeze } = vi.hoisted(() => ({
  syncPlayerFreeze: vi.fn().mockResolvedValue({ ok: true, skipped: false }),
}))
vi.mock('../services/zarecash.service', () => ({ ZareCashService: { syncPlayerFreeze } }))

import prisma from '../lib/prisma'
import { AccountStatusService } from '../services/account-status.service'

const ACTOR = 'clerk-1'
const USER = 'user-1'

beforeEach(() => {
  vi.clearAllMocks()
  tx.user.findUnique.mockResolvedValue({ accountStatus: 'ACTIVE', username: 'abebe' })
  tx.accountStatusChange.create.mockImplementation(async ({ data }: any) => ({ id: 'chg1', ...data }))
  tx.accountStatusChange.findFirst.mockResolvedValue({ id: 'existing' })
  redisMock.get.mockResolvedValue(null)
})

describe('AccountStatusService.restrict', () => {
  it('sets the status, appends history and writes an audit row', async () => {
    const change: any = await AccountStatusService.restrict(USER, {
      reason: 'duplicate receipts',
      category: 'RECEIPT_FRAUD',
      actorId: ACTOR,
    })

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { accountStatus: 'RESTRICTED' },
    })
    expect(change).toMatchObject({
      from: 'ACTIVE',
      to: 'RESTRICTED',
      reason: 'duplicate receipts',
      category: 'RECEIPT_FRAUD',
      actorId: ACTOR,
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'account.restricted' }) }),
    )
  })

  it('mirrors the freeze upstream and notifies the player', async () => {
    await AccountStatusService.restrict(USER, { reason: 'under review', actorId: ACTOR })

    expect(syncPlayerFreeze).toHaveBeenCalledWith(USER, true, 'under review')
    expect(notifyCreate).toHaveBeenCalledWith(
      USER,
      'ACCOUNT_STATUS_CHANGED',
      expect.any(String),
      expect.any(String),
      { status: 'RESTRICTED' },
    )
  })

  it('drops both the status cache and the casino gateway cache', async () => {
    await AccountStatusService.restrict(USER, { reason: 'under review', actorId: ACTOR })

    const keys = redisMock.del.mock.calls[0]
    expect(keys).toContain('acct:status:user-1')
    expect(keys).toContain('tp:user:user1') // dashless id
    expect(keys).toContain('tp:user:abebe') // username
  })

  it('requires a reason', async () => {
    const err: any = await AccountStatusService.restrict(USER, { reason: '   ', actorId: ACTOR }).catch((e) => e)

    expect(err.statusCode).toBe(400)
    expect(tx.user.update).not.toHaveBeenCalled()
  })

  it('is a no-op when the account already holds that status', async () => {
    tx.user.findUnique.mockResolvedValue({ accountStatus: 'RESTRICTED', username: 'abebe' })

    const change: any = await AccountStatusService.restrict(USER, { reason: 'same again', actorId: ACTOR })

    expect(change).toEqual({ id: 'existing' })
    expect(tx.accountStatusChange.create).not.toHaveBeenCalled()
    expect(notifyCreate).not.toHaveBeenCalled()
    expect(syncPlayerFreeze).not.toHaveBeenCalled()
  })

  it('keeps the local suspension when the upstream mirror fails', async () => {
    syncPlayerFreeze.mockResolvedValue({ ok: false, skipped: false, error: 'upstream down' })

    await expect(
      AccountStatusService.suspend(USER, { reason: 'confirmed fraud', actorId: ACTOR }),
    ).resolves.toBeTruthy()

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { accountStatus: 'SUSPENDED' },
    })
  })

  it('404s on an account that does not exist', async () => {
    tx.user.findUnique.mockResolvedValue(null)

    const err: any = await AccountStatusService.restrict('nope', { reason: 'x y z', actorId: ACTOR }).catch((e) => e)

    expect(err.statusCode).toBe(404)
  })
})

describe('AccountStatusService.reinstate', () => {
  it('returns to ACTIVE and unfreezes upstream', async () => {
    tx.user.findUnique.mockResolvedValue({ accountStatus: 'SUSPENDED', username: 'abebe' })

    const change: any = await AccountStatusService.reinstate(USER, { reason: 'appeal upheld', actorId: ACTOR })

    expect(change).toMatchObject({ from: 'SUSPENDED', to: 'ACTIVE', expiresAt: null })
    expect(syncPlayerFreeze).toHaveBeenCalledWith(USER, false, 'appeal upheld')
  })
})

describe('AccountStatusService.current', () => {
  it('serves a cache hit without touching the database', async () => {
    redisMock.get.mockResolvedValue('RESTRICTED')

    expect(await AccountStatusService.current(USER)).toBe('RESTRICTED')
    expect((prisma as any).user.findUnique).not.toHaveBeenCalled()
  })

  it('falls back to the database when Redis throws', async () => {
    redisMock.get.mockRejectedValue(new Error('redis down'))
    ;(prisma as any).user.findUnique.mockResolvedValue({ accountStatus: 'ACTIVE' })

    expect(await AccountStatusService.current(USER)).toBe('ACTIVE')
  })

  it('returns null for an unknown account', async () => {
    ;(prisma as any).user.findUnique.mockResolvedValue(null)

    expect(await AccountStatusService.current('nope')).toBeNull()
  })
})

describe('AccountStatusService.findExpired', () => {
  it('ignores a stale expiry that a later reinstatement superseded', async () => {
    const old = new Date(Date.now() - 60_000)
    ;(prisma as any).accountStatusChange.findMany
      // the due rows
      .mockResolvedValueOnce([{ userId: USER, createdAt: old }])
      // newest row per candidate — a reinstatement, so nothing is due
      .mockResolvedValueOnce([
        { userId: USER, expiresAt: null, to: 'ACTIVE', createdAt: new Date() },
      ])

    expect(await AccountStatusService.findExpired()).toEqual([])
  })

  it('returns an account whose newest change is genuinely due', async () => {
    const old = new Date(Date.now() - 60_000)
    ;(prisma as any).accountStatusChange.findMany
      .mockResolvedValueOnce([{ userId: USER, createdAt: old }])
      .mockResolvedValueOnce([
        { userId: USER, expiresAt: old, to: 'RESTRICTED', createdAt: old },
      ])

    expect(await AccountStatusService.findExpired()).toEqual([USER])
  })
})

describe('the expiry pass', () => {
  it('lifts what is due and survives one that fails', async () => {
    vi.resetModules()
    const reinstate = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('gone'))
      .mockResolvedValueOnce({})
    vi.doMock('../services/account-status.service', () => ({
      AccountStatusService: {
        findExpired: vi.fn().mockResolvedValue(['a', 'b', 'c']),
        reinstate,
      },
    }))
    vi.doMock('bullmq', () => ({
      Worker: class { on() {} },
      Queue: class { add() { return Promise.resolve() } },
      Job: class {},
    }))

    const { processAccountStatusExpiry } = await import('../workers/account-status-expiry.worker')
    const result = await processAccountStatusExpiry()

    expect(result).toEqual({ lifted: 2, failed: 1 })
    expect(reinstate).toHaveBeenCalledTimes(3)
    expect(reinstate).toHaveBeenCalledWith('c', { reason: 'Restriction expired', actorId: null })
    vi.doUnmock('../services/account-status.service')
    vi.doUnmock('bullmq')
  })
})
