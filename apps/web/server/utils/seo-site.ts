import type { H3Event } from 'h3'
import { getRequestHost, getRequestProtocol } from 'h3'
import { defaultDescription, isIndexableHost, resolveOrigin, type SeoSite } from '../../utils/seo'

interface BrandLite {
  displayName?: string
  logoUrl?: string | null
}

// The brand rarely changes; one fetch per 5 minutes per instance is plenty and
// keeps every SPA-shell render from calling the API.
const BRAND_TTL_MS = 5 * 60 * 1000
let cached: { at: number; brand: BrandLite } | null = null

async function loadBrand(event: H3Event): Promise<BrandLite> {
  if (cached && Date.now() - cached.at < BRAND_TTL_MS) return cached.brand
  const config = useRuntimeConfig(event)
  const base = config.apiBaseServer || config.public.apiBase
  try {
    const brand = await $fetch<BrandLite>(`${base}/brand`, { timeout: 2000 })
    cached = { at: Date.now(), brand }
    return brand
  } catch {
    // Keep serving the last good value on an API blip rather than a blank name.
    return cached?.brand ?? {}
  }
}

export interface ResolvedSeo {
  site: SeoSite
  indexable: boolean
}

export async function resolveSeo(event: H3Event): Promise<ResolvedSeo> {
  const config = useRuntimeConfig(event)
  const seo = config.public.seo
  const host = getRequestHost(event, { xForwardedHost: true })
  const requestOrigin = `${getRequestProtocol(event, { xForwardedProto: true })}://${host}`
  const origin = resolveOrigin(seo.siteUrl, requestOrigin)
  const brand = await loadBrand(event)
  const name = seo.siteName || brand.displayName || 'World Bingo'
  const locale = getCookie(event, 'wb_locale') === 'am' ? 'am' : 'en'
  const description =
    (locale === 'am' ? seo.descriptionAm : seo.description) || defaultDescription(name, locale)
  return {
    site: {
      origin,
      name,
      description,
      logoUrl: brand.logoUrl ?? null,
      ogImage: seo.ogImage || null,
      locale,
    },
    indexable: isIndexableHost(host, seo.siteUrl, String(seo.noindex) === 'true'),
  }
}
