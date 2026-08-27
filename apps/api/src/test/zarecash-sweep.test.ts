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
const { reportWarning } = vi.hoisted(() => ({ reportWarning: vi.fn() }))
vi.mock('../lib/sentry', () => ({ reportError: vi.fn(), reportWarning }))

import prisma from '../lib/prisma'
import { ZareCashService, ZareCashModeMismatchError } from '../services/zarecash.service'

/**
 * A faithful stand-in for paymentmgmtv2's GET /v1/events.
 *
 * The ordering here is the whole point of these tests. Upstream
 * (`v1.service.ts` listEvents) does:
 *
 *   orderBy: { createdAt: 'desc' },  take: limit + 1,
 *   ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
 *   nextCursor: hasMore ? page[page.length - 1].id : null
 *
 * So the page is NEWEST-FIRST and `nextCursor` is the id of the LAST row of the
 * page — the OLDEST one — which Prisma resumes *after*, still descending. A
 * cursor therefore walks BACKWARDS in time. Every previous test in this file
 * mocked `listEvents` as a flat value and never modelled that, which is exactly
 * why the backwards-walking sweep shipped looking healthy.
 */
function upstream(events: Array<{ id: string; type: string; created: number }>) {
  // Newest first, mirroring `orderBy: { createdAt: 'desc' }`.
  const ordered = [...events].sort((a, b) => b.created - a.created)
  return (params: { cursor?: string; limit?: number } = {}) => {
    const limit = params.limit ?? 100
    let start = 0
    if (params.cursor) {
      const at = ordered.findIndex((e) => e.id === params.cursor)
      if (at === -1) throw new Error(`cursor ${params.cursor} not found`)
      start = at + 1 // Prisma's `skip: 1` — resume AFTER the cursor row.
    }
    const slice = ordered.slice(start, start + limit + 1)
    const hasMore = slice.length > limit
    const page = hasMore ? slice.slice(0, limit) : slice
    return Promise.resolve({
      data: page.map((e) => ({ ...e, data: { id: `obj_${e.id}` } })),
      // The LAST row of the page — the OLDEST one.
      nextCursor: hasMore ? page[page.length - 1].id : null,
    })
  }
}

/** Every id the sweep enqueued, in order. */
function enqueued(): string[] {
  return add.mock.calls.map((c) => (c[1] as { eventId: string }).eventId)
}

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

  it('raises a typed error on mismatch so index.ts can tell it from any other boot failure', async () => {
    getFloat.mockResolvedValue({ mode: 'live', balance: 1, reserved: 0, available: 1, lowFloatThreshold: 0, queuedWithdrawals: 0 })
    await expect(ZareCashService.assertMode()).rejects.toBeInstanceOf(ZareCashModeMismatchError)
  })

  it('does not throw when ZareCash is unreachable — only a genuine mismatch is fatal', async () => {
    getFloat.mockRejectedValue(new Error('network error'))
    await expect(ZareCashService.assertMode()).resolves.toBeUndefined()
  })
})

