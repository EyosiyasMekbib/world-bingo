import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
  default: {
    zareCashEvent: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn().mockResolvedValue({}) },
    siteSetting: { findUnique: vi.fn(), upsert: vi.fn().mockResolvedValue({}) },
  },
}))
const { listEvents, getFloat } = vi.hoisted(() => ({ listEvents: vi.fn(), getFloat: vi.fn() }))
vi.mock('../gateways/payment/zarecash/client', () => ({ zarecashClient: () => ({ listEvents, getFloat }) }))
const { add } = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/queue', () => ({
  getQueue: () => ({ add }),
  QUEUE_NAMES: { ZARECASH_EVENT: 'zarecash-event', ZARECASH_SWEEP: 'zarecash-sweep' },
}))

import prisma from '../lib/prisma'
import { ZareCashService } from '../services/zarecash.service'

describe('ZareCashService.assertMode', () => {
  const ORIGINAL = { ...process.env }
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ZARECASH_ENABLED = 'true'
    process.env.ZARECASH_API_KEY = 'pk_test_ABC'
    process.env.ZARECASH_WEBHOOK_SECRET = 'whsec'
    process.env.ZARECASH_MODE = 'test'
  })
  afterEach(() => { process.env = { ...ORIGINAL } })

  it('passes when the remote mode matches', async () => {
    getFloat.mockResolvedValue({ mode: 'test', balance: 1, reserved: 0, available: 1, lowFloatThreshold: 0, queuedWithdrawals: 0 })
    await expect(ZareCashService.assertMode()).resolves.toBeUndefined()
  })

  it('throws when a live key is configured as test', async () => {
    getFloat.mockResolvedValue({ mode: 'live', balance: 1, reserved: 0, available: 1, lowFloatThreshold: 0, queuedWithdrawals: 0 })
    await expect(ZareCashService.assertMode()).rejects.toThrow(/mode mismatch/i)
  })

  it('does not throw when ZareCash is unreachable — only a genuine mismatch is fatal', async () => {
    getFloat.mockRejectedValue(new Error('network error'))
    await expect(ZareCashService.assertMode()).resolves.toBeUndefined()
  })
})

describe('ZareCashService.sweepEvents', () => {
  beforeEach(() => vi.clearAllMocks())

  it('inserts and enqueues only events we have never seen', async () => {
    ;(prisma as any).siteSetting.findUnique.mockResolvedValue(null)
    listEvents.mockResolvedValue({
      data: [
        { id: 'evt_1', type: 'deposit.approved', created: 1, data: { id: 'dp_1' } },
        { id: 'evt_2', type: 'deposit.rejected', created: 2, data: { id: 'dp_2' } },
      ],
      nextCursor: null,
    })
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([{ id: 'evt_1', processedAt: new Date() }])

    const result = await ZareCashService.sweepEvents()

    expect(result).toEqual({ scanned: 2, replayed: 1 })
    expect((prisma as any).zareCashEvent.create).toHaveBeenCalledTimes(1)
    expect((prisma as any).zareCashEvent.create).toHaveBeenCalledWith({
      data: { id: 'evt_2', type: 'deposit.rejected', payload: expect.objectContaining({ id: 'evt_2' }) },
    })
    expect(add).toHaveBeenCalledWith('process', { eventId: 'evt_2' })
  })

  it('re-enqueues a known-but-unprocessed event without inserting a duplicate', async () => {
    // Simulates a row a previous sweep (or webhook delivery) inserted but never
    // got to enqueue — e.g. a transient Redis blip right after the create. The
    // row exists, so an existence-only dedup would skip it forever.
    ;(prisma as any).siteSetting.findUnique.mockResolvedValue(null)
    listEvents.mockResolvedValue({
      data: [{ id: 'evt_1', type: 'deposit.approved', created: 1, data: { id: 'dp_1' } }],
      nextCursor: null,
    })
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([{ id: 'evt_1', processedAt: null }])

    const result = await ZareCashService.sweepEvents()

    expect(result).toEqual({ scanned: 1, replayed: 1 })
    expect((prisma as any).zareCashEvent.create).not.toHaveBeenCalled()
    expect(add).toHaveBeenCalledWith('process', { eventId: 'evt_1' })
  })

  it('skips a known-and-processed event entirely — no insert, no enqueue', async () => {
    ;(prisma as any).siteSetting.findUnique.mockResolvedValue(null)
    listEvents.mockResolvedValue({
      data: [{ id: 'evt_1', type: 'deposit.approved', created: 1, data: { id: 'dp_1' } }],
      nextCursor: null,
    })
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([{ id: 'evt_1', processedAt: new Date() }])

    const result = await ZareCashService.sweepEvents()

    expect(result).toEqual({ scanned: 1, replayed: 0 })
    expect((prisma as any).zareCashEvent.create).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
  })

  it('a P2002 on insert does not abort the sweep — later events in the page still process', async () => {
    // A webhook delivery (or an overlapping sweep) can insert the same id
    // between our findMany snapshot and this create call. That must not blow
    // up the whole page — it must be handled exactly like the known-row case.
    ;(prisma as any).siteSetting.findUnique.mockResolvedValue(null)
    listEvents.mockResolvedValue({
      data: [
        { id: 'evt_1', type: 'deposit.approved', created: 1, data: { id: 'dp_1' } },
        { id: 'evt_2', type: 'deposit.rejected', created: 2, data: { id: 'dp_2' } },
      ],
      nextCursor: null,
    })
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([])
    const p2002 = Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002' })
    ;(prisma as any).zareCashEvent.create.mockRejectedValueOnce(p2002).mockResolvedValueOnce({})
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue({ processedAt: null })

    const result = await ZareCashService.sweepEvents()

    expect(result).toEqual({ scanned: 2, replayed: 2 })
    expect((prisma as any).zareCashEvent.create).toHaveBeenCalledTimes(2)
    expect(add).toHaveBeenCalledWith('process', { eventId: 'evt_1' })
    expect(add).toHaveBeenCalledWith('process', { eventId: 'evt_2' })
  })

  it('stores the cursor for the next run', async () => {
    ;(prisma as any).siteSetting.findUnique.mockResolvedValue(null)
    listEvents.mockResolvedValue({ data: [], nextCursor: 'cur_42' })
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([])

    await ZareCashService.sweepEvents()

    expect((prisma as any).siteSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'zarecash_events_cursor' },
      create: { key: 'zarecash_events_cursor', value: 'cur_42' },
      update: { value: 'cur_42' },
    })
  })

  it('resumes from the stored cursor', async () => {
    ;(prisma as any).siteSetting.findUnique.mockResolvedValue({ key: 'zarecash_events_cursor', value: 'cur_7' })
    listEvents.mockResolvedValue({ data: [], nextCursor: null })
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([])

    await ZareCashService.sweepEvents()

    expect(listEvents).toHaveBeenCalledWith({ cursor: 'cur_7', limit: 100 })
  })
})
