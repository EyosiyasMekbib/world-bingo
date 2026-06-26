import { resolve } from 'path'

// Internal Docker hostname of THIS deployment's API service. Baked at build time
// (routeRules proxies are static). Defaults to `http://api:8080`; spokes whose api
// service is renamed (e.g. `api-betbawa`) MUST pass --build-arg NUXT_API_PROXY_TARGET
// so admin traffic does not fall through to another stack's `api` alias on dokploy-network.
const API_PROXY_TARGET = process.env.NUXT_API_PROXY_TARGET || 'http://api:8080'

export default defineNuxtConfig({
    compatibilityDate: '2024-11-01',
    devtools: { enabled: true },

    modules: [
        ['@nuxt/ui', { fonts: false }],
        '@pinia/nuxt',
        '@nuxtjs/i18n',
        '@nuxt/icon',
    ],

    icon: {
        serverBundle: 'remote',
        localApiEndpoint: '/_nuxt_icon',
    },

    app: {
        head: {
            htmlAttrs: { class: 'dark' },
            link: [
                { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
                { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
                {
                    rel: 'stylesheet',
                    href: 'https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap',
                },
            ],
        },
    },

    i18n: {
        locales: [
            { code: 'en', name: 'English', file: 'en.json' },
            { code: 'am', name: 'አማርኛ', file: 'am.json' },
        ],
        defaultLocale: 'en',
        strategy: 'no_prefix',
        detectBrowserLanguage: {
            useCookie: true,
            cookieKey: 'wb_admin_locale',
            redirectOn: 'root',
        },
    },

    css: ['~/assets/css/main.css'],

    runtimeConfig: {
        // Overridden at runtime by NUXT_API_BASE_SERVER env var (set to http://api:8080 in Docker)
        apiBaseServer: 'http://localhost:8080',
        public: {
            apiBase: 'http://localhost:8080',
        },
    },

    routeRules: {
        '/api/**': { proxy: `${API_PROXY_TARGET}/**` },
        '/socket.io/**': { proxy: `${API_PROXY_TARGET}/socket.io/**` },
        '/uploads/**': { proxy: `${API_PROXY_TARGET}/uploads/**` },
    },

    vite: {
        resolve: {
            alias: {
                '@world-bingo/ui': resolve(__dirname, '../../packages/ui/src'),
                '@world-bingo/shared-types': resolve(__dirname, '../../packages/shared-types/src/index.ts'),
            },
        },
    },
})
