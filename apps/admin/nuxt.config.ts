export default defineNuxtConfig({
    compatibilityDate: '2024-11-01',
    devtools: { enabled: true },

    modules: ['@nuxt/ui', '@pinia/nuxt', '@nuxtjs/i18n'],

    i18n: {
        locales: [
            { code: 'en', name: 'English', file: 'en.json' },
            { code: 'am', name: 'አማርኛ', file: 'am.json' },
        ],
        defaultLocale: 'en',
        langDir: 'locales/',
        strategy: 'no_prefix',
        detectBrowserLanguage: {
            useCookie: true,
            cookieKey: 'wb_admin_locale',
            redirectOn: 'root',
        },
    },

    css: ['@world-bingo/ui/styles/tokens.css'],

    runtimeConfig: {
        jwtSecret: '',
        public: {
            apiBase: 'http://localhost:8080',
        },
    },

    vite: {
        resolve: {
            alias: {
                '@world-bingo/ui': '../../packages/ui/src',
            },
        },
    },
})
