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
