/**
 * Unit coverage for the zarecash-withdrawal worker's `failed` handler
 * (handleWithdrawalFailure) — the terminal-refund decision that runs after
 * BullMQ exhausts retries.
 *
 * `bullmq` is mocked so importing the worker module (which constructs a real
 * `Worker` at module load) never opens a live Redis connection — this mirrors
 * how the rest of this codebase's worker tests avoid importing worker modules
 * by testing the underlying service directly; this handler has no separate
 * service to delegate to, so it is exported and imported here instead.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn() })),
  Job: class {},
}))

const { rejectWithdrawal } = vi.hoisted(() => ({ rejectWithdrawal: vi.fn().mockResolvedValue({}) }))
vi.mock('../services/wallet.service', () => ({
  WalletService: { rejectWithdrawal },
}))

vi.mock('../services/zarecash.service', () => ({
  ZareCashService: { submitWithdrawal: vi.fn() },
}))

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }))
vi.mock('../lib/sentry', () => ({ reportError, reportWarning: vi.fn() }))

const { add } = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/queue')>()
  return { ...actual, getQueue: () => ({ add }) }
})

import {
  handleWithdrawalFailure,
  processWithdrawalJob,
  TERMINAL_REFUND_JOB,
  ZareCashWithdrawalJobData,
} from '../workers/zarecash-withdrawal.worker'
import { ZareCashService } from '../services/zarecash.service'
import { ZareCashError } from '../gateways/payment/zarecash/types'
import { ZARECASH_WITHDRAWAL_ATTEMPTS } from '../lib/queue'
import type { Job } from 'bullmq'

function makeJob(overrides: {
  attemptsMade: number
  attempts: number | undefined
  transactionId?: string
  sawWithdrawalPending?: boolean
  name?: string
  updateData?: (d: unknown) => Promise<void>
}): Job<ZareCashWithdrawalJobData> {
  return {
    id: 'job1',
    name: overrides.name ?? 'submit',
    data: {
      transactionId: overrides.transactionId ?? 'tx1',
      methodCode: 'telebirr',
      destinationAccount: '0912345678',
      ...(overrides.sawWithdrawalPending ? { sawWithdrawalPending: true } : {}),
    },
    attemptsMade: overrides.attemptsMade,
    opts: { attempts: overrides.attempts },
    updateData: overrides.updateData ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<ZareCashWithdrawalJobData>
}

const NETWORK_ERROR = () =>
  new ZareCashError({ code: 'network_error', message: 'ECONNREFUSED', status: 0, permanent: false })
const WITHDRAWAL_PENDING = () =>
  new ZareCashError({ code: 'withdrawal_pending', message: 'open payout', status: 409, permanent: false })

describe('zarecash-withdrawal worker — handleWithdrawalFailure', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does NOT refund when withdrawal_pending exhausts retries — a payout may be in flight', async () => {
    const job = makeJob({ attemptsMade: ZARECASH_WITHDRAWAL_ATTEMPTS, attempts: ZARECASH_WITHDRAWAL_ATTEMPTS })
    await handleWithdrawalFailure(job, WITHDRAWAL_PENDING())
    expect(rejectWithdrawal).not.toHaveBeenCalled()
  })

  it('DOES refund when a network_error exhausts retries — a genuine inability to reach ZareCash', async () => {
    const job = makeJob({ attemptsMade: ZARECASH_WITHDRAWAL_ATTEMPTS, attempts: ZARECASH_WITHDRAWAL_ATTEMPTS })
    await handleWithdrawalFailure(job, NETWORK_ERROR())
    expect(rejectWithdrawal).toHaveBeenCalledWith(
      'tx1',
      expect.stringContaining(`${ZARECASH_WITHDRAWAL_ATTEMPTS} attempts`),
    )
  })

  it('does not refund before retries are exhausted', async () => {
    const job = makeJob({ attemptsMade: ZARECASH_WITHDRAWAL_ATTEMPTS - 1, attempts: ZARECASH_WITHDRAWAL_ATTEMPTS })
    await handleWithdrawalFailure(job, NETWORK_ERROR())
    expect(rejectWithdrawal).not.toHaveBeenCalled()
  })

  it('compares attemptsMade against job.opts.attempts — the value BullMQ actually used on this job, not a locally hardcoded number', async () => {
    // Enqueued with a non-default budget (5). The handler must exhaust at 5, not
    // at ZARECASH_WITHDRAWAL_ATTEMPTS (8) — proving it reads job.opts.attempts.
    const notYetExhausted = makeJob({ attemptsMade: 5, attempts: 8 })
    await handleWithdrawalFailure(notYetExhausted, NETWORK_ERROR())
    expect(rejectWithdrawal).not.toHaveBeenCalled()

    const exhaustedAtFive = makeJob({ attemptsMade: 5, attempts: 5 })
    await handleWithdrawalFailure(exhaustedAtFive, NETWORK_ERROR())
    expect(rejectWithdrawal).toHaveBeenCalledTimes(1)
  })

  it('falls back to attempts=1 (not the full budget) when job.opts.attempts is missing, so the refund still fires', async () => {
    // If attempts were ever absent, BullMQ itself would have run exactly one
    // attempt. The fallback must match that (1), not silently wait for 8 — the
    // wrong-direction fallback would suppress the refund forever.
    const job = makeJob({ attemptsMade: 1, attempts: undefined })
    await handleWithdrawalFailure(job, NETWORK_ERROR())
    expect(rejectWithdrawal).toHaveBeenCalledWith('tx1', expect.any(String))
  })

  it('is a no-op when there is no job', async () => {
    await handleWithdrawalFailure(undefined, NETWORK_ERROR())
    expect(rejectWithdrawal).not.toHaveBeenCalled()
  })

  it('withdrawal_pending never refunds, at any attempts value or exhaustion point', async () => {
    const notYetExhausted = makeJob({ attemptsMade: 1, attempts: ZARECASH_WITHDRAWAL_ATTEMPTS })
    await handleWithdrawalFailure(notYetExhausted, WITHDRAWAL_PENDING())
    expect(rejectWithdrawal).not.toHaveBeenCalled()

    const exhausted = makeJob({ attemptsMade: ZARECASH_WITHDRAWAL_ATTEMPTS, attempts: ZARECASH_WITHDRAWAL_ATTEMPTS })
    await handleWithdrawalFailure(exhausted, WITHDRAWAL_PENDING())
    expect(rejectWithdrawal).not.toHaveBeenCalled()
  })

  // ── Final-review Important 5: the marker must survive the attempt ──────────

  it('does NOT refund when an earlier attempt saw withdrawal_pending, even though the FINAL error is a network error', async () => {
    // Seven attempts of 409 withdrawal_pending, then one network_error on the
    // last. Gating on the final error alone refunds here — refunding a payout
    // ZareCash has genuinely open, which is the exact double-pay this gate
    // exists to prevent. Network errors are common during precisely the
    // provider trouble that produces state disagreement.
    const job = makeJob({
      attemptsMade: ZARECASH_WITHDRAWAL_ATTEMPTS,
      attempts: ZARECASH_WITHDRAWAL_ATTEMPTS,
      sawWithdrawalPending: true,
    })

    await handleWithdrawalFailure(job, NETWORK_ERROR())

    expect(rejectWithdrawal).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: 'withdrawal-pending-exhausted', stickyMarker: true }),
    )
  })

  it('sets the sticky marker on the job the first time an attempt sees withdrawal_pending', async () => {
    const updateData = vi.fn().mockResolvedValue(undefined)
    const job = makeJob({ attemptsMade: 1, attempts: ZARECASH_WITHDRAWAL_ATTEMPTS, updateData })
    vi.spyOn(ZareCashService, 'submitWithdrawal').mockRejectedValueOnce(WITHDRAWAL_PENDING())

    await expect(processWithdrawalJob(job)).rejects.toThrow('open payout')

    expect(updateData).toHaveBeenCalledWith(expect.objectContaining({ sawWithdrawalPending: true }))
  })

  it('rethrows the ORIGINAL failure even when persisting the marker fails', async () => {
    // The failure handler has to see the real error, not a bookkeeping one.
    const updateData = vi.fn().mockRejectedValue(new Error('redis gone'))
    const job = makeJob({ attemptsMade: 1, attempts: ZARECASH_WITHDRAWAL_ATTEMPTS, updateData })
    vi.spyOn(ZareCashService, 'submitWithdrawal').mockRejectedValueOnce(WITHDRAWAL_PENDING())

    await expect(processWithdrawalJob(job)).rejects.toThrow('open payout')
  })

  it('does not touch the job data for an ordinary failure', async () => {
    const updateData = vi.fn().mockResolvedValue(undefined)
    const job = makeJob({ attemptsMade: 1, attempts: ZARECASH_WITHDRAWAL_ATTEMPTS, updateData })
    vi.spyOn(ZareCashService, 'submitWithdrawal').mockRejectedValueOnce(NETWORK_ERROR())

    await expect(processWithdrawalJob(job)).rejects.toThrow('ECONNREFUSED')
    expect(updateData).not.toHaveBeenCalled()
  })

  // ── Final-review Critical 3 (second instance): the terminal refund ─────────

  it('re-enqueues the terminal refund when it fails, instead of swallowing it', async () => {
    // A blanket catch here left the player permanently debited for a payout that
    // was never sent, with nothing anywhere that would ever try again.
    rejectWithdrawal.mockRejectedValueOnce(new Error('Timed out fetching a new connection from the pool'))
    const job = makeJob({ attemptsMade: ZARECASH_WITHDRAWAL_ATTEMPTS, attempts: ZARECASH_WITHDRAWAL_ATTEMPTS })

    await handleWithdrawalFailure(job, NETWORK_ERROR())

    expect(add).toHaveBeenCalledWith(
      TERMINAL_REFUND_JOB,
      expect.objectContaining({ transactionId: 'tx1' }),
      expect.objectContaining({ attempts: ZARECASH_WITHDRAWAL_ATTEMPTS }),
    )
  })

  it('does not re-enqueue when the terminal refund succeeds', async () => {
    const job = makeJob({ attemptsMade: ZARECASH_WITHDRAWAL_ATTEMPTS, attempts: ZARECASH_WITHDRAWAL_ATTEMPTS })
    await handleWithdrawalFailure(job, NETWORK_ERROR())
    expect(rejectWithdrawal).toHaveBeenCalledTimes(1)
    expect(add).not.toHaveBeenCalled()
  })

  it('treats an already-resolved row as benign — no retry job for a refund that is not needed', async () => {
    rejectWithdrawal.mockRejectedValueOnce(new Error('Transaction is not pending review'))
    const job = makeJob({ attemptsMade: ZARECASH_WITHDRAWAL_ATTEMPTS, attempts: ZARECASH_WITHDRAWAL_ATTEMPTS })

    await handleWithdrawalFailure(job, NETWORK_ERROR())

    expect(add).not.toHaveBeenCalled()
  })

  it('runs the refund when a terminal-refund job is processed, and lets BullMQ retry a genuine failure', async () => {
    const job = makeJob({ attemptsMade: 1, attempts: ZARECASH_WITHDRAWAL_ATTEMPTS, name: TERMINAL_REFUND_JOB })
    ;(job as any).data = { transactionId: 'tx1', reason: 'refunded' }

    await processWithdrawalJob(job)
    expect(rejectWithdrawal).toHaveBeenCalledWith('tx1', 'refunded')

    rejectWithdrawal.mockRejectedValueOnce(new Error('db down'))
    await expect(processWithdrawalJob(job)).rejects.toThrow('db down')
  })

  it('a terminal-refund job that exhausts its own retries does not recurse into another refund', async () => {
    const job = makeJob({
      attemptsMade: ZARECASH_WITHDRAWAL_ATTEMPTS,
      attempts: ZARECASH_WITHDRAWAL_ATTEMPTS,
      name: TERMINAL_REFUND_JOB,
    })
    ;(job as any).data = { transactionId: 'tx1', reason: 'refunded' }

    await handleWithdrawalFailure(job, new Error('db down'))

    expect(rejectWithdrawal).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: 'terminal-refund-exhausted' }),
    )
  })
})
