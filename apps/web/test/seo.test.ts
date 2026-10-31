import { describe, it, expect } from 'vitest'
import {
  buildHeadTags,
  buildHomeNoscript,
  buildRobotsTxt,
  buildSitemapXml,
  canonicalPath,
  isIndexableHost,
  isPrivatePath,
  SITEMAP_PATHS,
  type SeoSite,
} from '../utils/seo'

const site: SeoSite = {
  origin: 'https://aradabet.games',
  name: 'Arada Bingo',
  description: 'Play bingo.',
  logoUrl: '/uploads/logo.png',
  ogImage: null,
  locale: 'en',
}

describe('isPrivatePath', () => {
  it.each(['/wallet', '/profile', '/transactions', '/ref/WB3FA29C', '/play/x/y', '/quick/1', '/search?q=a', '/refer', '/tournaments/abc', '/predictions/1'])(
    '%s is private',
    (p) => expect(isPrivatePath(p)).toBe(true),
  )
  it.each(['/', '/games', '/games/bingo', '/promotions', '/tournaments', '/predictions', '/auth/login', '/aviator'])(
    '%s is public',
    (p) => expect(isPrivatePath(p)).toBe(false),
  )
})

describe('isIndexableHost', () => {
  it('only the configured site host is indexable', () => {
    expect(isIndexableHost('aradabet.games', 'https://aradabet.games', false)).toBe(true)
    expect(isIndexableHost('staging.aradabingo.bet', 'https://aradabet.games', false)).toBe(false)
  })
  it('without siteUrl, staging, localhost and IPs are not indexable', () => {
    expect(isIndexableHost('staging.aradabingo.bet', '', false)).toBe(false)
    expect(isIndexableHost('localhost:3002', '', false)).toBe(false)
    expect(isIndexableHost('72.62.234.120', '', false)).toBe(false)
    expect(isIndexableHost('aradabet.games', '', false)).toBe(true)
  })
  it('noindex flag wins', () => {
    expect(isIndexableHost('aradabet.games', 'https://aradabet.games', true)).toBe(false)
  })
})

describe('buildHeadTags', () => {
  it('home gets title, canonical, OG and structured data', () => {
    const html = buildHeadTags({ site, path: '/?utm=x', indexable: true, existingHead: '' }).join('\n')
    expect(html).toContain('<title>Arada Bingo — Online Bingo')
    expect(html).toContain('<link rel="canonical" href="https://aradabet.games/">')
    expect(html).toContain('property="og:image" content="https://aradabet.games/uploads/logo.png"')
    expect(html).toContain('application/ld+json')
    expect(html).toMatch(/name="robots" content="index, follow/)
  })
  it('keeps a page title and description already rendered', () => {
    const existingHead = '<title>Promotions · Arada Bingo</title><meta name="description" content="Promo copy">'
    const tags = buildHeadTags({ site, path: '/promotions', indexable: true, existingHead })
    expect(tags.some((t) => t.startsWith('<title>'))).toBe(false)
    expect(tags.some((t) => t.includes('name="description"'))).toBe(false)
    expect(tags).toContain('<meta property="og:description" content="Promo copy">')
  })
  it('private pages are noindex with no canonical or preview card', () => {
    const tags = buildHeadTags({ site, path: '/ref/WB3FA29C', indexable: true, existingHead: '<title>x</title>' })
    expect(tags).toEqual(['<meta name="robots" content="noindex, nofollow">'])
  })
  it('non-indexable host is noindex', () => {
    const tags = buildHeadTags({ site, path: '/', indexable: false, existingHead: '<title>x</title>' })
    expect(tags).toEqual(['<meta name="robots" content="noindex, nofollow">'])
  })
  it('structured data carries only brand-level fields', () => {
    const html = buildHeadTags({ site, path: '/', indexable: true, existingHead: '' }).join('')
    const json = html.match(/ld\+json">(.*)<\/script>/)?.[1] ?? ''
    expect(json).not.toMatch(/telephone|email|address|founder|person/i)
  })
})

it('canonicalPath normalises case, slashes and query', () => {
  expect(canonicalPath('/Games/BINGO/?x=1')).toBe('/games/bingo')
  expect(canonicalPath('/')).toBe('/')
})

it('robots.txt blocks everything off the live host', () => {
  expect(buildRobotsTxt('https://staging.aradabingo.bet', false)).toBe('User-agent: *\nDisallow: /\n')
  const live = buildRobotsTxt('https://aradabet.games', true)
  expect(live).toContain('Disallow: /api/')
  expect(live).toContain('Sitemap: https://aradabet.games/sitemap.xml')
})

it('sitemap lists only public pages', () => {
  const xml = buildSitemapXml('https://aradabet.games', '2026-09-30')
  expect(xml).toContain('<loc>https://aradabet.games/games/bingo</loc>')
  for (const { path } of SITEMAP_PATHS) expect(isPrivatePath(path)).toBe(false)
})

it('home noscript fallback escapes the brand name', () => {
  expect(buildHomeNoscript({ ...site, name: 'A<b>' })).toContain('A&lt;b&gt;')
})
