import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// A deploy deletes the previous build's lazy chunks. Anything that hands a
// browser an older HTML document afterwards (HTTP cache, back/forward cache,
// a service worker) makes the app request chunks that 404. These pin the
// guards against that in place.

const WEB = join(__dirname, '..')
const read = (rel: string) => readFileSync(join(WEB, rel), 'utf8')

describe('nuxt.config.ts', () => {
  const config = read('nuxt.config.ts')

  it('keeps the service worker off navigations', () => {
    expect(config).toMatch(/workbox:\s*\{[^}]*navigateFallback:\s*null/)
  })

  it('never precaches an HTML document', () => {
    expect(config).not.toMatch(/globPatterns[^\]]*html/)
    expect(config).not.toMatch(/additionalManifestEntries/)
  })

  it('serves sw.js and the manifest with revalidating cache headers', () => {
    expect(config).toMatch(/registerWebManifestInRouteRules:\s*true/)
  })

  it('still reloads the tab that hits a missing chunk', () => {
    expect(config).toMatch(/emitRouteChunkError:\s*'automatic-immediate'/)
  })
})

describe('server/plugins/html-cache-control.ts', () => {
  const plugin = read('server/plugins/html-cache-control.ts')

  it('marks rendered HTML no-store', () => {
    expect(plugin).toMatch(/hook\('render:response'/)
    expect(plugin).toMatch(/startsWith\('text\/html'\)/)
    expect(plugin).toMatch(/'cache-control':\s*'no-store'/)
  })
})

describe('plugins/stale-build.client.ts', () => {
  const plugin = read('plugins/stale-build.client.ts')

  it('marks the build stale when a chunk fails or a newer build is announced', () => {
    expect(plugin).toMatch(/hook\('app:chunkError',\s*markStale\)/)
    expect(plugin).toMatch(/hook\('app:manifest:update',\s*markStale\)/)
  })

  it('reloads only a back/forward-cache restore of a stale build', () => {
    expect(plugin).toMatch(/addEventListener\('pageshow'/)
    expect(plugin).toMatch(/event\.persisted && claimStaleReload\(/)
  })
})
