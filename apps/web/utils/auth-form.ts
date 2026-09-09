/**
 * Login form validation in code rather than the browser's native bubbles.
 * On phones a `required` / `minlength` bubble is a tooltip with no DOM
 * change, which session replay records as a dead click on "Sign In" and the
 * player reads as a broken button. Returning a reason lets the page show an
 * inline message and track why the submit never left the device.
 */
export type LoginFormError = 'identifier_required' | 'password_required' | 'password_short'

/** Same floor the server enforces on the password. */
export const MIN_PASSWORD_LENGTH = 6

export function validateLoginForm(form: {
  identifier: string
  password: string
}): LoginFormError | null {
  if (!form.identifier || !form.identifier.trim()) return 'identifier_required'
  if (!form.password) return 'password_required'
  if (form.password.length < MIN_PASSWORD_LENGTH) return 'password_short'
  return null
}

/**
 * Copy browser-autofilled values into the model before validating. Some
 * Android browsers fill a field without firing `input`, so v-model still
 * holds '' while the player sees their phone number in the box; 155 people
 * in 14 hours were told to "enter your username" that way. Never overwrites
 * a non-empty model value.
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
