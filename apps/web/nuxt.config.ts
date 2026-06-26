import { resolve } from 'path'

// Internal Docker hostname of THIS deployment's API service. Baked at build time
// (routeRules proxies are static). Defaults to `http://api:8080` for the generic
// deployment; spokes whose api service is renamed (e.g. `api-betbawa`) MUST pass
// --build-arg NUXT_API_PROXY_TARGET so their browser traffic does not fall through
// to another stack's `api` alias on the shared dokploy-network.
const API_PROXY_TARGET = process.env.NUXT_API_PROXY_TARGET || 'http://api:8080'

export default defineNuxtConfig({
    compatibilityDate: '2024-11-01',
    devtools: { enabled: true },

    modules: [
        '@nuxtjs/tailwindcss',
        '@pinia/nuxt',
        '@nuxt/image',
        '@vite-pwa/nuxt',
        '@nuxt/icon',
        'pinia-plugin-persistedstate/nuxt',
        ['@nuxtjs/i18n', {
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
        '@world-bingo/ui/styles/tokens.css',
        '~/assets/css/theme.css',
        '~/assets/css/components.css',
    ],

    runtimeConfig: {
        jwtSecret: '',
        // Server-side only override — mapped from NUXT_API_BASE_SERVER env var.
        // When running in Docker, set this to http://api:8080 so SSR calls
        // reach the API container instead of localhost (which doesn't resolve).
        apiBaseServer: '',
        public: {
            apiBase: 'http://localhost:8080',
            wsUrl: 'http://localhost:8080',
            telegramBotName: '',
            telegramBotId: '',
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
