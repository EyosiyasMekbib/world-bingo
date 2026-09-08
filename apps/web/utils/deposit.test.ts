import { describe, it, expect } from 'vitest'
import { amountBucket } from './deposit'

// The same buckets the deposit_amount_entered event has always sent. They
// were duplicated inline twice in DepositModal.vue; this pins them.
describe('amountBucket', () => {
  it('buckets ETB amounts on the 500 / 1000 / 5000 boundaries', () => {
    expect(amountBucket(200)).toBe('<500')
    expect(amountBucket(499.99)).toBe('<500')
    expect(amountBucket(500)).toBe('500-1000')
    expect(amountBucket(999)).toBe('500-1000')
    expect(amountBucket(1000)).toBe('1000-5000')
    expect(amountBucket(4999)).toBe('1000-5000')
    expect(amountBucket(5000)).toBe('5000+')
  })

  it('does not throw on a missing or non-numeric amount', () => {
    expect(amountBucket(NaN)).toBe('<500')
    expect(amountBucket(undefined as unknown as number)).toBe('<500')
  })
})
