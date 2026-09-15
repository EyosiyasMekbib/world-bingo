/**
 * Support-assisted password reset, client half.
 *
 * There is no self-service reset. Support verifies the player, an admin issues
 * a temporary password, and the API flags the account (`mustChangePassword`).
 * Until the player chooses their own password every page sends them to
 * SET_PASSWORD_PATH — except `/auth/*`, which they need to sign in or out.
 * Pure, so the rule is tested without a Nuxt runtime.
 */
import { MIN_PASSWORD_LENGTH } from './auth-form'

export const SET_PASSWORD_PATH = '/set-password'

export function passwordChangeRedirect(input: {
  path: string
  user: { mustChangePassword?: boolean } | null | undefined
  isAuthenticated: boolean
}): string | null {
  // A stored user with no tokens is the login page's "welcome back" card, not
  // a session — there is nothing to change a password on.
  if (!input.isAuthenticated || input.user?.mustChangePassword !== true) return null
  if (input.path === SET_PASSWORD_PATH || input.path.startsWith('/auth/')) return null
  return SET_PASSWORD_PATH
}

export type SetPasswordFormError = 'current_required' | 'new_short' | 'mismatch' | 'same_as_current'

export function validateSetPasswordForm(form: {
  currentPassword: string
  newPassword: string
  confirmPassword: string
}): SetPasswordFormError | null {
  if (!form.currentPassword) return 'current_required'
  if (form.newPassword.length < MIN_PASSWORD_LENGTH) return 'new_short'
  if (form.newPassword !== form.confirmPassword) return 'mismatch'
  // The server refuses this too; checking here saves the round trip.
  if (form.newPassword === form.currentPassword) return 'same_as_current'
  return null
}
