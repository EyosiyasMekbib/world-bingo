import { buildRobotsTxt } from '../../utils/seo'
import { resolveSeo } from '../utils/seo-site'

export default defineEventHandler(async (event) => {
  const { site, indexable } = await resolveSeo(event)
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'public, max-age=3600')
  return buildRobotsTxt(site.origin, indexable)
})
