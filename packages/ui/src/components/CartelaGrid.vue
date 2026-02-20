<template>
  <div class="cartela-grid">
    <div v-for="(col, ci) in COLUMNS" :key="ci" class="cartela-col-header">{{ col }}</div>
    <template v-for="(row, ri) in grid" :key="ri">
      <div
        v-for="(cell, ci) in row"
        :key="ci"
        class="cartela-cell"
        :class="{
          'cartela-cell--free': ri === 2 && ci === 2,
          'cartela-cell--marked': isMarked(ri, ci),
        }"
        @click="emit('mark', { row: ri, col: ci })"
      >
        <span v-if="ri === 2 && ci === 2">FREE</span>
        <span v-else>{{ cell }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
const COLUMNS = ['B', 'I', 'N', 'G', 'O']

const props = defineProps<{
  grid: number[][]
  calledBalls: Set<number>
}>()

const emit = defineEmits<{
  mark: [payload: { row: number; col: number }]
}>()

function isMarked(row: number, col: number): boolean {
  if (row === 2 && col === 2) return true
  return props.calledBalls.has(props.grid[row][col])
}
</script>
