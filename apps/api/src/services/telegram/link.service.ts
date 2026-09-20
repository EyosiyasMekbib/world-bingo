/**
 * Linking a Telegram chat to an existing phone/password account.
 *
 * Two ways in (see docs/telegram-support-bot.md §5.1-5.2):
 *   - a one-time token minted by the app while the player is signed in
 *   - a phone number Telegram itself verified via its "share contact" button
 *
 * Both end up here, writing the SAME column (User.telegramChatId) that the
 * login widget never touches. Nothing in this file can be used to sign in.
 */

import crypto from 'crypto'
import prisma from '../../lib/prisma.js'
import redis from '../../lib/redis.js'
import { botUsername, isEnabled, webBaseUrl } from '../../gateways/telegram/config.js'
import { normalizeEthiopianPhone, candidateRawForms } from './phone.js'

const LINK_TOKEN_PREFIX = 'tg:link:'
const PWRESET_TOKEN_PREFIX = 'tg:pwreset:'
const LINK_TOKEN_TTL_SECS = 600
const PWRESET_TOKEN_TTL_SECS = 600
const LINK_RATE_LIMIT = 10
const PWRESET_RATE_LIMIT = 3
const RATE_WINDOW_SECS = 3600

interface LinkTokenPayload {
  kind: 'player' | 'staff'
  userId: string
  conversationId?: string
}

/** Atomic read-and-delete: MULTI/EXEC serialises against every other client,
 *  so two near-simultaneous consumes of the same token cannot both succeed —
 *  the second sees the key already gone. Portable across ioredis versions
 *  (no dependency on a GETDEL command wrapper existing). */
async function getdel(key: string): Promise<string | null> {
  const results = await redis.multi().get(key).del(key).exec()
  const value = results?.[0]?.[1]
  return typeof value === 'string' ? value : null
}

async function withinRate(prefix: string, userId: string, limit: number): Promise<boolean> {
  const key = `${prefix}${userId}`
  const count = await redis.incr(key)
  if (count === 1) await redis.expire(key, RATE_WINDOW_SECS)
  return count <= limit
}

function newToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

function deepLinkFor(token: string): string | null {
  const username = botUsername()
  if (!username) return null
  return `https://t.me/${username}?start=${token}`
}

/**
 * Mint a one-time link token for a signed-in player and return the deep
 * link to hand them. Null whenever a link cannot be offered right now —
 * bot disabled, username not yet known (boot still in progress), or the
 * caller is over the per-hour mint budget. Every call site treats null the
 * same way SupportContactInfo treats an empty string: hide the button,
 * never surface an error for something this low-stakes.
 */
export async function mintPlayerLinkToken(
  userId: string,
  conversationId?: string,
): Promise<string | null> {
  if (!isEnabled()) return null
  if (!(await withinRate('tg:linkrate:', userId, LINK_RATE_LIMIT))) return null

  const token = newToken()
  const payload: LinkTokenPayload = { kind: 'player', userId, conversationId }
  await redis.set(`${LINK_TOKEN_PREFIX}${token}`, JSON.stringify(payload), 'EX', LINK_TOKEN_TTL_SECS)
  return deepLinkFor(token)
}

/** Same as mintPlayerLinkToken, for a clerk/admin linking from the admin
 *  app. The route that calls this has already checked the caller's role —
 *  see routes/admin/index.ts. */
export async function mintStaffLinkToken(userId: string): Promise<string | null> {
  if (!isEnabled()) return null
  if (!(await withinRate('tg:linkrate:', userId, LINK_RATE_LIMIT))) return null

  const token = newToken()
  const payload: LinkTokenPayload = { kind: 'staff', userId }
  await redis.set(`${LINK_TOKEN_PREFIX}${token}`, JSON.stringify(payload), 'EX', LINK_TOKEN_TTL_SECS)
  return deepLinkFor(token)
}

/** Single-use: the token is gone whether or not it was found, so a replayed
 *  /start with the same payload (Telegram redelivery, a double-tap) cannot
 *  re-link. Returns null for an expired, already-used, or unknown token. */
