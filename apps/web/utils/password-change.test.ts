import { describe, it, expect } from 'vitest'
import {
  SET_PASSWORD_PATH,
  passwordChangeRedirect,
  validateSetPasswordForm,
} from './password-change'

// Support resets a forgotten password to a temporary one and the API flags the
// account. Until the player picks their own password every page sends them to
// SET_PASSWORD_PATH — except the pages they need to sign in or out.
describe('passwordChangeRedirect', () => {
  const flagged = { mustChangePassword: true }

  it('sends a flagged, signed-in player to the set-password page from any route', () => {
    for (const path of [
      '/',
      '/wallet',
      '/games',
      '/games/slots',
      '/play/palace/123',
      '/profile',
      '/tournaments',
    ]) {
      expect(passwordChangeRedirect({ path, user: flagged, isAuthenticated: true })).toBe(
        SET_PASSWORD_PATH,
      )
    }
  })

  it('does not redirect the set-password page to itself', () => {
    expect(
      passwordChangeRedirect({ path: SET_PASSWORD_PATH, user: flagged, isAuthenticated: true }),
    ).toBeNull()
  })

  it('never blocks /auth/* pages, so the player can still sign out or back in', () => {
    for (const path of ['/auth/login', '/auth/register', '/auth/anything']) {
      expect(passwordChangeRedirect({ path, user: flagged, isAuthenticated: true })).toBeNull()
    }
  })

  it('does nothing for a player without the flag', () => {
    expect(
      passwordChangeRedirect({
        path: '/wallet',
        user: { mustChangePassword: false },
        isAuthenticated: true,
      }),
    ).toBeNull()
    // A user persisted before the field existed carries no flag at all.
    expect(passwordChangeRedirect({ path: '/wallet', user: {}, isAuthenticated: true })).toBeNull()
    expect(
      passwordChangeRedirect({ path: '/wallet', user: null, isAuthenticated: true }),
    ).toBeNull()
  })

  it('does nothing when signed out, even if a stale flagged user is still stored', () => {
    expect(
      passwordChangeRedirect({ path: '/wallet', user: flagged, isAuthenticated: false }),
    ).toBeNull()
  })
})

describe('validateSetPasswordForm', () => {
  const valid = {
    currentPassword: 'TEMP2345',
    newPassword: 'mine-now',
    confirmPassword: 'mine-now',
  }

  it('accepts a filled-in form', () => {
    expect(validateSetPasswordForm(valid)).toBeNull()
  })

  it('requires the current (temporary) password', () => {
    expect(validateSetPasswordForm({ ...valid, currentPassword: '' })).toBe('current_required')
  })

  it('enforces the same 6-character floor as the server', () => {
    expect(
      validateSetPasswordForm({ ...valid, newPassword: '12345', confirmPassword: '12345' }),
    ).toBe('new_short')
    expect(
      validateSetPasswordForm({ ...valid, newPassword: '123456', confirmPassword: '123456' }),
    ).toBeNull()
  })

  it('requires the confirmation to match', () => {
    expect(validateSetPasswordForm({ ...valid, confirmPassword: 'mine-not' })).toBe('mismatch')
  })

  it('rejects keeping the temporary password before it costs a round trip', () => {
    expect(
      validateSetPasswordForm({
        currentPassword: 'TEMP2345',
        newPassword: 'TEMP2345',
        confirmPassword: 'TEMP2345',
      }),
    ).toBe('same_as_current')
  })
})
