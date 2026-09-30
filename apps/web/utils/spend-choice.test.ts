import { describe, it, expect } from 'vitest'
import { needsSpendChoice, preselectedAccount, canSpend } from './spend-choice'

const wallet = (realBalance: number | string, bonusBalance: number | string, spendAccount: 'REAL' | 'BONUS' = 'REAL') => ({
  realBalance,
  bonusBalance,
  spendAccount,
})

describe('needsSpendChoice', () => {
  it('skips the picker when there is no bonus', () => {
    expect(needsSpendChoice(wallet(100, 0))).toBe(false)
    expect(needsSpendChoice(wallet(100, '0.00000000'))).toBe(false)
  })

  it('asks when there is any bonus', () => {
    expect(needsSpendChoice(wallet(100, 5))).toBe(true)
    expect(needsSpendChoice(wallet(0, '0.5'))).toBe(true)
  })

  it('skips the picker when the wallet is unknown', () => {
    expect(needsSpendChoice(null)).toBe(false)
  })
})

describe('canSpend', () => {
  it('is false for an empty bucket', () => {
    expect(canSpend(wallet(0, 10), 'REAL')).toBe(false)
    expect(canSpend(wallet(0, 10), 'BONUS')).toBe(true)
  })
})

describe('preselectedAccount', () => {
  it('keeps the current toggle when that bucket has money', () => {
    expect(preselectedAccount(wallet(100, 5, 'REAL'))).toBe('REAL')
    expect(preselectedAccount(wallet(100, 5, 'BONUS'))).toBe('BONUS')
  })

  it('moves to the other bucket when the current one is empty', () => {
    expect(preselectedAccount(wallet(0, 5, 'REAL'))).toBe('BONUS')
    expect(preselectedAccount(wallet(20, 0, 'BONUS'))).toBe('REAL')
  })
})
