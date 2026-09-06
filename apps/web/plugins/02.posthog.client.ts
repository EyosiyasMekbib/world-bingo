/**
 * PostHog browser SDK. Client-only; fully env-gated.
 *
 * Empty NUXT_PUBLIC_POSTHOG_KEY → this plugin provides `$posthog = null` and
 * nothing else runs. useAnalytics() and store/auth.ts check for null.
 *
 * Runs after 00.brand.ts (brand is loaded) and after the Pinia module plugin
 * (the persisted auth store is hydrated), so a returning player is identified
 * on the very first page load, not only after the next login.
 *
 * autocapture is OFF on purpose: a game screen redraws every few seconds and
 * click-everything would bury the named events. Session replay masks every
 * input and anything marked data-ph-mask, and blocks uploaded receipt images.
 */
import posthog, { type PostHog } from 'posthog-js'
import {
  brandSlug,
  buildPersonProps,
  buildSuperProps,
  isStandaloneDisplay,
  resolveReplayEnabled,
} from '~/utils/posthog'

export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig()
  const ph = config.public.posthog
  const key = ph?.key || ''

  if (!key) {
    return { provide: { posthog: null as PostHog | null } }
  }

  const brand = brandSlug({ brand: ph.brand, shortName: useBrand().value.shortName })

  posthog.init(key, {
    api_host: ph.host || '/ingest',
    ui_host: ph.uiHost || 'https://eu.posthog.com',
    person_profiles: 'identified_only',
    capture_pageview: 'history_change',
    capture_pageleave: true,
    autocapture: false,
    disable_session_recording: !resolveReplayEnabled(ph.replay),
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '[data-ph-mask]',
      blockSelector: 'img[src*="/uploads/"], [data-ph-block]',
    },
  })

  const i18n = nuxtApp.$i18n as { locale?: { value?: string } } | undefined
  const locale = i18n?.locale?.value || 'en'
  // Passed as an adapter object rather than `window` itself: `Navigator` (the
  // real DOM type) declares no `standalone` property — it's a non-standard
  // iOS Safari extension — so TS's weak-type check rejects `window` directly.
  const standalone = isStandaloneDisplay({
    matchMedia: (query) => window.matchMedia(query),
    navigator: window.navigator as { standalone?: boolean },
  })
  posthog.register(buildSuperProps({ brand, locale, standalone }))

  const auth = useAuth()
  if (auth.user) {
    posthog.identify(auth.user.id, buildPersonProps(auth.user, brand))
  }

  return { provide: { posthog: posthog as PostHog | null } }
})
