/**
 * Search-engine surface for the player app: which routes may be indexed, the
 * canonical origin, and the head tags, robots.txt and sitemap built from them.
 *
 * Pure on purpose (no Nuxt/h3 imports) so the server plugin and routes that use
 * it stay thin and this file is unit-testable.
 *
 * NO PERSONAL DATA. Everything emitted here is site-level: the brand name, the
 * site URL, the logo and fixed marketing copy. Never add a player's name, phone,
 * username, referral code, balance or any operator contact person to a tag,
 * the structured data or the sitemap. Private routes (wallet, profile, referral
 * links, game sessions) are kept out of the index entirely.
 */

/** Public pages listed in the sitemap, in priority order. */
export const SITEMAP_PATHS: ReadonlyArray<{ path: string; priority: string; changefreq: string }> = [
  { path: '/', priority: '1.0', changefreq: 'daily' },
  { path: '/games', priority: '0.9', changefreq: 'daily' },
  { path: '/games/bingo', priority: '0.9', changefreq: 'daily' },
  { path: '/games/slots', priority: '0.8', changefreq: 'daily' },
  { path: '/games/crash', priority: '0.8', changefreq: 'daily' },
  { path: '/games/live', priority: '0.7', changefreq: 'daily' },
  { path: '/games/table', priority: '0.7', changefreq: 'weekly' },
  { path: '/games/mini', priority: '0.6', changefreq: 'weekly' },
  { path: '/aviator', priority: '0.8', changefreq: 'weekly' },
  { path: '/promotions', priority: '0.8', changefreq: 'daily' },
  { path: '/auth/register', priority: '0.7', changefreq: 'monthly' },
  { path: '/auth/login', priority: '0.5', changefreq: 'monthly' },
]

/**
 * Routes that must never be indexed: they are per-player, transient, or carry
 * an identifier (referral code, game id) that belongs to someone.
 */
const PRIVATE_PREFIXES = [
  '/wallet',
  '/profile',
  '/transactions',
  '/set-password',
  '/refer',
  '/ref/',
  '/play/',
  '/quick/',
  '/search',
  // Detail pages show leaderboards and players' positions: player-identifying.
  '/tournaments/',
  '/predictions/',
]

/** Never crawled at all: API, sockets, analytics proxy. */
export const ROBOTS_DISALLOW = ['/api/', '/v1/', '/socket.io/', '/ingest/']

export function isPrivatePath(path: string): boolean {
  const p = stripQuery(path)
  return PRIVATE_PREFIXES.some((prefix) =>
    prefix.endsWith('/') ? p.startsWith(prefix) : p === prefix || p.startsWith(`${prefix}/`),
  )
}

export function stripQuery(path: string): string {
  const q = path.search(/[?#]/)
  return q === -1 ? path : path.slice(0, q)
}

/** Lowercase, no trailing slash (except root), no query. */
export function canonicalPath(path: string): string {
  let p = stripQuery(path).toLowerCase()
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p || '/'
}

/**
 * The public origin for canonical URLs. A configured siteUrl wins; otherwise
 * the request origin is used as-is.
 */
export function resolveOrigin(siteUrl: string, requestOrigin: string): string {
  const raw = (siteUrl || requestOrigin).trim()
  return raw.replace(/\/+$/, '')
}

/**
 * Whether this host may be indexed. Staging, localhost, bare IPs and any host
 * that is not the configured siteUrl (a Dokploy preview domain, say) get
 * noindex, so duplicates of the live site never compete with it.
 */
export function isIndexableHost(host: string, siteUrl: string, forceNoindex: boolean): boolean {
  if (forceNoindex) return false
  const h = host.toLowerCase().split(':')[0] ?? ''
  if (!h) return false
  if (siteUrl) {
    try {
      return new URL(siteUrl).hostname.toLowerCase() === h
    } catch {
      return false
    }
  }
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.test')) return false
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return false
  if (h.startsWith('staging.') || h.includes('.staging.') || h.includes('-stg')) return false
  return true
}

export interface SeoSite {
  origin: string
  name: string
  description: string
  logoUrl: string | null
  ogImage: string | null
  locale: 'en' | 'am'
}

/** Absolute URL for a possibly relative asset path. */
export function absoluteUrl(origin: string, url: string | null | undefined): string | null {
  if (!url) return null
  if (/^https?:\/\//i.test(url)) return url
  return `${origin}${url.startsWith('/') ? '' : '/'}${url}`
}

export const HOME_TITLE_SUFFIX = 'Online Bingo, Slots & Aviator in Ethiopia'

/**
 * Titles for client-only public routes, whose page-level useSeoMeta never runs
 * on the server. Keep in step with the page's own useSeoMeta.
 */
const SHELL_TITLES: Record<string, string> = {
  '/aviator': 'Aviator',
}

export function defaultDescription(name: string, locale: 'en' | 'am'): string {
  if (locale === 'am') {
    return `${name} — በኢትዮጵያ የመስመር ላይ ቢንጎ፣ ስሎት እና ክራሽ ጨዋታዎች። በብር ያስገቡ፣ በቀጥታ ይጫወቱ፣ ያሸንፉ።`
  }
  return `${name} — play live online bingo, slots, Aviator and crash games in Ethiopia. Deposit in Birr, join a game in seconds and play in English or Amharic.`
}

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** JSON for a <script type="application/ld+json">, safe against `</script>`. */
function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/**
 * Site-level structured data: WebSite + Organization. Only the brand, URL and
 * logo; no address, phone, email or people.
 */
export function buildStructuredData(site: SeoSite): object {
  const logo = absoluteUrl(site.origin, site.logoUrl)
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${site.origin}/#organization`,
        name: site.name,
        url: `${site.origin}/`,
        ...(logo ? { logo } : {}),
      },
      {
        '@type': 'WebSite',
        '@id': `${site.origin}/#website`,
        name: site.name,
        url: `${site.origin}/`,
        inLanguage: ['en', 'am'],
        publisher: { '@id': `${site.origin}/#organization` },
      },
    ],
  }
}