export async function consumeLinkToken(token: string): Promise<LinkTokenPayload | null> {
  const raw = await getdel(`${LINK_TOKEN_PREFIX}${token}`)
  if (!raw) return null
  try {
    return JSON.parse(raw) as LinkTokenPayload
  } catch {
    return null
  }
}

export type LinkOutcome =
  | { ok: true; relinked: boolean; previousChatId: string | null }
  | { ok: false; reason: 'CONFLICT' }

/**
 * Write telegramChatId for userId, subject to the DB's own unique
 * constraint being the real arbiter — the pre-check below can only ever
 * guess, same discipline as SupportService.addMessage's reopen guard. A
 * chat already linked to a DIFFERENT user is a conflict; re-linking the
 * SAME user to a different chat is allowed and reported as `relinked` so
 * the caller can notify the chat that lost the link (see
 * docs/telegram-support-bot.md §7.2).
 */
export async function linkChatToUser(userId: string, chatId: string): Promise<LinkOutcome> {
  const existingByChat = await prisma.user.findUnique({
    where: { telegramChatId: chatId },
    select: { id: true },
  })
  if (existingByChat && existingByChat.id !== userId) {
    return { ok: false, reason: 'CONFLICT' }
  }

  const before = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramChatId: true },
  })
  const relinked = !!before?.telegramChatId && before.telegramChatId !== chatId

  try {
    await prisma.user.update({
      where: { id: userId },
      data: { telegramChatId: chatId, telegramLinkedAt: new Date(), telegramBlockedAt: null },
    })
  } catch (err) {
    // Two chats raced to claim the same userId (vanishingly unlikely — it
    // requires the SAME player to run /start on two devices with two
    // different Telegram accounts at once), or the same chatId raced onto
    // two different accounts and the pre-check above missed it.
    if ((err as { code?: string })?.code === 'P2002') return { ok: false, reason: 'CONFLICT' }
    throw err
  }

  return { ok: true, relinked, previousChatId: relinked ? (before!.telegramChatId as string) : null }
}

export async function unlinkChat(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { telegramChatId: null, telegramLinkedAt: null },
  })
}

export async function setNotifyEnabled(userId: string, notifyEnabled: boolean): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { telegramNotifyEnabled: notifyEnabled } })
}

export type PhoneMatchResult =
  | { kind: 'MATCH'; userId: string }
  | { kind: 'NO_MATCH' }
  | { kind: 'AMBIGUOUS' }
  | { kind: 'INVALID' }

/**
 * Resolve a Telegram-verified phone number to exactly one player account.
 * Registration stores `phone` unnormalised, so this matches every raw form
 * a player could have typed — see phone.ts. AMBIGUOUS (more than one player
 * row matches) is a data-quality case, not expected in practice; the caller
 * treats it the same as NO_MATCH and staff resolve it separately.
 */
export async function matchPhoneToPlayer(rawPhone: string): Promise<PhoneMatchResult> {
  const canonical = normalizeEthiopianPhone(rawPhone)
  if (!canonical) return { kind: 'INVALID' }

  const rows = await prisma.user.findMany({
    where: { role: 'PLAYER' as never, phone: { in: candidateRawForms(canonical) } },
    select: { id: true },
  })
  if (rows.length === 0) return { kind: 'NO_MATCH' }
  if (rows.length > 1) return { kind: 'AMBIGUOUS' }
  return { kind: 'MATCH', userId: rows[0].id }
}

/**
 * One-time password-reset link, issued once a player's identity is known
 * (linked chat, or a freshly matched shared contact). Consumed by POST
 * /auth/password-reset/consume. Rate-limited separately from link tokens —
 * password resets are the more sensitive action.
 */
export async function mintPasswordResetToken(userId: string): Promise<string | null> {
  if (!(await withinRate('tg:pwresetrate:', userId, PWRESET_RATE_LIMIT))) return null
  const token = newToken()
  await redis.set(`${PWRESET_TOKEN_PREFIX}${token}`, userId, 'EX', PWRESET_TOKEN_TTL_SECS)
  return token
}

export async function consumePasswordResetToken(token: string): Promise<string | null> {
  return getdel(`${PWRESET_TOKEN_PREFIX}${token}`)
}

export function passwordResetLinkFor(token: string): string {
  return `${webBaseUrl()}/auth/reset-password?token=${token}`
}
