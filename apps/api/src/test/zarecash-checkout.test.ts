import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    siteSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    paymentMethod: { findUnique: vi.fn() },
    zareCashCheckoutSession: {
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    transaction: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
  },
}))
const { createCheckoutSession, getCheckoutSession } = vi.hoisted(() => ({
  createCheckoutSession: vi.fn(),
  getCheckoutSession: vi.fn(),
}))
vi.mock('../gateways/payment/zarecash/client', () => ({
  zarecashClient: () => ({ createCheckoutSession, getCheckoutSession }),
}))
vi.mock('../gateways/payment/zarecash/config', () => ({ isZareCashEnabled: () => true }))

import prisma from '../lib/prisma'
import { ZareCashCheckoutService } from '../services/zarecash-checkout.service'
import { ZareCashError } from '../gateways/payment/zarecash/types'

const METHOD = {
  code: 'zarecash',
  name: 'ZareCash',
  type: 'DEPOSIT',
  enabled: true,
  gateway: 'zarecash',
  hostedCheckout: true,
}

const REMOTE = {
  id: 'cs_1',
  url: 'https://zc.test/pay/tok',
  status: 'open',
  amount: 500,
  playerRef: 'u1',
  expiresAt: '2026-08-27T08:23:00.609Z',
  depositId: null,
}

const SESSION = {
  id: 'local1',
  sessionId: 'cs_1',
  userId: 'u1',
  amount: '500',
  methodCode: 'zarecash',
  status: 'open',
  depositId: null,
  transactionId: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WEB_BASE_URL = 'https://site.test'
  ;(prisma as any).siteSetting.findUnique.mockResolvedValue(null)
  ;(prisma as any).paymentMethod.findUnique.mockResolvedValue(METHOD)
  ;(prisma as any).zareCashCheckoutSession.create.mockResolvedValue({ id: 'local1' })
  ;(prisma as any).zareCashCheckoutSession.findUnique.mockResolvedValue(null)
  ;(prisma as any).zareCashCheckoutSession.findMany.mockResolvedValue([])
  ;(prisma as any).zareCashCheckoutSession.updateMany.mockResolvedValue({ count: 0 })
  ;(prisma as any).transaction.findUnique.mockResolvedValue(null)
  ;(prisma as any).transaction.create.mockResolvedValue({ id: 'tx1' })
  createCheckoutSession.mockResolvedValue(REMOTE)
})

describe('ZareCashCheckoutService.createSession', () => {
  it('keys the call on our own row id and stores what ZareCash returns', async () => {
    const res = await ZareCashCheckoutService.createSession('u1', 500, 'zarecash')

    expect(createCheckoutSession).toHaveBeenCalledWith(
      { playerRef: 'u1', amount: 500, returnUrl: 'https://site.test/wallet' },
      'local1',
    )
    expect(res.url).toBe('https://zc.test/pay/tok')
    expect((prisma as any).zareCashCheckoutSession.update).toHaveBeenCalledWith({
      where: { id: 'local1' },
      data: {
        sessionId: 'cs_1',
        status: 'open',
        expiresAt: new Date('2026-08-27T08:23:00.609Z'),
      },
    })
  })

  it('creates no Transaction — an abandoned session must not reach the deposit queue', async () => {
    await ZareCashCheckoutService.createSession('u1', 500, 'zarecash')
    expect((prisma as any).transaction.create).not.toHaveBeenCalled()
  })

  it('rejects an amount below the site minimum before calling ZareCash', async () => {
    ;(prisma as any).siteSetting.findUnique.mockResolvedValue({ value: '200' })

    const err: any = await ZareCashCheckoutService.createSession('u1', 50, 'zarecash').catch((e) => e)

    expect(err.statusCode).toBe(400)
    expect(err.message).toMatch(/Minimum deposit/)
    expect(createCheckoutSession).not.toHaveBeenCalled()
  })

  it('refuses a method that is not hosted checkout', async () => {
    ;(prisma as any).paymentMethod.findUnique.mockResolvedValue({ ...METHOD, hostedCheckout: false })

    const err: any = await ZareCashCheckoutService.createSession('u1', 500, 'telebirr').catch((e) => e)

    expect(err.statusCode).toBe(400)
    expect(createCheckoutSession).not.toHaveBeenCalled()
  })

  it('refuses a disabled method', async () => {
    ;(prisma as any).paymentMethod.findUnique.mockResolvedValue({ ...METHOD, enabled: false })

    const err: any = await ZareCashCheckoutService.createSession('u1', 500, 'zarecash').catch((e) => e)

    expect(err.statusCode).toBe(400)
    expect(createCheckoutSession).not.toHaveBeenCalled()
  })

  it('turns a misconfigured returnUrl into a 503, not a player-facing 400', async () => {
    createCheckoutSession.mockRejectedValue(
      new ZareCashError({
        code: 'invalid_return_url',
        message: 'origin mismatch',
        status: 400,
        permanent: true,
      }),
    )

    const err: any = await ZareCashCheckoutService.createSession('u1', 500, 'zarecash').catch((e) => e)

    expect(err.statusCode).toBe(503)
  })
})

