import type { ThemeDefinition, ThemeId } from './types'
import { arada } from './arada'
import { dash5 } from './dash5'

export * from './types'
export { arada, dash5 }

export const themes: Record<ThemeId, ThemeDefinition> = { arada, dash5 }
export const DEFAULT_THEME_ID: ThemeId = 'arada'

/**
 * Single seam for choosing the active theme. Unknown ids fall back to the
 * default rather than throwing — a bad value in the DB must never break boot.
 */
export function resolveTheme(id: string | undefined): ThemeDefinition {
  if (id && id in themes) return themes[id as ThemeId]
  if (id) console.warn(`[theme] unknown theme "${id}", falling back to ${DEFAULT_THEME_ID}`)
  return themes[DEFAULT_THEME_ID]
}

/**
 * Render a theme's typography and density as the body of a CSS block.
 * Colours are NOT emitted here — they flow through brandTokensToCss so that a
 * brand override always wins. Injected at :root:root by the web plugin.
 */
export function themeToCssVars(theme: ThemeDefinition): string {
  const t = theme.typography
  const d = theme.density
  return [
    `--font-ui: ${t.ui};`,
    `--font-body: ${t.body};`,
    `--font-heading: ${t.heading};`,
    `--font-game: ${t.heading};`,
    `--wb-font-size-base: ${t.baseSize};`,
    `--util-h: ${d.utilH};`,
    `--nav-h: ${d.navH};`,
    `--row-h: ${d.rowH};`,
    `--control-h: ${d.controlH};`,
    `--input-h: ${d.inputH};`,
    `--rail-w: ${d.railW};`,
    `--aside-w: ${d.asideW};`,
    `--radius-sm: ${d.radiusSm};`,
    `--radius-md: ${d.radiusMd};`,
    `--radius-lg: ${d.radiusLg};`,
    `--border-w: ${d.borderW};`,
  ].join('\n')
}
