/**
 * The stranded-event pass is only worth anything if it actually RUNS. This file
 * covers the wiring: that it is scheduled on a real repeat pattern alongside the
 * nightly sweep, and that the worker dispatches to it by job name.
 *
 * `bullmq` is mocked so importing the worker module (which constructs a real
 * `Worker` at module load) never opens a live Redis connection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn() })),
  Job: class {},
}))

const { add } = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/queue', () => ({
  getQueue: () => ({ add }),
  QUEUE_NAMES: { ZARECASH_SWEEP: 'zarecash-sweep', ZARECASH_EVENT: 'zarecash-event' },
}))

const { sweepEvents, requeueStrandedEvents } = vi.hoisted(() => ({
  sweepEvents: vi.fn().mockResolvedValue({ scanned: 0, replayed: 0, pages: 1, truncated: false }),
  requeueStrandedEvents: vi.fn().mockResolvedValue({ found: 0, requeued: 0 }),
}))
vi.mock('../services/zarecash.service', () => ({
  ZareCashService: { sweepEvents, requeueStrandedEvents },
}))
vi.mock('../lib/sentry', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }))

import {
  scheduleZareCashSweep,
  processSweepJob,
  STRANDED_REQUEUE_JOB,
} from '../workers/zarecash-sweep.worker'

const ORIGINAL = { ...process.env }

describe('scheduleZareCashSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ZARECASH_ENABLED = 'true'
  })
  afterEach(() => { process.env = { ...ORIGINAL } })

  it('schedules a recurring stranded-event pass, not only the nightly sweep', async () => {
    // Final-review Critical 3. Without a periodic pass, an event whose worker
    // job died with processedAt null is never revisited by anything: the webhook
    // route answers 200 before processing so ZareCash never redelivers.
    await scheduleZareCashSweep()

    const names = add.mock.calls.map((c) => c[0])
    expect(names).toContain('sweep')
    expect(names).toContain(STRANDED_REQUEUE_JOB)
  })

  it('gives the stranded pass a repeat pattern far more frequent than nightly', async () => {
    await scheduleZareCashSweep()

    const strandedCall = add.mock.calls.find((c) => c[0] === STRANDED_REQUEUE_JOB)!
    const opts = strandedCall[2] as { repeat: { pattern: string }; jobId: string }
    // A player debited for a payout ZareCash refused must not wait until 3am.
    expect(opts.repeat.pattern).toBe('*/15 * * * *')
    expect(opts.jobId).toBe('zarecash-stranded-requeue')
  })

  it('keeps the nightly reconciliation sweep on its own schedule', async () => {
    await scheduleZareCashSweep()

    const sweepCall = add.mock.calls.find((c) => c[0] === 'sweep')!
    const opts = sweepCall[2] as { repeat: { pattern: string }; jobId: string }
    expect(opts.repeat.pattern).toBe('0 3 * * *')
    expect(opts.jobId).toBe('zarecash-nightly-sweep')
  })

  it('schedules nothing when ZareCash is disabled', async () => {
    process.env.ZARECASH_ENABLED = 'false'
    await scheduleZareCashSweep()
    expect(add).not.toHaveBeenCalled()
  })
})

describe('processSweepJob', () => {
  beforeEach(() => vi.clearAllMocks())

  it('runs the stranded pass for the stranded job name', async () => {
    await processSweepJob({ name: STRANDED_REQUEUE_JOB } as any)
    expect(requeueStrandedEvents).toHaveBeenCalled()
    expect(sweepEvents).not.toHaveBeenCalled()
  })

  it('runs the reconciliation sweep for the sweep job name', async () => {
    await processSweepJob({ name: 'sweep' } as any)
    expect(sweepEvents).toHaveBeenCalled()
    expect(requeueStrandedEvents).not.toHaveBeenCalled()
  })
})
