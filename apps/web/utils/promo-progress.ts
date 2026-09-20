/**
 * Progress toward a promotion threshold, made safe to render.
 *
 * `current` is signed. The cashback net-loss query credits wins as negatives
 * (`PRIZE_WIN` subtracts), so a player who is up on the period arrives here
 * below zero, and a player past the threshold arrives above target while the
 * payout waits for the period to close. Every surface that has drawn this
 * figure has got it wrong in a different way:
 *
 *  - a negative percentage became an invalid inline `width`, which the browser
 *    drops — and with no width in the CSS the fill spanned its parent, drawing
 *    the emptiest bar as the fullest;
 *  - a raw `aria-valuenow` fell outside the `aria-valuemin`/`max` it was
 *    declared against, announcing "180 percent", or a negative against a floor
 *    of zero;
 *  - the printed figure read "−250 / 500 ETB" beside a correctly empty rail.
 *
 * One helper so the clamp cannot be remembered in two places and forgotten in a
 * third. Nothing is hidden by flooring: the API's own hint carries what is still
 * to go, and it is the hint a screen reader reads via `aria-valuetext`.
 */
export interface PromoProgressView {
  /** Fill width, 0–100. */
  pct: number
  /** `aria-valuenow`, held inside [0, target]. */
  announced: number
}

export function promoProgressView(current: number, target: number): PromoProgressView {
  if (!(target > 0)) return { pct: 0, announced: 0 }
  const announced = Math.min(target, Math.max(0, current))
  return { pct: Math.max(0, Math.min(100, (current / target) * 100)), announced }
}

/** What is left to earn, floored — a player past the threshold owes nothing. */
export function remainingToTarget(current: number, target: number): number {
  return Math.max(0, target - current)
}
