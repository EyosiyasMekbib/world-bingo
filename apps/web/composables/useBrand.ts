import {
  type BrandConfig,
  type BrandTokens,
  DEFAULT_BRAND,
  brandTokensToCss,
} from '@world-bingo/shared-types'

/** Build the `<style>` body that overrides the brand tokens at :root. Pure helper — no Nuxt runtime deps. */
export function buildBrandStyle(tokens: BrandTokens): string {
  // `:root:root` (specificity 0,2,0) outranks the static `:root` blocks in the
  // globally-loaded token CSS, so the active brand always wins regardless of
  // stylesheet load order.
  return `:root:root {\n${brandTokensToCss(tokens)}\n}`
}

/** Shared SSR-hydrated brand state. Defaults to DEFAULT_BRAND. */
export function useBrand() {
  // useState is a Nuxt auto-imported global — not imported at module level
  // so that the pure buildBrandStyle helper remains testable without a Nuxt runtime.
  return useState<BrandConfig>('brand', () => DEFAULT_BRAND)
}
