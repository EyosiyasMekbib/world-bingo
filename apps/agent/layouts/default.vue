<script setup lang="ts">
const { user, logout } = useAgentAuth()
const { profile, loadIfMissing } = useAgentProfile()

const route = useRoute()

const navItems = [
  { label: 'Fulfil', to: '/' },
  { label: 'History', to: '/history' },
]

const isNavActive = (to: string) => (to === '/' ? route.path === '/' : route.path.startsWith(to))

const signingOut = ref(false)

const handleSignOut = async () => {
  if (signingOut.value) return
  signingOut.value = true
  try {
    await logout()
  } finally {
    signingOut.value = false
  }
}

onMounted(() => {
  loadIfMissing()
})
</script>

<template>
  <div class="agent-shell">
    <header class="agent-header">
      <div class="header-left">
        <NuxtLink to="/" class="wordmark">
          <span class="wordmark__brand">ARADA</span>
          <span class="wordmark__rule" aria-hidden="true"></span>
          <span class="wordmark__app">AGENT</span>
        </NuxtLink>

        <nav class="header-nav" aria-label="Main">
          <NuxtLink
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            class="nav-link"
            :class="{ 'nav-link--active': isNavActive(item.to) }"
            :aria-current="isNavActive(item.to) ? 'page' : undefined"
          >
            {{ item.label }}
          </NuxtLink>
        </nav>
      </div>

      <div class="header-right">
        <div class="identity">
          <span class="identity__name">{{
            profile?.displayName || user?.username || 'Agent'
          }}</span>
          <span class="identity__shop">{{ profile?.shopName || 'Loading shop' }}</span>
        </div>

        <button type="button" class="signout-btn" :disabled="signingOut" @click="handleSignOut">
          <UIcon name="i-heroicons:arrow-left-on-rectangle" class="w-4 h-4" />
          <span>Sign out</span>
        </button>
      </div>
    </header>

    <main class="agent-main">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.agent-shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--surface-base);
  color: var(--text-primary);
}

/* ── Header ──────────────────────────────────────────────────────────── */
.agent-header {
  position: sticky;
  top: 0;
  z-index: 40;
  height: 58px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 0 24px;
  background: rgba(3, 12, 34, 0.96);
  border-bottom: 1px solid var(--surface-border);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 28px;
  min-width: 0;
}

.wordmark {
  display: flex;
  align-items: center;
  gap: 9px;
  text-decoration: none;
  font-family: var(--font-ui);
  line-height: 1;
  white-space: nowrap;
}
.wordmark:focus-visible {
  outline: 2px solid var(--brand-primary);
  outline-offset: 4px;
  border-radius: 4px;
}

.wordmark__brand {
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--brand-primary);
}

.wordmark__rule {
  width: 1px;
  height: 16px;
  background: var(--surface-border);
}

.wordmark__app {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.22em;
  color: var(--text-muted);
}

.header-nav {
  display: flex;
  align-items: center;
  gap: 4px;
}

.nav-link {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 14px;
  border-radius: 7px;
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
  text-decoration: none;
  border: 1px solid transparent;
  transition:
    color 0.12s ease,
    background 0.12s ease,
    border-color 0.12s ease;
}
.nav-link:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.05);
}
.nav-link:focus-visible {
  outline: 2px solid var(--brand-primary);
  outline-offset: 2px;
}

.nav-link--active {
  color: var(--brand-primary);
  background: var(--brand-glow);
  border-color: color-mix(in srgb, var(--brand-primary) 28%, transparent);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.identity {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  line-height: 1.25;
  min-width: 0;
}

.identity__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}

.identity__shop {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}

.signout-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 12px;
  border-radius: 7px;
  background: none;
  border: 1px solid var(--surface-border);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
}
.signout-btn:hover:not(:disabled) {
  background: rgba(248, 113, 113, 0.08);
  border-color: rgba(248, 113, 113, 0.3);
  color: #f87171;
}
.signout-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.signout-btn:focus-visible {
  outline: 2px solid var(--brand-primary);
  outline-offset: 2px;
}

/* ── Main ────────────────────────────────────────────────────────────── */
.agent-main {
  flex: 1;
  min-height: 0;
  padding: 28px 24px 48px;
}

@media (min-width: 1280px) {
  .agent-main {
    padding: 32px 32px 56px;
  }
}

/* The counter is a desktop tool, but a header that collapses is still cheaper
   than one that overflows off the edge of a small shop screen. */
@media (max-width: 720px) {
  .agent-header {
    height: auto;
    flex-wrap: wrap;
    gap: 10px;
    padding: 10px 16px;
  }
  .header-left {
    gap: 16px;
  }
  .identity {
    align-items: flex-start;
  }
  .agent-main {
    padding: 20px 16px 40px;
  }
}
</style>
