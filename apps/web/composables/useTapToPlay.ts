import { markTap, playHrefTarget } from '~/utils/launch-handoff'

/** Click handler for links into /play/…: records the tap for the play page's `msFromTap`. */
export function useTapToPlay() {
  return (href: string) => {
    const target = playHrefTarget(href)
    if (target) markTap(target, performance.now())
  }
}
