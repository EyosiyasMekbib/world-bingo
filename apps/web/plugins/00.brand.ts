import { type BrandConfig, DEFAULT_BRAND } from '@world-bingo/shared-types'
import { buildBrandStyle, useBrand } from '~/composables/useBrand'

export default defineNuxtPlugin(async () => {
  const config = useRuntimeConfig()
  const brand = useBrand()

  // Fetch once on the server; serialized into the payload and reused on the
  // client via useState (no client refetch / no flash).
  if (import.meta.server) {
    try {
      const fetched = await $fetch<BrandConfig>(`${config.public.apiBase}/brand`)
      brand.value = fetched
    } catch {
      brand.value = DEFAULT_BRAND
    }
  }

  const b = brand.value
  useHead({
    title: b.displayName,
    titleTemplate: (t) => (t && t !== b.displayName ? `${t} · ${b.displayName}` : b.displayName),
    style: [{ id: 'brand-tokens', innerHTML: buildBrandStyle(b.tokens) }],
    link: b.faviconUrl ? [{ rel: 'icon', href: b.faviconUrl }] : [],
    meta: [{ name: 'application-name', content: b.displayName }],
  })
})
