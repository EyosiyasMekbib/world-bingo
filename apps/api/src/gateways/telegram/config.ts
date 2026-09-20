/**
 * Telegram support bot configuration.
 *
 * Everything here is env-gated and a no-op when unset — same rule the
 * observability stack follows (see CLAUDE.md). With TELEGRAM_BOT_TOKEN or
 * TELEGRAM_WEBHOOK_SECRET empty, isEnabled() is false and nothing in
 * gateways/telegram or services/telegram runs: no webhook is registered, no
 * queue worker sends, the boot sequence logs one line and returns.
 *
 * This is the SUPPORT bot. TELEGRAM_BOT_TOKEN is the same token the login
 * widget already uses for hash verification (auth.service.ts) — one bot per
 * brand deployment does double duty, but the two features never share code
 * or write the same User columns.
 */

function trimmed(name: string): string {
  return (process.env[name] ?? '').trim()
}

export function botToken(): string {
  return trimmed('TELEGRAM_BOT_TOKEN')
}

export function webhookSecret(): string {
  return trimmed('TELEGRAM_WEBHOOK_SECRET')
}

/** The bot runs at all — linking, notification pushes, the player-side
 *  support bridge — once both the token and the webhook secret are set. */
export function isEnabled(): boolean {
  return botToken().length > 0 && webhookSecret().length > 0
}

/** Staff group id, e.g. "-1001234567890". Empty disables ONLY the staff
 *  forum-topic bridge; player linking, pushes and support-via-DM keep
 *  working — clerks just answer from the admin inbox instead. */
export function supportGroupId(): string | null {
  const raw = trimmed('TELEGRAM_SUPPORT_GROUP_ID')
  return raw.length > 0 ? raw : null
}

export function isStaffBridgeEnabled(): boolean {
  return isEnabled() && supportGroupId() !== null
}

/** Optional pinned topic for ops alerts (float low, etc). Null means no ops
 *  topic is configured and postOpsAlert() is a no-op. */
export function opsTopicId(): number | null {
  const raw = trimmed('TELEGRAM_OPS_TOPIC_ID')
  if (!raw) return null
  const n = Number(raw)
  return Number.isInteger(n) ? n : null
}

const DEFAULT_SHIFT_HOURS = 8

/** How long /onshift holds a staff member as present before it expires. */
export function shiftHours(): number {
  const raw = trimmed('TELEGRAM_SHIFT_HOURS')
  if (!raw) return DEFAULT_SHIFT_HOURS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SHIFT_HOURS
}

/** Where setWebhook registers and where deep links point. Both already
 *  exist for other features (hub callbacks, deposit checkout links). */
export function apiBaseUrl(): string {
  return trimmed('API_BASE_URL')
}

export function webBaseUrl(): string {
  return trimmed('WEB_BASE_URL')
}

/** Optional — only used to build a link from the staff topic header into the
 *  admin support inbox. Omitted (header has no link) when unset. */
export function adminBaseUrl(): string | null {
  const raw = trimmed('ADMIN_BASE_URL')
  return raw.length > 0 ? raw : null
}

/** Fixed path, no secret in the URL — Telegram is registered with
 *  `secret_token` and the route checks the `X-Telegram-Bot-Api-Secret-Token`
 *  header instead (routes/telegram/webhook.ts). A path-embedded secret ends
 *  up in access logs and browser history; the header does not. */
export const WEBHOOK_PATH = '/v1/telegram/webhook'

export function webhookUrl(): string | null {
  const base = apiBaseUrl()
  return base ? `${base}${WEBHOOK_PATH}` : null
}

/**
 * The bot's own @username, learned from getMe() at boot (bot.ts) and cached
 * here for the rest of the process lifetime — it never changes at runtime.
 * Null until boot has run, or if the bot is disabled or getMe() failed;
 * every caller (link.service.ts) treats null as "cannot build a deep link
 * right now" rather than throwing, the same as a disabled bot.
 */
let cachedBotUsername: string | null = null

export function setBotUsername(username: string): void {
  cachedBotUsername = username
}

export function botUsername(): string | null {
  return cachedBotUsername
}
