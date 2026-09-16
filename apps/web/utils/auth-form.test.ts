import { describe, it, expect } from 'vitest'
import { validateCodeForm, validatePhoneForm, applyAutofill } from './auth-form'

// The sign-in form used the browser's native `required` / `minlength` bubbles.
// On phones that bubble is a tooltip with no DOM change, which PostHog records
// as a dead click on the submit button (136 people in 40 hours). Validation now
// runs in code so the page can show an inline error and track why the submit
// never left the device.
describe('validatePhoneForm', () => {
  it('accepts every spelling a player might type', () => {
    for (const phone of ['0911234567', '911234567', '+251911234567', '+251 91 123 4567']) {
      expect(validatePhoneForm({ phone })).toBeNull()
    }
  })

  it('rejects an empty number', () => {
    expect(validatePhoneForm({ phone: '   ' })).toBe('phone_required')
    expect(validatePhoneForm({ phone: '' })).toBe('phone_required')
  })

  // Validated by the same conversion the send uses, so nothing can pass here
  // and then fail at Firebase with a code the player cannot act on.
  it('rejects a number Firebase would refuse', () => {
    expect(validatePhoneForm({ phone: '12345' })).toBe('phone_invalid')
    expect(validatePhoneForm({ phone: 'not a phone' })).toBe('phone_invalid')
  })
})

describe('validateCodeForm', () => {
  it('accepts the six digits Firebase sends', () => {
    expect(validateCodeForm({ code: '123456' })).toBeNull()
    expect(validateCodeForm({ code: ' 123456 ' })).toBeNull()
  })

  it('rejects an empty code', () => {
    expect(validateCodeForm({ code: '' })).toBe('code_required')
    expect(validateCodeForm({ code: '  ' })).toBe('code_required')
  })

  it('rejects anything that is not six digits', () => {
    expect(validateCodeForm({ code: '12345' })).toBe('code_invalid')
    expect(validateCodeForm({ code: '1234567' })).toBe('code_invalid')
    expect(validateCodeForm({ code: '12345a' })).toBe('code_invalid')
  })
})

describe('applyAutofill', () => {
  // 155 people in 14 hours submitted the sign-in form with an empty field
  // while it visibly held a value: some Android browsers autofill without
  // firing `input`, so v-model never sees it. Read the DOM value back before
  // validating. Both fields of the phone flow are autofill targets — the
  // number, and the SMS code Android offers from the notification.
  it('fills an empty model field from the input element', () => {
    const form = { phone: '', code: '' }
    applyAutofill(form, { phone: { value: '0911234567' } as HTMLInputElement })
    expect(form.phone).toBe('0911234567')
  })

  it('never overwrites what the player typed', () => {
    const form = { phone: 'typed', code: '' }
    applyAutofill(form, { phone: { value: 'autofilled' } as HTMLInputElement, code: { value: '123456' } as HTMLInputElement })
    expect(form.phone).toBe('typed')
    expect(form.code).toBe('123456')
  })

  it('ignores missing elements', () => {
    const form = { phone: '', code: '' }
    expect(() => applyAutofill(form, { phone: null, code: undefined })).not.toThrow()
    expect(form.phone).toBe('')
  })
})
