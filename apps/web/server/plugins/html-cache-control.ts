/**
 * Every HTML document goes out with `Cache-Control: no-store`.
 *
 * The HTML used to carry no cache header at all, so browsers kept a copy and
 * reused it on tab restore and Back without asking the server. That copy
 * points at the previous build's entry chunk, which is still cached under
 * its one-year immutable header, and the app then requests lazy chunks the
 * new build deleted. On 2026-09-15 PostHog showed players booting a build
 * five to seven hours after it was replaced, seconds into their session.
 *
 * no-store rather than no-cache: browsers reuse a no-cache document on
 * history and restore navigations without revalidating it, and no-store is
 * also what keeps most browsers from parking the page in the back/forward
 * cache. Hashed /_nuxt assets keep their immutable caching; only documents
 * rendered by Nuxt are affected.
 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('render:response', (response) => {
    const contentType = String(response.headers?.['content-type'] ?? '')
    if (!contentType.startsWith('text/html')) return
    response.headers = { ...response.headers, 'cache-control': 'no-store' }
  })
})
