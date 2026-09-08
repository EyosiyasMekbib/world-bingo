import { resolve } from 'path'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// Internal Docker hostname of THIS deployment's API service. Baked at build time
// (routeRules proxies are static). Defaults to `http://api:8080` for the generic
// deployment; spokes whose api service is renamed (e.g. `api-betbawa`) MUST pass
// --build-arg NUXT_API_PROXY_TARGET so their browser traffic does not fall through
// to another stack's `api` alias on the shared dokploy-network.
const API_PROXY_TARGET = process.env.NUXT_API_PROXY_TARGET || 'http://api:8080'

// PostHog ingest is proxied through this origin so ad blockers never see it.
// EU Cloud by default; a US project passes both build args (see Dockerfile).
// These are the BUILD-TIME defaults for the runtimeConfig keys below, so the
// Dockerfile args keep working; a runtime NUXT_POSTHOG_PROXY_TARGET /
// NUXT_POSTHOG_ASSETS_PROXY_TARGET still overrides them without a rebuild.
const POSTHOG_PROXY_TARGET = process.env.NUXT_POSTHOG_PROXY_TARGET || 'https://eu.i.posthog.com'
const POSTHOG_ASSETS_PROXY_TARGET =
    process.env.NUXT_POSTHOG_ASSETS_PROXY_TARGET || 'https://eu-assets.i.posthog.com'

