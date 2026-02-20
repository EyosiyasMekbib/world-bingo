<template>
  <div class="cartela" :class="[`cartela--${size}`, { 'cartela--winner': isWinner }]">
    <div class="cartela__header">
      <span v-for="col in COLUMNS" :key="col" class="cartela__col-label">{{ col }}</span>
    </div>
    <div class="cartela__grid">
      <template v-for="(row, ri) in grid" :key="ri">
        <div
          v-for="(cell, ci) in row"
          :key="ci"
          class="cartela__cell"
          :class="{
            'cartela__cell--free': ri === 2 && ci === 2,
            'cartela__cell--marked': isCalled(ri, ci),
            'cartela__cell--winner-line': isWinner && isWinnerCell(ri, ci),
          }"
        >
          <span v-if="ri === 2 && ci === 2">★</span>
          <span v-else>{{ cell }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
const COLUMNS = ['B', 'I', 'N', 'G', 'O']

const props = defineProps<{
  grid: number[][]
  calledNumbers: Set<number>
  isWinner?: boolean
  size?: 'sm' | 'md' | 'lg'
}>()

function isCalled(row: number, col: number): boolean {
  if (row === 2 && col === 2) return true
  return props.calledNumbers.has(props.grid[row][col])
}

function isWinnerCell(_row: number, _col: number): boolean {
  return props.isWinner ?? false
}
</script>

<style scoped>
.cartela {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-lg);
  padding: var(--space-3);
  width: fit-content;
  transition: box-shadow var(--duration-fast) var(--ease-out);
}

.cartela--winner {
  animation: winner-glow-ring 1.2s var(--ease-linear) infinite;
}

.cartela__header {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--space-1);
  margin-bottom: var(--space-1);
}

.cartela__col-label {
  text-align: center;
  font-family: var(--font-game);
  font-weight: 700;
  font-size: var(--text-sm);
  color: var(--brand-primary);
  letter-spacing: 0.08em;
}

.cartela__grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--space-1);
}

.cartela__cell {
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-game);
  font-weight: 600;
  background: var(--cartela-unmarked-bg);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  cursor: default;
  transition: background var(--duration-fast), transform var(--duration-fast);
}

.cartela--sm .cartela__cell {
  width: 32px;
  height: 32px;
  font-size: var(--text-xs);
}

.cartela--md .cartela__cell,
.cartela .cartela__cell {
  width: 44px;
  height: 44px;
  font-size: var(--text-sm);
}

.cartela--lg .cartela__cell {
  width: 56px;
  height: 56px;
  font-size: var(--text-base);
}

.cartela__cell--free {
  background: var(--cartela-free-bg);
  color: var(--cartela-free-text);
  font-size: 1.2em;
}

.cartela__cell--marked {
  background: var(--cartela-marked-bg);
  color: var(--cartela-marked-text);
  box-shadow: 0 0 10px var(--number-called-glow);
  animation: cell-mark var(--duration-normal) var(--ease-bounce);
}

.cartela__cell--winner-line {
  border: 2px solid var(--brand-primary);
  box-shadow: 0 0 12px var(--winner-glow);
}
</style>
