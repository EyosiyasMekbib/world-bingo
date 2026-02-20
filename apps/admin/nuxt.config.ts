export default defineNuxtConfig({
    compatibilityDate: '2024-11-01',
    devtools: { enabled: true },

    modules: ['@nuxt/ui', '@pinia/nuxt'],

    css: ['@world-bingo/ui/styles/tokens.css'],

    runtimeConfig: {
        jwtSecret: '',
        public: {
            apiBase: 'http://localhost:8080',
        },
    },

    routeMiddleware: ['auth'],

    vite: {
        resolve: {
            alias: {
                '@world-bingo/ui': '../../../packages/ui/src',
            },
        },
    },
})