export default defineNuxtConfig({
    compatibilityDate: '2024-11-01',
    devtools: { enabled: true },

    // Client chunks get hidden source maps: a .map beside every chunk, no
    // sourceMappingURL comment. The nitro:build:before hook below hands them
    // to apps/web/scripts/posthog-sourcemaps.sh (inject chunk ids, upload,
    // delete), so no map ever ships. Server maps keep the Nuxt default.
    sourcemap: { server: true, client: 'hidden' },

    hooks: {
        // MUST run here: after the Vite client build, BEFORE Nitro copies
        // .nuxt/dist/client into .output/public and records every asset's
        // size and etag in its manifest. Injecting chunk ids after that copy
        // (as a post-build Docker step once did) grew each file by a few
        // hundred bytes while Nitro kept sending the recorded content-length,
        // so browsers received truncated modules and the entry chunk failed
        // to parse. Production client JS was dead for ~10 minutes on
        // 2026-09-08 because of exactly that.
        'nitro:build:before': (nitro) => {
            if (nitro.options.dev) return
            const clientDir = resolve(__dirname, '.nuxt/dist/client/_nuxt')
            if (!existsSync(clientDir)) {
                console.warn(`[posthog-sourcemaps] ${clientDir} missing, skipping`)
                return
            }
            // The script never fails the build on an upload error; it only
            // exits non-zero when given no directory, which is guarded above.
            execFileSync('sh', ['scripts/posthog-sourcemaps.sh', clientDir], { cwd: __dirname, stdio: 'inherit' })
        },
    },

    experimental: {
        // A chunk that 404s (stale tab after a deploy rotates _nuxt hashes)
        // reloads the page at once instead of waiting for the next route
        // change. reloadNuxtApp guards the loop with a 10s sessionStorage TTL.
        emitRouteChunkError: 'automatic-immediate',
    },

    // @sentry/nuxt module options (not runtimeConfig). Its source map plugin
    // is on by default even with an empty DSN, and it deletes every public
    // .map after its (skipped) upload — which would leave nothing for PostHog.
    sentry: {
        sourceMapsUploadOptions: { enabled: false },
    },

    app: {
        head: {
            meta: [
                {
                    // Nuxt's default viewport tag, plus the one addition:
                    // `interactive-widget=resizes-content` makes Chromium shrink
                    // the layout viewport when the on-screen keyboard opens, so a
                    // full-screen sheet (the support panel on a phone) keeps its
                    // composer above the keyboard instead of behind it. It is
                    // Chromium-only and does nothing on iOS Safari — the
                    // visualViewport listeners in SupportPanel.vue are the half
                    // that works everywhere. Declared here because this config
                    // carried no `app.head` at all.
                    name: 'viewport',
                    content: 'width=device-width, initial-scale=1, interactive-widget=resizes-content',
                },
            ],
        },
    },

    modules: [
        '@nuxtjs/tailwindcss',
        '@pinia/nuxt',
        '@nuxt/image',
        '@vite-pwa/nuxt',
        '@sentry/nuxt/module',
        '@nuxt/icon',
        'pinia-plugin-persistedstate/nuxt',
        ['@nuxtjs/i18n', {
            // Both stated explicitly. They match the module defaults, but the repo
            // previously carried a second, unread `apps/web/locales/` directory that
            // features kept adding strings to — the `providers.*` keys sat there
            // unrendered from the day they were written. Pinning the path means the
            // live directory is readable from this file instead of inferred.
            restructureDir: 'i18n',
            langDir: 'locales',
            locales: [
                { code: 'en', name: 'English', file: 'en.json' },
                { code: 'am', name: 'አማርኛ', file: 'am.json' },
            ],
            defaultLocale: 'en',
            strategy: 'no_prefix',
            detectBrowserLanguage: {
                useCookie: true,
                cookieKey: 'wb_locale',
                redirectOn: 'root',
            },
        }],
    ],

    icon: {
        serverBundle: 'remote',
    },

    css: [
        '@world-bingo/ui/theme/tokens.base.css',
        '~/assets/css/theme.css',
        '~/assets/css/components.css',
        // Both load unconditionally; the data-theme attribute on <html> (set by
        // plugins/00.brand.ts) selects which block applies. SSR-rendered, so no flash.
        '~/assets/css/themes/arada.css',
        '~/assets/css/themes/dash5.css',
    ],

    runtimeConfig: {
        jwtSecret: '',
        // Server-side only override — mapped from NUXT_API_BASE_SERVER env var.
        // When running in Docker, set this to http://api:8080 so SSR calls
        // reach the API container instead of localhost (which doesn't resolve).
        apiBaseServer: '',
        // Upstream origins for server/routes/ingest/[...].ts. Private (server
        // -only) on purpose: the browser talks to the same-origin /ingest path
        // and never needs to know where it lands.
        posthogProxyTarget: POSTHOG_PROXY_TARGET,
        posthogAssetsProxyTarget: POSTHOG_ASSETS_PROXY_TARGET,
        public: {
            apiBase: 'http://localhost:8080',
            wsUrl: 'http://localhost:8080',
            telegramBotName: '',
            telegramBotId: '',
            // Renders the mock "Past results" section on the fight card.
            // STAGING ONLY — see utils/mockSettledMarkets.ts. The data is not
            // real, so this must stay unset on any production deployment.
            // Mapped from NUXT_PUBLIC_SHOW_MOCK_HISTORY.
            showMockHistory: false,
            // Sentry (GlitchTip) error reporting. Auto-mapped from
            // NUXT_PUBLIC_SENTRY_DSN / NUXT_PUBLIC_SENTRY_ENVIRONMENT.
            // Empty DSN = fully inert (see sentry.client/server.config.ts).
            sentry: {
                dsn: '',
                environment: '',
            },
            // PostHog product analytics. Auto-mapped from NUXT_PUBLIC_POSTHOG_KEY,
            // NUXT_PUBLIC_POSTHOG_HOST, NUXT_PUBLIC_POSTHOG_UI_HOST,
            // NUXT_PUBLIC_POSTHOG_REPLAY, NUXT_PUBLIC_POSTHOG_BRAND.
            // Empty key = fully inert (see plugins/02.posthog.client.ts).
            posthog: {
                key: '',
                host: '/ingest',
                uiHost: 'https://eu.posthog.com',
                replay: 'true',
                brand: '',
            },
        },
    },

    routeRules: {
        '/auth/**': { ssr: true },
        '/wallet': { ssr: true },
        '/': { ssr: false },
        '/quick/**': { ssr: false },
        '/play/**': { ssr: false },
        '/profile': { ssr: false },
        '/transactions': { ssr: false },
        '/ads/hero/**': {
            headers: {
                'cache-control': 'public, max-age=31536000, immutable',
            },
        },
        // NOTE: /ingest/** is deliberately NOT a route rule. routeRules.proxy
        // goes through h3's proxyRequest, which forwards the request's `cookie`
        // header — and the persisted auth store lives in a cookie, so every
        // event batch shipped the player's JWTs and profile to PostHog.
        // server/routes/ingest/[...].ts proxies it with those headers stripped.
        '/api/**': { proxy: `${API_PROXY_TARGET}/**` },
        '/socket.io/': { proxy: `${API_PROXY_TARGET}/socket.io/` },
        '/v1/**': { proxy: `${API_PROXY_TARGET}/v1/**` },
        // Serve brand logo/favicon (and any uploaded asset) through the API.
        '/uploads/**': { proxy: `${API_PROXY_TARGET}/uploads/**` }
    },

    pwa: {
        registerType: 'autoUpdate',
        manifest: {
            name: 'Arada Bingo',
            short_name: 'Arada',
            theme_color: '#f5a623',
            background_color: '#0a1628',
        },
    },

    tailwindcss: {
        configPath: './tailwind.config.ts',
        exposeConfig: false,
    },

    image: {
        quality: 80,
        format: ['webp', 'jpg'],
    },

    vite: {
        resolve: {
            alias: {
                '@world-bingo/ui': resolve(__dirname, '../../packages/ui/src'),
                '@world-bingo/game-logic': resolve(__dirname, '../../packages/game-logic/src/index.ts'),
                '@world-bingo/shared-types': resolve(__dirname, '../../packages/shared-types/src/index.ts'),
            },
        },
    },
})
