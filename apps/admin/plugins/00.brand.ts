import { type BrandConfig, DEFAULT_BRAND } from '@world-bingo/shared-types'
import { buildBrandStyle, useBrand } from '~/composables/useBrand'

export default defineNuxtPlugin(async () => {
  const config = useRuntimeConfig()
  const brand = useBrand()
  const loaded = useState<boolean>('brand-loaded', () => false)

  if (!loaded.value) {
    try {
      brand.value = await $fetch<BrandConfig>(`${config.public.apiBase}/brand`)
    } catch {
      brand.value = DEFAULT_BRAND
    }
    loaded.value = true
  }

  const b = brand.value
  useHead({
    title: b.displayName,
    titleTemplate: (t) => (t && t !== b.displayName ? `${t} · ${b.displayName} Admin` : `${b.displayName} Admin`),
    style: [{ id: 'brand-tokens', innerHTML: buildBrandStyle(b.tokens) }],
    link: b.faviconUrl ? [{ rel: 'icon', href: b.faviconUrl }] : [],
    meta: [{ name: 'application-name', content: `${b.displayName} Admin` }],
  })
})
