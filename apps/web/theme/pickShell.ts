import type { Component } from 'vue'
import type { ShellKey, ThemeId } from '@world-bingo/shared-types'

export type ShellRegistry = Partial<Record<ThemeId, Partial<Record<ShellKey, Component>>>>

export const FALLBACK_SHELL: ShellKey = 'rails'

/**
 * Resolve a shell component, degrading rather than rendering nothing:
 *   1. the requested shell in the active theme
 *   2. the active theme's rails shell — staying in-theme beats matching the
 *      shape, so a themed rails page is preferred over another theme's wide one
 *   3. the requested shell in arada, for a theme id absent from the registry
 *   4. arada's rails, which always exists
 *
 * Kept in its own module, free of .vue imports, so it stays unit-testable
 * without pulling a Vue SFC compiler into the vitest config.
 */
export function pickShell(
  registry: ShellRegistry,
  themeId: ThemeId,
  requested: ShellKey | undefined,
): Component {
  const key = requested ?? FALLBACK_SHELL
  const themeShells = registry[themeId] ?? {}
  const arada = registry.arada ?? {}
  return (
    themeShells[key] ?? themeShells[FALLBACK_SHELL] ?? arada[key] ?? arada[FALLBACK_SHELL]!
  )
}
