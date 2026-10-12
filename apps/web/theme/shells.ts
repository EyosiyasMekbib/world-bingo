import AradaRailsShell from '~/components/shells/arada/RailsShell.vue'
import AradaWideShell from '~/components/shells/arada/WideShell.vue'
import WinnerRailsShell from '~/components/shells/winner/RailsShell.vue'
import WinnerWideShell from '~/components/shells/winner/WideShell.vue'
import type { ShellRegistry } from './pickShell'

export { pickShell, FALLBACK_SHELL, type ShellRegistry } from './pickShell'

/**
 * Statically imported on purpose. `/` is ssr:false, so an async shell would
 * flash unstyled content on first paint. The cost is every theme's shell in
 * the bundle, which is a few KB of markup.
 */
export const shells: ShellRegistry = {
  arada: { rails: AradaRailsShell, wide: AradaWideShell },
  winner: { rails: WinnerRailsShell, wide: WinnerWideShell },
}
