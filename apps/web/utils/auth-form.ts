import { toE164 } from '@world-bingo/shared-types'

/**
 * Sign-in form validation in code rather than the browser's native bubbles.
 * On phones a `required` / `minlength` bubble is a tooltip with no DOM
 * change, which session replay records as a dead click on the submit button
 * and the player reads as a broken button. Returning a reason lets the page
 * show an inline message and track why the submit never left the device.
 */
export type PhoneFormError = 'phone_required' | 'phone_invalid'

export type CodeFormError = 'code_required' | 'code_invalid'

/** Firebase always sends six digits. */
export const SMS_CODE_LENGTH = 6

/**
 * The number has to be one Firebase will accept, which means E.164 — so this
 * validates by trying the conversion the send actually uses, rather than by a
 * second, looser rule that would let a number through here and fail there.
 */
export function validatePhoneForm(form: { phone: string }): PhoneFormError | null {
  if (!form.phone || !form.phone.trim()) return 'phone_required'
  if (!toE164(form.phone)) return 'phone_invalid'
  return null
}

export function validateCodeForm(form: { code: string }): CodeFormError | null {
  const code = (form.code ?? '').trim()
  if (!code) return 'code_required'
  if (!/^\d+$/.test(code) || code.length !== SMS_CODE_LENGTH) return 'code_invalid'
  return null
}

/**
 * Copy browser-autofilled values into the model before validating. Some
 * Android browsers fill a field without firing `input`, so v-model still
 * holds '' while the player sees their phone number in the box; 155 people
 * in 14 hours were told to "enter your username" that way. Never overwrites
 * a non-empty model value.
 *
 * Still load-bearing for phone sign-in: both fields here are autofill targets
 * (`autocomplete="tel"` and the SMS one-time-code hint).
 */
export function applyAutofill<T extends Record<string, string>>(
  form: T,
  elements: { [K in keyof T]?: { value: string } | null | undefined },
): void {
  for (const key of Object.keys(elements) as Array<keyof T>) {
    const el = elements[key]
    if (!el) continue
    if (!form[key] && typeof el.value === 'string' && el.value) {
      form[key] = el.value as T[keyof T]
    }
  }
}
