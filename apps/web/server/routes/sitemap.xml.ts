import { buildSitemapXml } from '../../utils/seo'
import { resolveSeo } from '../utils/seo-site'

export default defineEventHandler(async (event) => {
  const { site, indexable } = await resolveSeo(event)
  if (!indexable) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  }
  setResponseHeader(event, 'content-type', 'application/xml; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'public, max-age=3600')
  // Day granularity: the public pages change daily (lobby, promotions).
  return buildSitemapXml(site.origin, new Date().toISOString().slice(0, 10))
})
