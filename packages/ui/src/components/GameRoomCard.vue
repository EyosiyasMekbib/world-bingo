<template>
  <div
    class="game-card"
    :class="{
      'game-card--full': playerCount >= maxPlayers,
      'game-card--urgent': secondsRemaining < 30 && secondsRemaining > 0,
    }"
    @click="!isFull && !isJoining && emit('join')"
  >
    <div class="game-card__price">
      <span class="game-card__price-label">ETB</span>
      <span class="game-card__price-value">{{ ticketPrice }}</span>
    </div>

    <div class="game-card__divider"></div>

    <div class="game-card__meta">
      <div class="game-card__stat">
        <span class="game-card__stat-icon">👥</span>
        <span>{{ playerCount }}/{{ maxPlayers }}</span>
      </div>
      <div class="game-card__stat" :class="{ 'game-card__stat--urgent': secondsRemaining < 30 }">
        <span class="game-card__stat-icon">⏱</span>
        <span>{{ formattedTime }}</span>
      </div>
    </div>

    <div class="game-card__prize">
      Prize Pool: ETB {{ prizePool.toFixed(2) }}
    </div>

    <button
      class="game-card__btn"
      :disabled="isFull || isJoining"
      @click.stop="emit('join')"
    >
      <span v-if="isJoining" class="game-card__spinner"></span>
      <span v-else-if="isFull">FULL</span>
      <span v-else>JOIN GAME</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  ticketPrice: number
  playerCount: number
  minPlayers: number
  maxPlayers: number
  secondsRemaining: number
  prizePool: number
  isJoining?: boolean
}>()

const emit = defineEmits<{ join: [] }>()

const isFull = computed(() => props.playerCount >= props.maxPlayers)

const formattedTime = computed(() => {
  const m = Math.floor(props.secondsRemaining / 60).toString().padStart(2, '0')
  const s = (props.secondsRemaining % 60).toString().padStart(2, '0')
  return `${m}:${s}`
})
</script>

<style scoped>
.game-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-xl);
  padding: var(--space-6);
  cursor: pointer;
  transition:
    transform var(--duration-fast) var(--ease-out),
    box-shadow var(--duration-fast) var(--ease-out);
  animation: slide-up var(--duration-normal) var(--ease-out) both;
}

.game-card:hover {
  transform: translateY(-4px) scale(1.01);
  box-shadow: var(--shadow-card), 0 0 30px var(--brand-primary-glow);
  border-color: var(--brand-primary);
}

.game-card--full {
  opacity: 0.6;
  cursor: not-allowed;
}

.game-card--urgent .game-card__stat--urgent {
  animation: pulse-red 0.8s ease infinite;
}

.game-card__price {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.game-card__price-label {
  font-family: var(--font-game);
  font-size: var(--text-lg);
  color: var(--text-secondary);
  font-weight: 600;
}

.game-card__price-value {
  font-family: var(--font-game);
  font-size: var(--text-4xl);
  font-weight: 700;
  color: var(--brand-primary);
  line-height: 1;
}

.game-card__divider {
  height: 1px;
  background: var(--surface-border);
}

.game-card__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.game-card__stat {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-game);
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--text-secondary);
}

.game-card__stat-icon {
  font-size: var(--text-lg);
}

.game-card__prize {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  text-align: center;
}

.game-card__btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  height: 48px;
  background: var(--brand-primary);
  color: var(--text-on-brand);
  font-family: var(--font-game);
  font-size: var(--text-lg);
  font-weight: 700;
  letter-spacing: 0.05em;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition:
    background var(--duration-fast),
    box-shadow var(--duration-fast),
    transform var(--duration-fast);
}

.game-card__btn:hover:not(:disabled) {
  background: var(--brand-primary-dim);
  box-shadow: 0 0 20px var(--brand-primary-glow);
  transform: translateY(-1px);
}

.game-card__btn:disabled {
  background: var(--surface-overlay);
  color: var(--text-disabled);
  cursor: not-allowed;
  box-shadow: none;
}

.game-card__spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(0, 0, 0, 0.3);
  border-top-color: #000;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
