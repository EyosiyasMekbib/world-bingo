import AradaRailsShell from '~/components/shells/arada/RailsShell.vue'
import AradaWideShell from '~/components/shells/arada/WideShell.vue'
import Dash5RailsShell from '~/components/shells/dash5/RailsShell.vue'
import Dash5WideShell from '~/components/shells/dash5/WideShell.vue'
import type { ShellRegistry } from './pickShell'

export { pickShell, FALLBACK_SHELL, type ShellRegistry } from './pickShell'

/**
 * Statically imported on purpose. `/` is ssr:false, so an async shell would
 * flash unstyled content on first paint. The cost is every theme's shell in
 * the bundle, which is a few KB of markup.
 */
export const shells: ShellRegistry = {
  arada: { rails: AradaRailsShell, wide: AradaWideShell },
  dash5: { rails: Dash5RailsShell, wide: Dash5WideShell },
}
