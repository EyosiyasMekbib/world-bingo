import { type BrandConfig, DEFAULT_BRAND, resolveTheme } from '@world-bingo/shared-types'
import { buildBrandStyle, buildThemeStyle, useBrand } from '~/composables/useBrand'

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
  const theme = resolveTheme(b.themeId)

  useHead({
    title: b.displayName,
    titleTemplate: (t) => (t && t !== b.displayName ? `${t} · ${b.displayName}` : b.displayName),
    // Selects which [data-theme='...'] skin block applies. SSR-rendered, so there
    // is no flash — including on the ssr:false routes.
    htmlAttrs: { 'data-theme': theme.id },
    style: [
      // Theme first, brand second: brand colours must land after so an override wins.
      { id: 'theme-tokens', innerHTML: buildThemeStyle(theme) },
      { id: 'brand-tokens', innerHTML: buildBrandStyle(b.tokens) },
    ],
    link: [
      ...(theme.typography.googleHref
        ? [
            { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
            { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
            { rel: 'stylesheet', href: theme.typography.googleHref },
          ]
        : []),
      ...(b.faviconUrl ? [{ rel: 'icon', href: b.faviconUrl }] : []),
    ],
    meta: [{ name: 'application-name', content: b.displayName }],
  })
})
