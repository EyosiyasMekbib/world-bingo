import { describe, it, expect } from 'vitest'
import { amountBucket, missingDepositFields } from './deposit'

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

describe('missingDepositFields', () => {
  const full = { amount: 500, transactionId: 'TLB12345', senderName: 'Abebe', senderAccount: '0911234567' }

  it('is empty for a complete form with a receipt', () => {
    expect(missingDepositFields(full, true, 200)).toEqual([])
  })

  it('lists every gap, in form order', () => {
    expect(
      missingDepositFields(
        { amount: 0, transactionId: ' 12 ', senderName: ' ', senderAccount: '09112' },
        false,
        200,
      ),
    ).toEqual(['amount', 'transactionId', 'senderName', 'senderAccount', 'receipt'])
  })

  it('uses the same floors the disabled Submit used to enforce', () => {
    expect(missingDepositFields({ ...full, amount: 199 }, true, 200)).toEqual(['amount'])
    expect(missingDepositFields({ ...full, transactionId: '1234' }, true, 200)).toEqual([
      'transactionId',
    ])
    expect(missingDepositFields({ ...full, senderAccount: '091123456' }, true, 200)).toEqual([
      'senderAccount',
    ])
  })
})
