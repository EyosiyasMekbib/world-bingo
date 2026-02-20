<template>
  <div class="lobby-page">
    <h2>Available Games</h2>
    <div v-if="loading">Loading games...</div>
    <div v-else class="games-grid">
      <div v-for="game in games" :key="game.id" class="game-card">
        <h3>{{ game.title }}</h3>
        <p>Price: {{ game.ticketPrice }} ETB</p>
        <p>Players: {{ game.currentPlayers || 0 }} / {{ game.maxPlayers }}</p>
        <p>Status: {{ game.status }}</p>
        <NuxtLink :to="`/quick/${game.id}`" class="join-btn">Join Game</NuxtLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Game } from '@world-bingo/shared-types'

const config = useRuntimeConfig()
const { data: games, pending: loading } = await useFetch<Game[]>(`${config.public.apiBase}/games`)

</script>

<style scoped>
.lobby-page {
  padding: 2rem;
}
.games-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 1rem;
  margin-top: 1rem;
}
.game-card {
  padding: 1rem;
  background: var(--color-surface);
  border: 1px solid var(--color-primary);
  border-radius: 8px;
}
.join-btn {
  display: inline-block;
  margin-top: 0.5rem;
  padding: 0.5rem 1rem;
  background: var(--color-primary);
  color: #fff;
  text-decoration: none;
  border-radius: 4px;
}
</style>
