import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', 'components', 'DepositModal.vue'), 'utf8')

describe('DepositModal manual form', () => {
  it('does not silently disable Submit on an incomplete form', () => {
    expect(src).not.toContain('loading || !canSubmit')
  })

  it('tracks a blocked submit with the missing fields and a failed submit', () => {
    expect(src).toContain("track('deposit_submit_blocked'")
    expect(src).toContain("track('deposit_submit_failed'")
  })

  it('takes the deposit floor from the API, not a built-in constant', () => {
    expect(src).toContain("'/settings/deposit-limits'")
    expect(src).not.toContain('MIN_DEPOSIT = ')
    expect(src).not.toContain('[200, 500, 1000, 2000]')
  })

  it('prefills from the registered phone and the remembered name', () => {
    expect(src).toContain('auth.user?.phone')
    expect(src).toContain('recallSenderName()')
  })
})
