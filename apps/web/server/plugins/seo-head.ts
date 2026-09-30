/**
 * Site-wide SEO tags on every HTML document: robots, canonical, description,
 * Open Graph / Twitter cards and the site's structured data on '/'.
 *
 * Runs in `render:html` so it also covers the client-only routes ('/', play,
 * profile...), whose SPA shell never runs page-level useHead on the server.
 * Page-level useSeoMeta still wins: tags already present are left alone.
 *
 * Private routes get `noindex, nofollow` (tag + X-Robots-Tag header) and no
 * canonical or preview card. See utils/seo.ts — nothing here may carry
 * personal data.
 */
import { buildHeadTags, buildHomeNoscript, canonicalPath, isPrivatePath } from '../../utils/seo'
import { resolveSeo } from '../utils/seo-site'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('render:html', async (html, { event }) => {
    const path = event.path || '/'
    const { site, indexable } = await resolveSeo(event)

    if (!indexable || isPrivatePath(path)) {
      setResponseHeader(event, 'x-robots-tag', 'noindex, nofollow')
    }

    const existingHead = html.head.join('')
    html.head.push(...buildHeadTags({ site, path, indexable, existingHead }))

    if (!html.htmlAttrs.join(' ').includes('lang=')) {
      html.htmlAttrs.push(`lang="${site.locale}"`)
    }

    if (indexable && canonicalPath(path) === '/') {
      html.bodyAppend.push(buildHomeNoscript(site))
    }
  })
})
