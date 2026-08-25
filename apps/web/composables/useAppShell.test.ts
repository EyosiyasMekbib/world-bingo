import { describe, it, expect } from 'vitest'
import { formatBalance } from './useAppShell'

describe('formatBalance', () => {
  it('sums real and bonus balances', () => {
    expect(formatBalance(1000, 234.5)).toBe('1,234.50')
  })

  it('always shows two decimals', () => {
    expect(formatBalance(5, 0)).toBe('5.00')
  })

  it('treats null and undefined as zero', () => {
    expect(formatBalance(null, undefined)).toBe('0.00')
  })

  it('accepts decimal strings from Prisma', () => {
    expect(formatBalance('1000.25', '0.25')).toBe('1,000.50')
  })
})
