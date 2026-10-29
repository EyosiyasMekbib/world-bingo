<script setup lang="ts">
/**
 * The Sports tab: IGCORE's sportsbook, framed.
 *
 * Every visit asks the api for a NEW session. The url it returns is one-time and
 * bound to this player, so it lives in a local ref and nowhere else: not a store,
 * not shared or persisted state, not a log line, not an analytics property. Retry
 * and a fresh visit both fetch another one.
 *
 * Only a settled feature flag decides anything. Flags read false while their
 * request is in flight (see useFeatureFlags), so acting earlier would show
 * "unavailable" to a player the sportsbook is switched on for.
 */
import { useAuthStore } from '~/store/auth'
import { describeFailure } from '~/utils/http-failure'

useSeoMeta({ title: 'Sports' })

// Wide, not rails: the frame wants the whole width, not the gap between the
// rail and the aside.
definePageMeta({ shell: 'wide' })

const auth = useAuthStore()
const { locale } = useI18n()
const { track } = useAnalytics()
const { flags, loaded } = useFeatureFlags()

const sportsbookEnabled = computed(() => flags.value.feature_sportsbook === true)
const flagOff = computed(() => loaded.value && !sportsbookEnabled.value)

type Phase = 'loading' | 'ready' | 'error' | 'signin'

// Always 'loading' until onMounted decides, so the server render and the first
// client render agree whatever the player's login state is.
const phase = ref<Phase>('loading')
const showAuthPrompt = ref(false)
const url = ref<string | null>(null)

/** Bumped per request, so an answer to an earlier one (or to a page since left) is dropped. */
let attempt = 0

function fail(code: string) {
  phase.value = 'error'
  track('sportsbook_unavailable', { code })
}

async function open() {
  const mine = ++attempt
  url.value = null

  // Flag off: the template already says so, and there is nothing to ask for.
  if (!sportsbookEnabled.value) return

  if (!auth.isAuthenticated) {
    phase.value = 'signin'
    showAuthPrompt.value = true
    return
  }

  phase.value = 'loading'
  try {
    // Always a JSON body: an empty one with a JSON content-type is a 400.
    const session = await auth.apiFetch<{ url: string }>('/sportsbook/session', {
      method: 'POST',
      body: { lang: locale.value },
    })
    if (mine !== attempt) return
    if (typeof session?.url !== 'string' || !session.url) return fail('NO_SESSION_URL')
    url.value = session.url
    phase.value = 'ready'
    track('sportsbook_opened')
  } catch (e) {
    if (mine !== attempt) return
    // Whatever the status (503 off, 403 restricted, 500, a dropped connection),
    // the player sees the same thing. The server's `code` is kept for analytics.
    fail(describeFailure(e).code)
  }
}

/** A fresh session and a fresh frame; the old url is never reused. */
function retry() {
  void open()
}

let started = false
function start() {
  if (started || !loaded.value) return
  started = true
  void open()
}

onMounted(() => {
  // Client only, so the session is never requested during server rendering.
  watch(loaded, start, { immediate: true })
})

onBeforeUnmount(() => {
  attempt++
})
</script>

<template>
  <div class="sports-page">
    <div v-if="flagOff || phase === 'error'" class="sports-state" role="status" aria-live="polite">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <p class="sports-state-text">Sports is unavailable right now</p>
      <button v-if="!flagOff" class="sports-btn" @click="retry">Retry</button>
    </div>

    <!-- data-ph-block: session replay serialises an iframe's src, and this one is
         a one-time session url (02.posthog.client.ts blocks [data-ph-block]). -->
    <iframe
      v-else-if="phase === 'ready' && url"
      :src="url"
      class="sports-frame"
      title="Sportsbook"
      allow="fullscreen"
      data-ph-block
    />

    <div v-else-if="phase === 'signin'" class="sports-state">
      <p class="sports-state-text">Sign in to bet on sports</p>
      <button class="sports-btn" @click="showAuthPrompt = true">Sign in</button>
    </div>

    <div v-else class="sports-state" role="status" aria-live="polite">
      <div class="sports-spinner" aria-hidden="true"></div>
      <p class="sports-state-text">Loading sports…</p>
    </div>

    <AuthPromptModal v-model="showAuthPrompt" />
  </div>
</template>

<style scoped>
.sports-page {
  /* Fills what the Winner shell leaves under its chrome. That chrome is two strips
     stacked above the page, the top bar (--util-h) and the icon nav (--nav-h);
     the nav is not a bottom tab bar here, so nothing covers the frame from below.
     winner.css drops them to 56px and 68px at 900px with literals rather than by
     changing the tokens, so the phone sizes are repeated below. */
  height: calc(100dvh - var(--util-h, 64px) - var(--nav-h, 84px));
  /* A short landscape phone scrolls instead of getting a sliver of a frame. */
  min-height: 420px;
  background: var(--skin-head-bg, linear-gradient(150deg, #020b20 0%, #061535 55%, #0c2248 100%));
}

@media (max-width: 900px) {
  .sports-page {
    height: calc(100dvh - 56px - 68px);
  }
}

.sports-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}

.sports-state {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 24px;
  text-align: center;
  color: rgba(var(--skin-cool-rgb, 200, 215, 240), 0.75);
}

.sports-state-text {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.sports-spinner {
  width: 44px;
  height: 44px;
  border: 2px solid rgba(255, 255, 255, 0.08);
  border-top-color: var(--skin-amber, #f59e0b);
  border-radius: 50%;
  animation: sports-spin 0.75s linear infinite;
}

.sports-btn {
  padding: 10px 28px;
  border: 0;
  border-radius: 8px;
  background: var(--skin-amber, #f59e0b);
  color: var(--skin-on-amber, #0a0f1a);
  font-family: inherit;
  font-size: 14px;
  font-weight: 800;
  cursor: pointer;
}

.sports-btn:hover {
  background: var(--skin-amber-light, #fbbf24);
}

.sports-btn:focus-visible {
  outline: 2px solid var(--skin-amber, #f59e0b);
  outline-offset: 2px;
}

@keyframes sports-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
