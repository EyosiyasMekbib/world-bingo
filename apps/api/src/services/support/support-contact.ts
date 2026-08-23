import prisma from '../../lib/prisma'
import type { SupportContactInfo } from '@world-bingo/shared-types'

const KEYS = ['support_phone', 'support_telegram', 'support_hours'] as const

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
