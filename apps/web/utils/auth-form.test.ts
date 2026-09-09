import { describe, it, expect } from 'vitest'
import { validateLoginForm, applyAutofill } from './auth-form'

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

describe('applyAutofill', () => {
  // 155 people in 14 hours submitted the login form with an empty identifier
  // while the field visibly held a value: some Android browsers autofill
  // without firing `input`, so v-model never sees it. Read the DOM value
  // back before validating.
  it('fills an empty model field from the input element', () => {
    const form = { identifier: '', password: 'secret1' }
    applyAutofill(form, { identifier: { value: '0911234567' } as HTMLInputElement })
    expect(form.identifier).toBe('0911234567')
  })

  it('never overwrites what the player typed', () => {
    const form = { identifier: 'typed', password: '' }
    applyAutofill(form, { identifier: { value: 'autofilled' } as HTMLInputElement, password: { value: 'pw' } as HTMLInputElement })
    expect(form.identifier).toBe('typed')
    expect(form.password).toBe('pw')
  })

  it('ignores missing elements', () => {
    const form = { identifier: '', password: '' }
    expect(() => applyAutofill(form, { identifier: null, password: undefined })).not.toThrow()
    expect(form.identifier).toBe('')
  })
})