describe('ZareCashService.sweepEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([])
  })

  // ── C1: the sweep must reach events created since the last run ─────────────

  it('scans an event created AFTER the previous run — the reconciliation sweep is not a backwards walk', async () => {
    // A REAL SiteSetting round-trip. Without this the mocked findUnique answers
    // undefined on every run, so even a cursor-persisting implementation restarts
    // from the newest page each time and the bug hides. The stored cursor has to
    // actually come back on the next run for this test to discriminate.
    let storedCursor: string | null = null
    ;(prisma as any).siteSetting.findUnique.mockImplementation(() =>
      Promise.resolve(storedCursor === null ? null : { key: 'zarecash_events_cursor', value: storedCursor }),
    )
    ;(prisma as any).siteSetting.upsert.mockImplementation(({ update }: any) => {
      storedCursor = update.value
      return Promise.resolve({})
    })

    // 250 historical events, so the first run cannot reach the end of history in
    // one page and a cursor-walking implementation parks deep in the past.
    const history = Array.from({ length: 250 }, (_, i) => ({
      id: `evt_old_${String(i).padStart(3, '0')}`,
      type: 'deposit.approved',
      created: i + 1,
    }))
    listEvents.mockImplementation(upstream(history))

    // Run 1: everything is new, so it records what it can.
    const first = await ZareCashService.sweepEvents()
    expect(first.scanned).toBeGreaterThan(0)
    const seenInRun1 = new Set(enqueued())

    // A brand-new event arrives while webhooks are down — created LATER than
    // everything above, so it sits at the very top of the newest page.
    const fresh = { id: 'evt_fresh', type: 'withdrawal.rejected', created: 9999 }
    listEvents.mockImplementation(upstream([...history, fresh]))
    add.mockClear() // only the enqueue spy — the cursor store must survive.

    // Run 1 recorded these; only `evt_fresh` is genuinely unseen.
    ;(prisma as any).zareCashEvent.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.id.in
          .filter((id: string) => seenInRun1.has(id))
          .map((id: string) => ({ id, processedAt: new Date() })),
      ),
    )

    const second = await ZareCashService.sweepEvents()

    // THE ASSERTION. With a persisted descending cursor, run 2 resumed after the
    // OLDEST row of run 1's page and walked further into the past — `evt_fresh`
    // was never even fetched, let alone replayed.
    expect(enqueued()).toContain('evt_fresh')
    expect(second.replayed).toBeGreaterThan(0)
  })

  it('never sends a cursor on the first page — each run starts from the newest events', async () => {
    listEvents.mockImplementation(upstream([{ id: 'evt_1', type: 'deposit.approved', created: 1 }]))
    await ZareCashService.sweepEvents()
    expect(listEvents.mock.calls[0][0]).toEqual({ cursor: undefined, limit: 100 })
  })

  it('does not persist a cursor between runs — the dead SiteSetting key is gone', async () => {
    listEvents.mockImplementation(upstream([{ id: 'evt_1', type: 'deposit.approved', created: 1 }]))
    await ZareCashService.sweepEvents()
    expect((prisma as any).siteSetting.upsert).not.toHaveBeenCalled()
    expect((prisma as any).siteSetting.findUnique).not.toHaveBeenCalled()
  })

  // ── M7: a backlog bigger than one page must drain ──────────────────────────

  it('pages forward within a single run so a backlog larger than one page drains', async () => {
    const backlog = Array.from({ length: 250 }, (_, i) => ({
      id: `evt_${String(i).padStart(3, '0')}`,
      type: 'deposit.approved',
      created: i + 1,
    }))
    listEvents.mockImplementation(upstream(backlog))

    const result = await ZareCashService.sweepEvents()

    // One page per run capped this at 100; all 250 must now be replayed.
    expect(result.scanned).toBe(250)
    expect(result.replayed).toBe(250)
    expect(result.pages).toBe(3)
    expect(result.truncated).toBe(false)
    expect(new Set(enqueued()).size).toBe(250)
  })

  it('stops at the first fully-processed page — a healthy day costs exactly one page', async () => {
    const events = Array.from({ length: 250 }, (_, i) => ({
      id: `evt_${String(i).padStart(3, '0')}`,
      type: 'deposit.approved',
      created: i + 1,
    }))
    listEvents.mockImplementation(upstream(events))
    // Everything is already recorded and processed.
    ;(prisma as any).zareCashEvent.findMany.mockImplementation(({ where }: any) =>
      Promise.resolve(where.id.in.map((id: string) => ({ id, processedAt: new Date() }))),
    )

    const result = await ZareCashService.sweepEvents()

    expect(result.pages).toBe(1)
    expect(result.replayed).toBe(0)
    expect(add).not.toHaveBeenCalled()
  })

  it('stops loudly at the page budget instead of truncating in silence', async () => {
    const huge = Array.from({ length: 100 * 25 }, (_, i) => ({
      id: `evt_${String(i).padStart(4, '0')}`,
      type: 'deposit.approved',
      created: i + 1,
    }))
    listEvents.mockImplementation(upstream(huge))

    const result = await ZareCashService.sweepEvents()

    expect(result.truncated).toBe(true)
    expect(result.pages).toBe(20)
    expect(reportWarning).toHaveBeenCalledWith(
      expect.stringContaining('page budget'),
      expect.objectContaining({ phase: 'zarecash-sweep-truncated' }),
    )
  })

  // ── dedup behaviour carried over from the original suite ───────────────────

  it('inserts and enqueues only events we have never seen', async () => {
    listEvents.mockImplementation(
      upstream([
        { id: 'evt_1', type: 'deposit.approved', created: 1 },
        { id: 'evt_2', type: 'deposit.rejected', created: 2 },
      ]),
    )
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([{ id: 'evt_1', processedAt: new Date() }])

    const result = await ZareCashService.sweepEvents()

    expect(result.scanned).toBe(2)
    expect(result.replayed).toBe(1)
    expect((prisma as any).zareCashEvent.create).toHaveBeenCalledTimes(1)
    expect((prisma as any).zareCashEvent.create).toHaveBeenCalledWith({
      data: { id: 'evt_2', type: 'deposit.rejected', payload: expect.objectContaining({ id: 'evt_2' }) },
    })
    expect(enqueued()).toEqual(['evt_2'])
  })

  it('re-enqueues a known-but-unprocessed event without inserting a duplicate', async () => {
    listEvents.mockImplementation(upstream([{ id: 'evt_1', type: 'deposit.approved', created: 1 }]))
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([{ id: 'evt_1', processedAt: null }])

    const result = await ZareCashService.sweepEvents()

    expect(result.replayed).toBe(1)
    expect((prisma as any).zareCashEvent.create).not.toHaveBeenCalled()
    expect(enqueued()).toEqual(['evt_1'])
  })

  it('skips a known-and-processed event entirely — no insert, no enqueue', async () => {
    listEvents.mockImplementation(upstream([{ id: 'evt_1', type: 'deposit.approved', created: 1 }]))
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([{ id: 'evt_1', processedAt: new Date() }])

    const result = await ZareCashService.sweepEvents()

    expect(result.replayed).toBe(0)
    expect((prisma as any).zareCashEvent.create).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
  })

  it('a P2002 on insert does not abort the sweep — later events in the page still process', async () => {
    listEvents.mockImplementation(
      upstream([
        { id: 'evt_1', type: 'deposit.approved', created: 2 },
        { id: 'evt_2', type: 'deposit.rejected', created: 1 },
      ]),
    )
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([])
    const p2002 = Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002' })
    ;(prisma as any).zareCashEvent.create.mockRejectedValueOnce(p2002).mockResolvedValueOnce({})
    ;(prisma as any).zareCashEvent.findUnique.mockResolvedValue({ processedAt: null })

    const result = await ZareCashService.sweepEvents()

    expect(result.replayed).toBe(2)
    expect((prisma as any).zareCashEvent.create).toHaveBeenCalledTimes(2)
    expect(enqueued().sort()).toEqual(['evt_1', 'evt_2'])
  })
})

