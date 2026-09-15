/**
 * Reloads a page the browser restored from its back/forward cache when that
 * page runs a build already known to reference deleted chunks. The incident
 * behind it is described in utils/stale-build.ts.
 *
 * Nuxt's chunk-reload plugin (emitRouteChunkError in nuxt.config.ts) still
 * reloads the tab that hit the 404. This plugin only marks the build and
 * watches `pageshow`, the one event a restored page is guaranteed to fire.
 */
import { claimStaleReload, markBuildStale, resolveSessionStorage } from '~/utils/stale-build'

export default defineNuxtPlugin((nuxtApp) => {
  const buildId = useRuntimeConfig().app.buildId
  const storage = resolveSessionStorage(window)
  const markStale = () => markBuildStale(storage, buildId)

  // app:chunkError: a lazy import failed. app:manifest:update: Nuxt's
  // outdated-build check found a newer deploy. Either way this build is gone.
  nuxtApp.hook('app:chunkError', markStale)
  nuxtApp.hook('app:manifest:update', markStale)

  window.addEventListener('pageshow', (event) => {
    if (event.persisted && claimStaleReload(storage, buildId, Date.now())) {
      window.location.reload()
    }
  })
})
