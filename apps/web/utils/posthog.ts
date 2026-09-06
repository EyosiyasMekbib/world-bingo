/**
 * Pure helpers behind plugins/02.posthog.client.ts and useAnalytics().
 * No Nuxt runtime here so they stay unit-testable.
 *
 * Person properties are deliberately narrow: serial, brand, signup method and
 * signup date. Phone, names and Telegram handles never leave the app.
 */

export interface PersonProps {
  serial: number
  brand: string
  signup_method: 'phone' | 'telegram'
  created_at: string
}

export function buildPersonProps(
  user: { serial: number; telegramId?: string | null; createdAt: Date | string },
  brand: string,
): PersonProps {
  return {
    serial: user.serial,
    brand,
    signup_method: user.telegramId ? 'telegram' : 'phone',
    created_at: new Date(user.createdAt).toISOString(),
  }
}

export function buildSuperProps(input: { brand: string; locale: string; standalone: boolean }) {
  return { brand: input.brand, locale: input.locale, is_pwa: input.standalone }
}

/** NUXT_PUBLIC_POSTHOG_REPLAY: anything but an explicit off value keeps replay on. */
export function resolveReplayEnabled(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === '') return true
  if (raw === false) return false
  const s = String(raw).trim().toLowerCase()
  return !(s === 'false' || s === '0' || s === 'off' || s === 'no')
}

export function isStandaloneDisplay(win: {
  matchMedia?: (query: string) => { matches: boolean }
  navigator?: { standalone?: boolean }
}): boolean {
  try {
    if (win.matchMedia?.('(display-mode: standalone)').matches) return true
  } catch {
    // jsdom and old WebViews throw on matchMedia
  }
  return win.navigator?.standalone === true
}

/** The `brand` super property: env override first, else the brand's short name slugged. */
export function brandSlug(input: { brand?: string | null; shortName: string }): string {
  const configured = input.brand?.trim()
  if (configured) return configured
  return input.shortName.trim().toLowerCase().replace(/\s+/g, '-')
}