describe('ZareCashCheckoutService.claimDeposit', () => {
  it('creates a PENDING_REVIEW row carrying the routing marker, and credits nothing', async () => {
    ;(prisma as any).zareCashCheckoutSession.findUnique.mockResolvedValue({
      ...SESSION,
      depositId: 'dp_1',
    })

    const res = await ZareCashCheckoutService.claimDeposit('u1', 'dp_1')

    expect(res.transactionId).toBe('tx1')
    const created = (prisma as any).transaction.create.mock.calls[0][0].data
    expect(created).toMatchObject({
      userId: 'u1',
      type: 'DEPOSIT',
      status: 'PENDING_REVIEW',
      gateway: 'zarecash',
      gatewayRef: 'dp_1',
      note: 'zarecash',
    })
    expect(Number(created.amount)).toBe(500)
  })

  it('is idempotent — a second claim returns the existing row', async () => {
    ;(prisma as any).zareCashCheckoutSession.findUnique.mockResolvedValue({
      ...SESSION,
      depositId: 'dp_1',
      transactionId: 'tx1',
    })

    const res = await ZareCashCheckoutService.claimDeposit('u1', 'dp_1')

    expect(res.transactionId).toBe('tx1')
    expect((prisma as any).transaction.create).not.toHaveBeenCalled()
  })

  it('matches an unlinked session by asking ZareCash, not by picking the newest', async () => {
    ;(prisma as any).zareCashCheckoutSession.findMany.mockResolvedValue([
      { ...SESSION, id: 'newer', sessionId: 'cs_newer' },
      { ...SESSION, id: 'older', sessionId: 'cs_older' },
    ])
    getCheckoutSession.mockImplementation(async (id: string) =>
      id === 'cs_older'
        ? { ...REMOTE, id, status: 'submitted', depositId: 'dp_1' }
        : { ...REMOTE, id, status: 'open', depositId: null },
    )

    await ZareCashCheckoutService.claimDeposit('u1', 'dp_1')

    // The newest session is NOT the one this deposit belongs to.
    expect((prisma as any).zareCashCheckoutSession.update).toHaveBeenCalledWith({
      where: { id: 'older' },
      data: { depositId: 'dp_1', status: 'submitted' },
    })
  })

  it('404s on a depositId that belongs to another player', async () => {
    ;(prisma as any).zareCashCheckoutSession.findUnique.mockResolvedValue({
      ...SESSION,
      userId: 'someone-else',
      depositId: 'dp_1',
    })

    const err: any = await ZareCashCheckoutService.claimDeposit('u1', 'dp_1').catch((e) => e)

    expect(err.statusCode).toBe(404)
    expect((prisma as any).transaction.create).not.toHaveBeenCalled()
  })
})

describe('ZareCashCheckoutService.sweepSessions', () => {
  it('retires only sessions past the 24h receipt window', async () => {
    ;(prisma as any).zareCashCheckoutSession.updateMany.mockResolvedValue({ count: 3 })

    const res = await ZareCashCheckoutService.sweepSessions()

    const where = (prisma as any).zareCashCheckoutSession.updateMany.mock.calls[0][0].where
    expect(where.depositId).toBeNull()
    expect(where.expiresAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60 * 1000)
    expect(res.dead).toBe(3)
  })

  it('materialises a session ZareCash now reports a depositId for', async () => {
    ;(prisma as any).zareCashCheckoutSession.findMany.mockResolvedValue([SESSION])
    getCheckoutSession.mockResolvedValue({ ...REMOTE, status: 'submitted', depositId: 'dp_1' })

    const res = await ZareCashCheckoutService.sweepSessions()

    expect(res.linked).toBe(1)
    expect((prisma as any).transaction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ gatewayRef: 'dp_1' }) }),
    )
  })

  it('skips a session it cannot read rather than ending the pass', async () => {
    ;(prisma as any).zareCashCheckoutSession.findMany.mockResolvedValue([SESSION])
    getCheckoutSession.mockRejectedValue(new Error('boom'))

    const res = await ZareCashCheckoutService.sweepSessions()

    expect(res.linked).toBe(0)
    expect((prisma as any).transaction.create).not.toHaveBeenCalled()
  })
})

describe('checkout 503s name their cause', () => {
  it('tags a disabled gateway as gateway_disabled', async () => {
    vi.resetModules()
    vi.doMock('../gateways/payment/zarecash/config', () => ({ isZareCashEnabled: () => false }))
    const { ZareCashCheckoutService: Svc } = await import('../services/zarecash-checkout.service')

    const err: any = await Svc.createSession('u1', 500, 'zarecash').catch((e) => e)

    expect(err.statusCode).toBe(503)
    expect(err.code).toBe('gateway_disabled')
    vi.doUnmock('../gateways/payment/zarecash/config')
  })

  it('tags a rejected returnUrl as return_url_rejected', async () => {
    createCheckoutSession.mockRejectedValue(
      new ZareCashError({
        code: 'invalid_return_url',
        message: 'origin mismatch',
        status: 400,
        permanent: true,
      }),
    )

    const err: any = await ZareCashCheckoutService.createSession('u1', 500, 'zarecash').catch((e) => e)

    expect(err.statusCode).toBe(503)
    expect(err.code).toBe('return_url_rejected')
  })
})
