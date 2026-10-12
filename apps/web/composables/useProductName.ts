import { type ThemeId, resolveTheme } from '@world-bingo/shared-types'

/**
 * Names that player copy hardcoded before brands existed. arada's pages say
 * "World Bingo" and that is kept exactly as it is — those strings are left
 * alone rather than migrated, so arada renders byte-for-byte the same. Every
 * other theme gets the brand's own display name.
 */
const LEGACY_NAME_BY_THEME: Partial<Record<ThemeId, string>> = {
  arada: 'World Bingo',
}

export function useProductName() {
  const brand = useBrand()
  const legacy = computed(() => LEGACY_NAME_BY_THEME[resolveTheme(brand.value.themeId).id] ?? null)
  return {
    /** What to call the product in copy. */
    name: computed(() => legacy.value ?? brand.value.displayName),
    /** True where the copy must stay on its original, pre-brand strings. */
    isLegacy: computed(() => legacy.value !== null),
  }
}
