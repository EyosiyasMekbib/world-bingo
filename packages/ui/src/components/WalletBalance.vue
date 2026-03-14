<template>
  <button class="wallet-balance" @click="emit('click')" aria-label="Open wallet">
    <span class="wallet-balance__icon">💰</span>
    <span class="wallet-balance__amount"
      >ETB
      {{
        balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      }}</span
    >
  </button>
</template>

<script setup lang="ts">
defineProps<{
  balance: number
}>()

const emit = defineEmits<{
  click: []
}>()
</script>

<style scoped>
.wallet-balance {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--surface-overlay);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition:
    background var(--duration-fast),
    border-color var(--duration-fast);
}

.wallet-balance:hover {
  background: var(--surface-raised);
  border-color: var(--brand-primary);
}

.wallet-balance__icon {
  font-size: var(--text-base);
}

.wallet-balance__amount {
  font-family: var(--font-game);
  font-weight: 600;
  font-size: var(--text-sm);
  color: var(--brand-primary);
}

@media (max-width: 767px) {
  .wallet-balance {
    padding: var(--space-1) var(--space-2);
  }

  .wallet-balance__icon {
    display: none;
  }

  .wallet-balance__amount {
    font-size: var(--text-xs);
  }
}
</style>
