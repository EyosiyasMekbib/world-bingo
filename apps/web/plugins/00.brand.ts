import { type BrandConfig, DEFAULT_BRAND } from '@world-bingo/shared-types'
import { buildBrandStyle, useBrand } from '~/composables/useBrand'

export default defineNuxtPlugin(async () => {
  const config = useRuntimeConfig()
  const brand = useBrand()

  // Fetch the brand once, wherever the app first boots. On SSR routes the server
  // fetches and both `brand` and `loaded` are serialized into the payload, so the
  // client reuses them (no refetch, no flash). On SPA routes (ssr:false, e.g. '/')
  // the server never runs for that route, so `loaded` is still false on the client
  // and we fetch here — otherwise the brand would stay at DEFAULT_BRAND and the
  // page would always render the default theme regardless of what's saved.
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
    titleTemplate: (t) => (t && t !== b.displayName ? `${t} · ${b.displayName}` : b.displayName),
    style: [{ id: 'brand-tokens', innerHTML: buildBrandStyle(b.tokens) }],
    link: b.faviconUrl ? [{ rel: 'icon', href: b.faviconUrl }] : [],
    meta: [{ name: 'application-name', content: b.displayName }],
  })
})
