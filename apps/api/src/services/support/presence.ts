/**
 * "Is anyone actually going to answer this?" — shared by the web widget's
 * escalation fallback (gateways/support.gateway.ts) and the bot's own
 * unanswered-thread notice (services/telegram/player-handlers.ts), so a
 * player gets the same answer whichever surface they are on.
 *
 * True when a clerk holds a live socket in the admin inbox OR is on shift
 * in the staff Telegram group (services/telegram/shift.service.ts) — see
 * the long comment on the socket-room half in support.gateway.ts's git
 * history for why room membership, not a Redis presence set, is the source
 * of truth for that half.
 */

import { anyOnShift } from '../telegram/shift.service.js'

export const AGENTS_ROOM = 'support:agents'

/** Minimal Socket.io surface this needs — typed narrowly, rather than
 *  importing `Server` here, so a caller can pass either the real io
 *  instance (getIo(), or the one support.gateway.ts already holds in its
 *  own closure) or a test double with a matching shape. Taking `io` as a
 *  parameter rather than reading a module-level singleton is deliberate:
 *  this module must never guess which io instance the caller means. */
interface IoLike {
  in(room: string): { fetchSockets(): Promise<unknown[]> }
}

export async function anyAgentOnline(io: IoLike): Promise<boolean> {
  const agents = await io.in(AGENTS_ROOM).fetchSockets()
  if (agents.length > 0) return true
  return anyOnShift()
}
