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
vi.mock('../lib/sentry', () => ({ reportError }))

import { handleWithdrawalFailure, ZareCashWithdrawalJobData } from '../workers/zarecash-withdrawal.worker'
import { ZareCashError } from '../gateways/payment/zarecash/types'
import { ZARECASH_WITHDRAWAL_ATTEMPTS } from '../lib/queue'
import type { Job } from 'bullmq'

function makeJob(overrides: {
  attemptsMade: number
  attempts: number | undefined
  transactionId?: string
}): Job<ZareCashWithdrawalJobData> {
  return {
    id: 'job1',
    data: {
      transactionId: overrides.transactionId ?? 'tx1',
      methodCode: 'telebirr',
      destinationAccount: '0912345678',
    },
    attemptsMade: overrides.attemptsMade,
    opts: { attempts: overrides.attempts },
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
})
