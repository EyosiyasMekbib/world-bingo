import {
  type BrandConfig,
  type BrandTokens,
  type ThemeDefinition,
  DEFAULT_BRAND,
  brandTokensToCss,
  themeToCssVars,
} from '@world-bingo/shared-types'

/** Build the `<style>` body that overrides the brand tokens at :root. Pure helper — no Nuxt runtime deps. */
export function buildBrandStyle(tokens: BrandTokens): string {
  // `:root:root` (specificity 0,2,0) outranks the static `:root` blocks in the
  // globally-loaded token CSS, so the active brand always wins regardless of
  // stylesheet load order.
  return `:root:root {\n${brandTokensToCss(tokens)}\n}`
}

/**
 * Build the `<style>` body for the active theme's typography and density.
 * `:root:root` (specificity 0,2,0) is required so these outrank the plain
 * `:root` defaults in tokens.base.css regardless of stylesheet order.
 * Emits no colours — brand tokens own those and land in their own block.
 */
export function buildThemeStyle(theme: ThemeDefinition): string {
  return `:root:root {\n${themeToCssVars(theme)}\n}`
}

/** Shared SSR-hydrated brand state. Defaults to DEFAULT_BRAND. */
export function useBrand() {
  // useState is a Nuxt auto-imported global — not imported at module level
  // so that the pure buildBrandStyle helper remains testable without a Nuxt runtime.
  return useState<BrandConfig>('brand', () => DEFAULT_BRAND)
}
