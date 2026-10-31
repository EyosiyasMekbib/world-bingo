<script setup lang="ts">
const {
  auth,
  locale,
  showDeposit,
  showWithdrawal,
  predictionsEnabled,
  referralsEnabled,
  formattedBalance,
  playerId,
  toggleLocale,
  handleLogout,
} = useAppShell()

// Opens Rail.vue as a drawer below 900px; hidden above that, where the rail is a column.
const menuOpen = useState('winner-rail-open', () => false)
</script>

<template>
  <!-- Top bar -->
  <header class="wn-top">
    <NuxtLink to="/" class="wn-logo" aria-label="Home">
      <BrandLogo :height="34" />
    </NuxtLink>

    <nav class="wn-quick" aria-label="Quick links">
      <NuxtLink to="/aviator" class="wn-quick-link">Aviator</NuxtLink>
      <NuxtLink to="/promotions" class="wn-quick-link">Bonuses</NuxtLink>
      <NuxtLink to="/tournaments" class="wn-quick-link">Tournaments</NuxtLink>
      <NuxtLink v-if="referralsEnabled" to="/refer" class="wn-quick-link">Refer &amp; Earn</NuxtLink>
    </nav>

    <div class="wn-top-end">
      <template v-if="auth.isAuthenticated">
        <div class="wn-balance" role="button" tabindex="0" title="Deposit" @click="showDeposit = true" @keydown.enter.prevent="showDeposit = true">
          <strong>{{ formattedBalance }} <span>ETB</span></strong>
          <small>ID: {{ playerId }}</small>
        </div>
        <NotificationBell />
        <button class="wn-btn wn-btn--primary" @click="showDeposit = true">Deposit</button>
        <button class="wn-btn wn-btn--light wn-hide-sm" @click="showWithdrawal = true">Withdraw</button>
        <button class="wn-icon-btn wn-hide-sm" aria-label="Logout" title="Logout" @click="handleLogout">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l-5-5 5-5" /><path d="M5 12h11" /></svg>
        </button>
      </template>
      <template v-else>
        <NuxtLink to="/auth/login" class="wn-btn wn-btn--light">Login</NuxtLink>
        <NuxtLink to="/auth/register" class="wn-btn wn-btn--primary">Join</NuxtLink>
      </template>
      <button class="wn-lang" @click="toggleLocale">{{ locale === 'en' ? 'EN' : 'አማ' }}</button>
    </div>
  </header>

  <!-- Icon nav -->
  <nav class="wn-nav" aria-label="Main">
    <button class="wn-tab wn-tab--menu" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
      <span>Menu</span>
    </button>
    <NuxtLink to="/" class="wn-tab" exact-active-class="wn-tab--active">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M10 21v-6h4v6" /></svg>
      <span>Home</span>
    </NuxtLink>
    <NuxtLink to="/games" class="wn-tab" exact-active-class="wn-tab--active">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
      <span>Casino</span>
    </NuxtLink>
    <NuxtLink to="/games/bingo" class="wn-tab" active-class="wn-tab--active">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><path d="M12 10.5v3" /></svg>
      <span>Bingo</span>
    </NuxtLink>
    <NuxtLink to="/aviator" class="wn-tab" active-class="wn-tab--active">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4 3 11l7 2.5L12.5 21 21 4Z" /><path d="m10 13.5 5-5" /></svg>
      <span>Aviator</span>
    </NuxtLink>
    <NuxtLink to="/games/slots" class="wn-tab" active-class="wn-tab--active">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 4v16" /><path d="M5 12h2M11 12h2M17 12h2" /></svg>
      <span>Slots</span>
    </NuxtLink>
    <NuxtLink to="/games/live" class="wn-tab" active-class="wn-tab--active">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2" /><path d="m8 2 4 4 4-4" /><path d="m10.5 10 4 2.5-4 2.5v-5Z" /></svg>
      <span>Live</span>
    </NuxtLink>
    <NuxtLink v-if="predictionsEnabled" to="/predictions" class="wn-tab" active-class="wn-tab--active">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></svg>
      <span>Fights</span>
    </NuxtLink>
    <NuxtLink to="/promotions" class="wn-tab" active-class="wn-tab--active">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="5" rx="1" /><path d="M5 13v8h14v-8" /><path d="M12 8v13" /><path d="M12 8c-1.5-3-5-4-5-1.5S12 8 12 8Zm0 0c1.5-3 5-4 5-1.5S12 8 12 8Z" /></svg>
      <span>Promos</span>
    </NuxtLink>
    <NuxtLink to="/wallet" class="wn-tab" active-class="wn-tab--active">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h15a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11" /><path d="M16 13.5h2" /></svg>
      <span>Deposit</span>
    </NuxtLink>
    <NuxtLink to="/transactions" class="wn-tab" active-class="wn-tab--active">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
      <span>History</span>
    </NuxtLink>
  </nav>
</template>
