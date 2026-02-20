<template>
  <div class="app-layout">
    <header>
      <h1>World Bingo</h1>
      <nav>
        <NuxtLink to="/">Lobby</NuxtLink>
        <div v-if="auth.isAuthenticated">
          <span>{{ auth.user?.username }}</span> | 
          <span>{{ auth.wallet?.balance }} ETB</span>
        </div>
        <NuxtLink v-else to="/auth/login">Login</NuxtLink>
      </nav>
    </header>
    <main>
      <slot />
    </main>
  </div>
</template>

<script setup lang="ts">
const auth = useAuth()
</script>

<style scoped>
.app-layout {
  min-height: 100vh;
  background-color: var(--color-background);
  color: var(--color-text-primary);
  font-family: var(--font-family-body);
}

header {
  display: flex;
  justify-content: space-between;
  padding: var(--spacing-md);
  background-color: var(--color-surface);
}

nav {
  display: flex;
  gap: var(--spacing-md);
}
</style>
