export default defineNuxtConfig({
    compatibilityDate: '2024-11-01',
    devtools: { enabled: true },

    modules: [
        ['@nuxt/ui', { fonts: false }],
        '@pinia/nuxt',
        '@nuxtjs/i18n',
    ],

    app: {
        head: {
            htmlAttrs: { class: 'dark' },
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
        jwtSecret: '',
        apiBaseServer: 'http://localhost:8080', // overridden by NUXT_API_BASE_SERVER in Docker (http://api:8080)
        public: {
            apiBase: 'http://localhost:8080',
        },
    },

    vite: {
        resolve: {
            alias: {
                '@world-bingo/ui': '../../packages/ui/src',
                '@world-bingo/shared-types': '../../packages/shared-types/src/index.ts',
            },
        },
    },
})