describe('ZareCashService.requeueStrandedEvents', () => {
  beforeEach(() => vi.clearAllMocks())

  it('re-enqueues events left at processedAt = null — nothing else ever revisits them', async () => {
    const receivedAt = new Date(Date.now() - 60 * 60 * 1000)
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([
      { id: 'evt_stuck', type: 'withdrawal.rejected', error: 'connection closed', receivedAt },
    ])

    const result = await ZareCashService.requeueStrandedEvents()

    expect(result).toEqual({ found: 1, requeued: 1 })
    expect(add).toHaveBeenCalledWith('process', { eventId: 'evt_stuck' })
  })

  it('only considers unprocessed events older than the in-flight grace window', async () => {
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([])

    await ZareCashService.requeueStrandedEvents()

    const where = (prisma as any).zareCashEvent.findMany.mock.calls[0][0].where
    expect(where.processedAt).toBeNull()
    expect(where.receivedAt.lt).toBeInstanceOf(Date)
    expect(where.receivedAt.lt.getTime()).toBeLessThan(Date.now())
  })

  it('is a silent no-op when nothing is stranded', async () => {
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([])
    const result = await ZareCashService.requeueStrandedEvents()
    expect(result).toEqual({ found: 0, requeued: 0 })
    expect(add).not.toHaveBeenCalled()
    expect(reportWarning).not.toHaveBeenCalled()
  })

  it('bounds the query so a huge backlog cannot pin the worker', async () => {
    ;(prisma as any).zareCashEvent.findMany.mockResolvedValue([])
    await ZareCashService.requeueStrandedEvents(50)
    expect((prisma as any).zareCashEvent.findMany.mock.calls[0][0].take).toBe(50)
  })
})
