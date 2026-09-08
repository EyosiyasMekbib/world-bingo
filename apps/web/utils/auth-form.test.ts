import { describe, it, expect } from 'vitest'
import { validateLoginForm } from './auth-form'

// The login form used the browser's native `required` / `minlength` bubbles.
// On phones that bubble is a tooltip with no DOM change, which PostHog records
// as a dead click on "Sign In" (136 people in 40 hours). Validation now runs
// in code so the page can show an inline error and track why the submit
// never left the device.
describe('validateLoginForm', () => {
  it('accepts a filled-in form', () => {
    expect(validateLoginForm({ identifier: 'john_doe', password: 'secret1' })).toBeNull()
  })

  it('rejects an empty identifier first', () => {
    expect(validateLoginForm({ identifier: '   ', password: 'secret1' })).toBe(
      'identifier_required',
    )
  })

  it('rejects an empty password', () => {
    expect(validateLoginForm({ identifier: 'john', password: '' })).toBe('password_required')
  })

  it('rejects a password under 6 characters, matching the server rule', () => {
    expect(validateLoginForm({ identifier: 'john', password: '12345' })).toBe('password_short')
    expect(validateLoginForm({ identifier: 'john', password: '123456' })).toBeNull()
  })
})
