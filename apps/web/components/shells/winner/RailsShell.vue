<script setup lang="ts">
import Chrome from './Chrome.vue'
import Rail from './Rail.vue'

const { auth, openChat } = useAppShell()
</script>

<template>
  <div class="wn-shell">
    <Chrome />

    <div class="wn-body">
      <Rail />

      <main class="wn-main">
        <slot />
      </main>

      <aside class="wn-aside">
        <div class="wn-panel">
          <NuxtLink to="/games/bingo" class="wn-aside-tab">My Cartelas</NuxtLink>
          <NuxtLink to="/transactions" class="wn-aside-tab">My History</NuxtLink>

          <div class="wn-aside-empty">
            <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" aria-hidden="true"><path d="M10 6h28v36l-4.7-3-4.6 3-4.7-3-4.7 3-4.6-3-4.7 3V6Z" /><path stroke-linecap="round" d="M17 16h14M17 23h14M17 30h9" /></svg>
            <template v-if="auth.isAuthenticated">
              <h3>No Active Cartelas</h3>
              <p>Join a bingo room and pick a cartela to see it here.</p>
              <NuxtLink to="/games/bingo" class="wn-btn wn-btn--primary wn-btn--block">Play Bingo</NuxtLink>
            </template>
            <template v-else>
              <h3>Your Cartelas Show Here</h3>
              <p>Log in to follow the games you have joined.</p>
              <NuxtLink to="/auth/login" class="wn-btn wn-btn--primary wn-btn--block">Login</NuxtLink>
            </template>
          </div>
        </div>

        <button class="wn-help" @click="openChat">
          <strong>Need help?</strong>
          <span>Chat with support</span>
        </button>
      </aside>
    </div>

    <footer class="wn-footer">
      <p>Responsible Gaming: 18+ only. Gambling can be addictive — play within your limits.</p>
      <span class="wn-18">18+</span>
    </footer>
  </div>
</template>
