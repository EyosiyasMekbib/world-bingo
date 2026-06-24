import {
  type BrandConfig,
  type BrandTokens,
  DEFAULT_BRAND,
  brandTokensToCss,
} from '@world-bingo/shared-types'

/** Build the `<style>` body that overrides the brand tokens at :root. Pure helper — no Nuxt runtime deps. */
export function buildBrandStyle(tokens: BrandTokens): string {
  return `:root {\n${brandTokensToCss(tokens)}\n}`
}

/** Shared SSR-hydrated brand state. Defaults to DEFAULT_BRAND. */
export function useBrand() {
  // useState is a Nuxt auto-imported global — not imported at module level
  // so that the pure buildBrandStyle helper remains testable without a Nuxt runtime.
  return useState<BrandConfig>('brand', () => DEFAULT_BRAND)
}