export interface HeadInput {
  site: SeoSite
  path: string
  indexable: boolean
  /** The rendered head so far; tags a page already set are not duplicated. */
  existingHead: string
}

/** Head tags to append. Page-level useSeoMeta wins for title/description. */
export function buildHeadTags({ site, path, indexable, existingHead }: HeadInput): string[] {
  const canonical = `${site.origin}${canonicalPath(path)}`
  const privatePage = isPrivatePath(path)
  const has = (re: RegExp) => re.test(existingHead)
  const titleMatch = existingHead.match(/<title[^>]*>([^<]*)<\/title>/i)
  const isHome = canonicalPath(path) === '/'
  // Client-only routes ship a shell with no <title>; give crawlers one.
  const shellTitle = SHELL_TITLES[canonicalPath(path)]
  const fallbackTitle = escapeText(
    isHome
      ? `${site.name} — ${HOME_TITLE_SUFFIX}`
      : shellTitle
        ? `${shellTitle} · ${site.name}`
        : site.name,
  )
  const title = titleMatch?.[1]?.trim() || fallbackTitle
  const descMatch = existingHead.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i)
  const description = descMatch?.[1] || escapeAttr(site.description)
  const image = absoluteUrl(site.origin, site.ogImage || site.logoUrl)
  const tags: string[] = []

  const robots =
    indexable && !privatePage
      ? 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
      : 'noindex, nofollow'
  if (!has(/name="robots"/i)) tags.push(`<meta name="robots" content="${robots}">`)
  if (!titleMatch) tags.push(`<title>${title}</title>`)

  // A private or non-indexable page gets no canonical/OG: it should not be
  // shared as a preview card, and a canonical would point crawlers at it.
  if (!indexable || privatePage) return tags

  if (!has(/name="description"/i)) tags.push(`<meta name="description" content="${description}">`)
  if (!has(/rel="canonical"/i)) tags.push(`<link rel="canonical" href="${escapeAttr(canonical)}">`)
  if (!has(/property="og:type"/i)) tags.push('<meta property="og:type" content="website">')
  if (!has(/property="og:site_name"/i))
    tags.push(`<meta property="og:site_name" content="${escapeAttr(site.name)}">`)
  if (!has(/property="og:title"/i)) tags.push(`<meta property="og:title" content="${title}">`)
  if (!has(/property="og:description"/i))
    tags.push(`<meta property="og:description" content="${description}">`)
  if (!has(/property="og:url"/i)) tags.push(`<meta property="og:url" content="${escapeAttr(canonical)}">`)
  tags.push(`<meta property="og:locale" content="${site.locale === 'am' ? 'am_ET' : 'en_US'}">`)
  if (image && !has(/property="og:image"/i)) tags.push(`<meta property="og:image" content="${escapeAttr(image)}">`)
  if (!has(/name="twitter:card"/i))
    tags.push(`<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`)
  if (!has(/name="twitter:title"/i)) tags.push(`<meta name="twitter:title" content="${title}">`)
  if (!has(/name="twitter:description"/i))
    tags.push(`<meta name="twitter:description" content="${description}">`)
  if (image && !has(/name="twitter:image"/i))
    tags.push(`<meta name="twitter:image" content="${escapeAttr(image)}">`)

  if (isHome) {
    tags.push(`<script type="application/ld+json">${jsonLd(buildStructuredData(site))}</script>`)
  }
  return tags
}

/**
 * Crawlable fallback for the home page, which is a client-only route and ships
 * an empty body. Mirrors what the lobby shows: the brand, what it offers and
 * links into the public sections.
 */
export function buildHomeNoscript(site: SeoSite): string {
  const name = escapeText(site.name)
  const links = [
    ['/games/bingo', 'Online Bingo'],
    ['/games/slots', 'Slots'],
    ['/aviator', 'Aviator'],
    ['/games/crash', 'Crash Games'],
    ['/games/live', 'Live Casino'],
    ['/promotions', 'Promotions & Bonuses'],
    ['/auth/register', 'Create an account'],
  ]
  return [
    '<noscript>',
    `<main><h1>${name} — Online Bingo &amp; Casino Games in Ethiopia</h1>`,
    `<p>${escapeText(site.description)}</p>`,
    '<nav><ul>',
    ...links.map(([href, label]) => `<li><a href="${href}">${label}</a></li>`),
    '</ul></nav></main>',
    '</noscript>',
  ].join('')
}

export function buildRobotsTxt(origin: string, indexable: boolean): string {
  if (!indexable) return 'User-agent: *\nDisallow: /\n'
  return [
    'User-agent: *',
    'Allow: /',
    ...ROBOTS_DISALLOW.map((p) => `Disallow: ${p}`),
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n')
}

export function buildSitemapXml(origin: string, lastmod: string): string {
  const urls = SITEMAP_PATHS.map(({ path, priority, changefreq }) => {
    const loc = escapeText(`${origin}${path}`)
    return (
      `<url><loc>${loc}</loc><lastmod>${lastmod}</lastmod>` +
      `<changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`
    )
  })
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join('\n') +
    '\n</urlset>\n'
  )
}
