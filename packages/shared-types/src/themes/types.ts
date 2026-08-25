import type { BrandTokens } from '../brand'

export const THEME_IDS = ['arada', 'dash5'] as const
export type ThemeId = (typeof THEME_IDS)[number]

/** Layout shells a page can ask for. Phase 1 ships two; 'docs' and 'auth' follow later. */
export const SHELL_KEYS = ['rails', 'wide'] as const
export type ShellKey = (typeof SHELL_KEYS)[number]

export interface ThemeTypography {
  /** Chrome, labels, buttons — the condensed/display face. */
  ui: string
  /** Body copy. */
  body: string
  /** Headings; also aliased to --font-game. */
  heading: string
  /** Stylesheet to inject at boot, or null for system fonts only. */
  googleHref: string | null
  /** Root font size, e.g. '13px'. */
  baseSize: string
}

export interface ThemeDensity {
  /** Top utility bar height. */
  utilH: string
  /** Nav strip height. */
  navH: string
  /** Data table row height. */
  rowH: string
  /** Button height. */
  controlH: string
  /** Input height. */
  inputH: string
  /** Left rail width; '0px' means this theme's rails shell renders no left rail. */
  railW: string
  /** Right rail width; '0px' means no right rail. */
  asideW: string
  radiusSm: string
  radiusMd: string
  radiusLg: string
  borderW: string
}

export interface ThemeDefinition {
  id: ThemeId
  name: string
  /** Full palette this theme renders with when no brand override is set. */
  defaultTokens: BrandTokens
  typography: ThemeTypography
  density: ThemeDensity
}
