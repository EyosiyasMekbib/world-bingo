/**
 * Staff presence on the Telegram support bridge.
 *
 * A clerk answering from the staff group never holds a socket in
 * support:agents — support.gateway.ts's anyAgentOnline() only sees the web
 * inbox. Without this, the widget would tell a player nobody is available
 * even while a clerk is actively working the group. `/onshift` in the
 * group adds the clerk here; the gateway's presence check ORs this set with
 * the socket room. See docs/telegram-support-bot.md §6.5.
 */

import redis from '../../lib/redis.js'
import { shiftHours } from '../../gateways/telegram/config.js'

const ONSHIFT_KEY = 'tg:onshift'

export async function goOnShift(userId: string): Promise<void> {
  const expiresAt = Date.now() + shiftHours() * 3_600_000
  await redis.zadd(ONSHIFT_KEY, expiresAt, userId)
}

export async function goOffShift(userId: string): Promise<void> {
  await redis.zrem(ONSHIFT_KEY, userId)
}

/** Any message or command from an on-shift clerk refreshes their expiry,
 *  so a busy shift never silently lapses mid-conversation. No-op for a
 *  clerk who is not currently on shift — this only ever extends, never
 *  grants, presence. */
export async function touchShift(userId: string): Promise<void> {
  const score = await redis.zscore(ONSHIFT_KEY, userId)
  if (score === null) return
  await goOnShift(userId)
}

/** Whether ANYONE is on shift right now. Expired members are lazily swept
 *  (ZREMRANGEBYSCORE) before the count, so a crashed process that never
 *  called /offshift cannot hold the flag "someone is here" open forever —
 *  the same failure mode anyAgentOnline()'s own comment describes for the
 *  socket room, solved here by an expiry instead of a disconnect hook. */
export async function anyOnShift(): Promise<boolean> {
  const now = Date.now()
  await redis.zremrangebyscore(ONSHIFT_KEY, '-inf', now)
  const count = await redis.zcount(ONSHIFT_KEY, now, '+inf')
  return count > 0
}

export async function isOnShift(userId: string): Promise<boolean> {
  const score = await redis.zscore(ONSHIFT_KEY, userId)
  return score !== null && Number(score) > Date.now()
}
