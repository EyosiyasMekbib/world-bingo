<script setup lang="ts">
import Chrome from './Chrome.vue'

const { auth, mobileNavOpen, predictionsEnabled, referralsEnabled } = useAppShell()
</script>

<template>
  <div class="d5-shell">
    <Chrome />

    <div class="d5-body" :class="{ 'd5-body--nav-open': mobileNavOpen }">
      <aside class="d5-rail">
        <div class="d5-panel">
          <h3 class="d5-panel-head">Game Rooms</h3>
          <NuxtLink to="/games" class="d5-rail-row">All Games</NuxtLink>
          <NuxtLink to="/games/bingo" class="d5-rail-row">Bingo</NuxtLink>
          <NuxtLink to="/games/mini" class="d5-rail-row">Aviator</NuxtLink>
          <NuxtLink to="/games/live" class="d5-rail-row">Live</NuxtLink>
          <NuxtLink v-if="predictionsEnabled" to="/predictions" class="d5-rail-row">Fights</NuxtLink>
        </div>
        <div class="d5-panel">
          <h3 class="d5-panel-head">Account</h3>
          <NuxtLink to="/wallet" class="d5-rail-row">Wallet</NuxtLink>
          <NuxtLink to="/transactions" class="d5-rail-row">History</NuxtLink>
          <NuxtLink to="/profile" class="d5-rail-row">Profile</NuxtLink>
          <NuxtLink v-if="referralsEnabled" to="/refer" class="d5-rail-row">Refer &amp; Earn</NuxtLink>
        </div>
      </aside>

      <main class="d5-main">
        <slot />
      </main>

      <aside class="d5-aside">
        <div class="d5-panel">
          <h3 class="d5-panel-head">My Cartelas</h3>
          <p v-if="!auth.isAuthenticated" class="d5-aside-empty">Log in to see your cartelas.</p>
          <p v-else class="d5-aside-empty">No active cartelas. Join a game to start.</p>
        </div>
      </aside>
    </div>

    <footer class="d5-footer">
      <p>Responsible Gaming: 18+ only. Gambling can be addictive — play within your limits.</p>
      <span class="d5-18">18+</span>
    </footer>
  </div>
</template>
