export default defineNuxtConfig({
    compatibilityDate: '2024-11-01',
    devtools: { enabled: true },

    modules: [
        '@pinia/nuxt',
        '@nuxt/image',
        '@vite-pwa/nuxt',
        'nuxt-icon',
        'pinia-plugin-persistedstate/nuxt',
        ['@nuxtjs/i18n', {
            locales: [
                { code: 'en', name: 'English', file: 'en.json' },
                { code: 'am', name: 'አማርኛ', file: 'am.json' },
            ],
            defaultLocale: 'en',
            langDir: 'locales/',
            strategy: 'no_prefix',
            detectBrowserLanguage: {
                useCookie: true,
                cookieKey: 'wb_locale',
                redirectOn: 'root',
            },
        }],
    ],

    css: ['@world-bingo/ui/styles/tokens.css'],

    runtimeConfig: {
        jwtSecret: '',
        public: {
            apiBase: 'http://localhost:8080',
            wsUrl: 'http://localhost:8080',
        },
    },

    routeRules: {
        '/auth/**': { ssr: true },
        '/wallet': { ssr: true },
        '/': { ssr: false },
        '/quick/**': { ssr: false },
    },

    pwa: {
        registerType: 'autoUpdate',
        manifest: {
            name: 'World Bingo',
            short_name: 'Bingo',
            theme_color: '#f59e0b',
            background_color: '#0a0d14',
        },
    },

    image: {
        quality: 80,
        format: ['webp', 'jpg'],
    },

    vite: {
        resolve: {
            alias: {
                '@world-bingo/ui': '../../../packages/ui/src',
            },
        },
    },
})
