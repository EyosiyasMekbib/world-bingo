import {
  type BrandConfig,
  type BrandTokens,
  DEFAULT_BRAND,
  brandTokensToCss,
} from '@world-bingo/shared-types'

export function buildBrandStyle(tokens: BrandTokens): string {
  return `:root:root {\n${brandTokensToCss(tokens)}\n}`
}

export function useBrand() {
  return useState<BrandConfig>('brand', () => DEFAULT_BRAND)
}
