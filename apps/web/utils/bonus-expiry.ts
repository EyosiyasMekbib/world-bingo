/**
 * The wording a bonus deadline deserves, shared by the lobby bar and the wallet
 * nudge so the two surfaces cannot describe the same lot differently.
 *
 * Both watch a 24h window, and a 24h window straddles midnight — so "tonight"
 * cannot be decided by comparing calendar dates. A lot expiring at 10:00, read
 * at 08:00, is the same calendar day and is emphatically not tonight; a lot
 * expiring at 00:30, read at 23:50, is a different date and is exactly tonight.
 * What settles it is the night the player is currently standing in.
 */
const NIGHT_START_HOUR = 18
const NIGHT_END_HOUR = 6

export function expiresTonight(at: number, now: number): boolean {
  const nightEnd = new Date(now)
  // Before dawn the player is still inside the night that began yesterday.
  if (nightEnd.getHours() >= NIGHT_END_HOUR) nightEnd.setDate(nightEnd.getDate() + 1)
  nightEnd.setHours(NIGHT_END_HOUR, 0, 0, 0)
  const nightStart = new Date(nightEnd.getTime())
  nightStart.setDate(nightStart.getDate() - 1)
  nightStart.setHours(NIGHT_START_HOUR, 0, 0, 0)
  return at >= nightStart.getTime() && at < nightEnd.getTime()
}
