import prisma from '../../lib/prisma'
import type { SupportContactInfo } from '@world-bingo/shared-types'

const KEYS = ['support_phone', 'support_telegram', 'support_hours'] as const

/**
 * Builds the `SiteSetting` row updates for a `PUT /settings/support` body.
 *
 * A key is only written when its value is actually a `string` — `typeof`, not
 * `!== undefined`. The route's `as {...}` cast on `req.body` is compile-time
 * only and does not stop a caller sending JSON `null` (the conventional way
 * to say "clear this field") or a number/boolean. `!== undefined` would let
 * `null` through, and `String(null).trim()` would persist the literal text
 * `"null"` into the row — which the PUBLIC `GET /settings/support` would then
 * serve to signed-out players as their support phone number. An omitted key
 * (`undefined`) is likewise not written, leaving the existing row untouched.
 */
export function buildContactUpdates(body: {
  support_phone?: unknown
  support_telegram?: unknown
  support_hours?: unknown
}): Record<string, string> {
  const updates: Record<string, string> = {}
  if (typeof body.support_phone === 'string') updates.support_phone = body.support_phone.trim()
  if (typeof body.support_telegram === 'string')
    updates.support_telegram = body.support_telegram.trim()
  if (typeof body.support_hours === 'string') updates.support_hours = body.support_hours.trim()
  return updates
}

export class SupportContact {
  /**
   * Real-world contact details, shown whenever chat cannot help: no agent
   * online, or a thread left waiting. Empty strings are valid — the widget
   * hides a channel that has not been configured.
   */
  static async get(): Promise<SupportContactInfo> {
    const rows = await prisma.siteSetting.findMany({ where: { key: { in: [...KEYS] } } })
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    return {
      phone: map.support_phone ?? '',
      telegram: map.support_telegram ?? '',
      hours: map.support_hours ?? '',
    }
  }
}
