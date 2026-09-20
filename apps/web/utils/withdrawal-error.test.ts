import { describe, it, expect } from 'vitest'
import { withdrawalErrorMessage } from './withdrawal-error'

const t = (key: string) => `t:${key}`

describe('withdrawalErrorMessage', () => {
  it('uses the localized hold copy for a withdrawal held after a password reset', () => {
    const e = {
      data: {
        statusCode: 403,
        error: 'Forbidden',
        message: 'Withdrawals are on hold for 24 hours after a password reset…',
        code: 'withdrawal_hold_after_reset',
      },
    }
    expect(withdrawalErrorMessage(e, t)).toBe('t:wallet.withdrawalHoldAfterReset')
  })

  it("shows the api's message, not the status name the error handler puts in `error`", () => {
    const e = { data: { statusCode: 403, error: 'Error', message: 'This account is under review.' } }
    expect(withdrawalErrorMessage(e, t)).toBe('This account is under review.')
  })

  it('falls back to `error` for the controller replies that carry only that', () => {
    const e = { data: { error: 'You already have a pending withdrawal request.' } }
    expect(withdrawalErrorMessage(e, t)).toBe('You already have a pending withdrawal request.')
  })

  it('uses a thrown error message when there is no response body', () => {
    expect(withdrawalErrorMessage(new Error('Session expired'), t)).toBe('Session expired')
  })

  it('falls back to generic localized copy when nothing else is available', () => {
    expect(withdrawalErrorMessage(undefined, t)).toBe('t:wallet.withdrawalFailed')
  })
})
