import { resolve } from 'path'

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
            brand: 'arada', // overridden per-deployment by NUXT_PUBLIC_BRAND
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
        '/api/**': { proxy: 'http://api:8080/**' },
        '/socket.io/': { proxy: 'http://api:8080/socket.io/' },
        '/v1/**': { proxy: 'http://api:8080/v1/**' }
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
