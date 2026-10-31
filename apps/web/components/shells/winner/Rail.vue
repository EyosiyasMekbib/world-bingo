<script setup lang="ts">
/** drawerOnly: no desktop column, just the phone drawer (the wide shell). */
defineProps<{ drawerOnly?: boolean }>()

const { auth, search, predictionsEnabled, referralsEnabled, showWithdrawal, submitSearch, handleLogout } =
  useAppShell()

// Shared with Chrome's Menu tab. useAppShell's mobileNavOpen is a plain ref, so
// each caller would get its own copy and the tab could never open this drawer.
const open = useState('winner-rail-open', () => false)
const route = useRoute()
watch(() => route.fullPath, () => (open.value = false))
// Some navigations remount the shell instead, so the watcher never sees them
// while the shared state is still true.
onMounted(() => (open.value = false))

function withdraw() {
  open.value = false
  showWithdrawal.value = true
}
</script>

<template>
  <div v-if="open" class="wn-scrim" aria-hidden="true" @click="open = false" />
  <aside
    class="wn-rail"
    :class="{ 'wn-rail--open': open, 'wn-rail--drawer-only': drawerOnly }"
    @keydown.esc="open = false"
  >
    <form class="wn-search" role="search" @submit.prevent="submitSearch">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input v-model="search" type="search" placeholder="Search games, providers" aria-label="Search games" />
    </form>

    <nav class="wn-rail-list" aria-label="Game rooms">
      <NuxtLink to="/games" class="wn-rail-row" exact-active-class="wn-rail-row--active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
        <span>All Games</span>
      </NuxtLink>
      <NuxtLink to="/games/trending" class="wn-rail-row" active-class="wn-rail-row--active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>
        <span>Trending</span>
      </NuxtLink>
      <NuxtLink to="/games/bingo" class="wn-rail-row" active-class="wn-rail-row--active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><path d="M12 10.5v3" /></svg>
        <span>Bingo</span>
      </NuxtLink>
      <NuxtLink to="/aviator" class="wn-rail-row" active-class="wn-rail-row--active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4 3 11l7 2.5L12.5 21 21 4Z" /><path d="m10 13.5 5-5" /></svg>
        <span>Aviator</span>
      </NuxtLink>
      <NuxtLink to="/games/slots" class="wn-rail-row" active-class="wn-rail-row--active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /><path d="M5 12h2M11 12h2M17 12h2" /></svg>
        <span>Slots</span>
      </NuxtLink>
      <NuxtLink to="/games/live" class="wn-rail-row" active-class="wn-rail-row--active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2" /><path d="m8 2 4 4 4-4" /><path d="m10.5 10 4 2.5-4 2.5v-5Z" /></svg>
        <span>Live Casino</span>
      </NuxtLink>
      <NuxtLink to="/games/table" class="wn-rail-row" active-class="wn-rail-row--active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="12" height="16" rx="2" /><path d="M8 21h10a2 2 0 0 0 2-2V7" /><path d="M10 8.5 8 11l2 2.5 2-2.5-2-2.5Z" /></svg>
        <span>Table Games</span>
      </NuxtLink>
      <NuxtLink to="/games/crash" class="wn-rail-row" active-class="wn-rail-row--active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c6 0 12-5 15-14" /><path d="M14 6h5v5" /></svg>
        <span>Crash</span>
      </NuxtLink>
      <NuxtLink to="/games/mini" class="wn-rail-row" active-class="wn-rail-row--active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="1.2" /><circle cx="15" cy="15" r="1.2" /><circle cx="15" cy="9" r="1.2" /><circle cx="9" cy="15" r="1.2" /></svg>
        <span>Mini Games</span>
      </NuxtLink>
      <NuxtLink v-if="predictionsEnabled" to="/predictions" class="wn-rail-row" active-class="wn-rail-row--active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></svg>
        <span>Fights</span>
      </NuxtLink>
      <NuxtLink to="/tournaments" class="wn-rail-row" active-class="wn-rail-row--active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4" /><path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" /><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4" /></svg>
        <span>Tournaments</span>
      </NuxtLink>
    </nav>

    <p class="wn-rail-label">Account</p>
    <nav class="wn-rail-list" aria-label="Account">
      <NuxtLink to="/wallet" class="wn-rail-row" active-class="wn-rail-row--active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11" /><path d="M16 13.5h2" /></svg>
        <span>Wallet</span>
      </NuxtLink>
      <NuxtLink to="/transactions" class="wn-rail-row" active-class="wn-rail-row--active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        <span>History</span>
      </NuxtLink>
      <NuxtLink to="/profile" class="wn-rail-row" active-class="wn-rail-row--active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" /></svg>
        <span>Profile</span>
      </NuxtLink>
      <NuxtLink v-if="referralsEnabled" to="/refer" class="wn-rail-row" active-class="wn-rail-row--active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><path d="M19 8v6M16 11h6" /></svg>
        <span>Refer &amp; Earn</span>
      </NuxtLink>
      <template v-if="auth.isAuthenticated">
        <button class="wn-rail-row" @click="withdraw">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M4 21h16" /></svg>
          <span>Withdraw</span>
        </button>
        <button class="wn-rail-row" @click="handleLogout">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l-5-5 5-5" /><path d="M5 12h11" /></svg>
          <span>Logout</span>
        </button>
      </template>
    </nav>
  </aside>
</template>
