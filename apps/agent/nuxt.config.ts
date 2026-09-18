import { resolve } from 'path'

// Internal Docker hostname of THIS deployment's API service. Baked at build time
// (routeRules proxies are static). Defaults to `http://api:8080`; spokes whose api
// service is renamed (e.g. `api-betbawa`) MUST pass --build-arg NUXT_API_PROXY_TARGET
// so agent traffic does not fall through to another stack's `api` alias on dokploy-network.
const API_PROXY_TARGET = process.env.NUXT_API_PROXY_TARGET || 'http://api:8080'

export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  devtools: { enabled: true },

  // Rendered as a single page app on purpose. The agent's tokens live in
  // localStorage, never in a cookie, so the server has no way to know who is
  // signed in and SSR would only ever render the signed-out shell before the
  // client corrected it. A shop laptop loads this once and keeps it open, so
  // there is nothing to win from server rendering and a real risk in the
  // cookie it would need. Nitro still runs, so the routeRules proxies below
  // still apply.
  ssr: false,

  modules: [['@nuxt/ui', { fonts: false }], '@pinia/nuxt', '@nuxt/icon', '@sentry/nuxt/module'],

  icon: {
    serverBundle: 'remote',
    localApiEndpoint: '/_nuxt_icon',
  },

  app: {
    head: {
      htmlAttrs: { class: 'dark' },
      title: 'Arada Agent',
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

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    public: {
      // Same-origin by default: every agent call goes through the Nitro
      // routeRules proxy below, which is the only thing that knows the
      // deployment's real api host. Override with NUXT_PUBLIC_API_BASE
      // only to point a dev build straight at an api that is already
      // reachable from the browser.
      apiBase: '/api',
      // Sentry/GlitchTip - populated from NUXT_PUBLIC_SENTRY_* env vars (Nuxt auto-maps).
      // Empty dsn => Sentry stays inert (see sentry.client.config.ts / sentry.server.config.ts).
      sentry: {
        dsn: '',
        environment: '',
      },
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
