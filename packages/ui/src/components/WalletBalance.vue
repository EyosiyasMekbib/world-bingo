<template>
  <button class="wallet-badge" @click="emit('click')" :title="`Balance: ETB ${balance.toFixed(2)}`">
    <span class="wallet-badge__icon">💰</span>
    <span ref="displayRef" class="wallet-badge__amount" :class="flashClass">
      ETB {{ displayBalance.toFixed(2) }}
    </span>
  </button>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

const props = defineProps<{ balance: number }>()
const emit = defineEmits<{ click: [] }>()

const displayBalance = ref(props.balance)
const flashClass = ref('')

watch(() => props.balance, (newVal, oldVal) => {
  const increased = newVal > oldVal
  flashClass.value = increased ? 'wallet-badge__amount--up' : 'wallet-badge__amount--down'

  const start = oldVal
  const end = newVal
  const duration = 500
  const startTime = performance.now()

  function step(now: number) {
    const elapsed = Math.min((now - startTime) / duration, 1)
    const eased = 1 - Math.pow(1 - elapsed, 3)
    displayBalance.value = start + (end - start) * eased
    if (elapsed < 1) requestAnimationFrame(step)
    else displayBalance.value = end
  }

  requestAnimationFrame(step)

  nextTick(() => {
    setTimeout(() => { flashClass.value = '' }, 800)
  })
})
</script>

<style scoped>
.wallet-badge {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  background: var(--surface-overlay);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-full);
  padding: var(--space-2) var(--space-4);
  cursor: pointer;
  transition: background var(--duration-fast), border-color var(--duration-fast);
}

.wallet-badge:hover {
  background: var(--surface-raised);
  border-color: var(--brand-primary);
}

.wallet-badge__icon {
  font-size: var(--text-base);
}

.wallet-badge__amount {
  font-family: var(--font-game);
  font-weight: 700;
  font-size: var(--text-base);
  color: var(--brand-primary);
  transition: color var(--duration-fast);
}

.wallet-badge__amount--up {
  color: var(--status-success);
  animation: flash-green 0.8s ease;
}

.wallet-badge__amount--down {
  color: var(--status-error);
  animation: flash-red 0.8s ease;
}

@keyframes flash-green {
  0%   { background: rgba(16, 185, 129, 0.25); border-radius: var(--radius-sm); }
  100% { background: transparent; }
}

@keyframes flash-red {
  0%   { background: rgba(239, 68, 68, 0.25); border-radius: var(--radius-sm); }
  100% { background: transparent; }
}
</style>
