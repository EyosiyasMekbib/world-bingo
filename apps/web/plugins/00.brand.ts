// apps/web/plugins/00.brand.ts
import { resolveBrand, brandToCssVars } from '@world-bingo/ui'

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const theme = resolveBrand(config.public.brand as string | undefined)

  const cssText = Object.entries(brandToCssVars(theme))
    .map(([k, v]) => `${k}:${v}`)
    .join(';')

  useHead({
    title: theme.name,
    link: [{ rel: 'stylesheet', href: theme.fonts.googleHref }],
    meta: [{ name: 'theme-color', content: theme.manifest.themeColor }],
    style: [{ children: `:root{${cssText}}` }],
    htmlAttrs: { 'data-brand': theme.id },
  })
})
