/**
 * Pure helpers behind plugins/02.posthog.client.ts and useAnalytics().
 * No Nuxt runtime here so they stay unit-testable.
 *
 * Person properties are deliberately narrow: serial, brand, signup method and
 * signup date. Phone, names and Telegram handles never leave the app.
 */
import type { CapturedNetworkRequest } from 'posthog-js'

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

/**
 * PostHog's own body deny-list (posthog-js replay network config). Setting
 * `maskCapturedNetworkRequestFn` switches PostHog's default body scrub off, so
 * maskReplayNetworkRequest applies it again.
 */
const BODY_DENY_LIST = [
  'password',
  'secret',
  'passwd',
  'api_key',
  'apikey',
  'auth',
  'credentials',
  'mysql_pwd',
  'privatekey',
  'private_key',
  'token',
]

function scrubBody(body: string, label: 'Request' | 'Response'): string {
  // PostHog also drops a body holding a card or SSN number. Any run of nine or
  // more digits, spaces and dashes ignored, covers both (and phone numbers).
  if (/\d{9,}/.test(body.replace(/[- ]/g, ''))) return `[SessionRecording] ${label} body redacted`
  const hit = BODY_DENY_LIST.find((word) => body.includes(word))
  return hit ? `[SessionRecording] ${label} body redacted as might contain: ${hit}` : body
}

/** A url with its query and hash cut off: origin + path for a web url, else everything before `?`/`#`. */
function withoutQueryOrHash(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return `${parsed.origin}${parsed.pathname}`
    }
  } catch {
    // Not absolute; cut it as a string below.
  }
  return url.split(/[?#]/, 1)[0] ?? ''
}

/**
 * `session_recording.maskCapturedNetworkRequestFn`. Replay network capture
 * records a frame load with its full url, and a sportsbook session or game
 * launch url carries a one-time player token in its query. Frame loads keep
 * origin + path; every other entry keeps its url. Bodies get PostHog's
 * default scrub, which this option would otherwise switch off.
 */
export function maskReplayNetworkRequest(entry: CapturedNetworkRequest): CapturedNetworkRequest {
  if (entry.requestBody) entry.requestBody = scrubBody(entry.requestBody, 'Request')
  if (entry.responseBody) entry.responseBody = scrubBody(entry.responseBody, 'Response')
  if ((entry.initiatorType === 'iframe' || entry.initiatorType === 'frame') && entry.name) {
    entry.name = withoutQueryOrHash(entry.name)
  }
  return entry
}

/** The `brand` super property: env override first, else the brand's short name slugged. */
export function brandSlug(input: { brand?: string | null; shortName: string }): string {
  const configured = input.brand?.trim()
  if (configured) return configured
  return input.shortName.trim().toLowerCase().replace(/\s+/g, '-')
}
