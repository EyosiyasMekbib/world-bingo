<script setup lang="ts">
const {
  auth,
  locale,
  showDeposit,
  showWithdrawal,
  mobileNavOpen,
  search,
  predictionsEnabled,
  formattedBalance,
  playerId,
  toggleLocale,
  submitSearch,
  handleLogout,
} = useAppShell()
</script>

<template>
  <!-- Utility bar -->
  <header class="d5-util">
    <NuxtLink to="/" class="d5-logo" aria-label="Home">
      <BrandLogo :height="26" />
    </NuxtLink>

    <div class="d5-search">
      <input
        v-model="search"
        class="d5-search-input"
        type="search"
        placeholder="Search Games"
        @keyup.enter="submitSearch"
      />
      <button class="d5-search-btn" aria-label="Search" @click="submitSearch">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="7" />
          <path stroke-linecap="round" d="m20 20-3.5-3.5" />
        </svg>
      </button>
    </div>

    <div class="d5-util-end">
      <template v-if="auth.isAuthenticated">
        <div class="d5-balance">
          <strong>{{ formattedBalance }} <span>ETB</span></strong>
          <small>ID: {{ playerId }}</small>
        </div>
        <button class="d5-btn d5-btn--primary" @click="showDeposit = true">Deposit</button>
        <button class="d5-btn d5-btn--ghost" @click="showWithdrawal = true">Withdraw</button>
        <button class="d5-btn d5-btn--ghost" @click="handleLogout">Logout</button>
      </template>
      <template v-else>
        <NuxtLink to="/auth/login" class="d5-btn d5-btn--ghost">Login</NuxtLink>
        <NuxtLink to="/auth/register" class="d5-btn d5-btn--primary">Register</NuxtLink>
      </template>
      <button class="d5-lang" @click="toggleLocale">{{ locale === 'en' ? 'EN' : 'አማ' }}</button>
    </div>
  </header>

  <!-- Nav strip -->
  <nav class="d5-nav">
    <button class="d5-burger" aria-label="Menu" @click="mobileNavOpen = !mobileNavOpen">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>
    <NuxtLink to="/" class="d5-nav-link" exact-active-class="d5-nav-active">Home</NuxtLink>
    <NuxtLink to="/games/mini" class="d5-nav-link" active-class="d5-nav-active">Aviator</NuxtLink>
    <NuxtLink to="/games" class="d5-nav-link" exact-active-class="d5-nav-active">Games</NuxtLink>
    <NuxtLink
      v-if="predictionsEnabled"
      to="/predictions"
      class="d5-nav-link"
      active-class="d5-nav-active"
    >
      Fights
    </NuxtLink>
    <NuxtLink to="/promotions" class="d5-nav-link" active-class="d5-nav-active">Promotions</NuxtLink>
    <NuxtLink to="/wallet" class="d5-nav-link" active-class="d5-nav-active">Deposit</NuxtLink>
    <NuxtLink to="/transactions" class="d5-nav-link" active-class="d5-nav-active">History</NuxtLink>
  </nav>
</template>
