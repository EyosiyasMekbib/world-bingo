<template>
  <div
    class="bingo-ball"
    :class="`bingo-ball--${column.toLowerCase()}`"
    :style="{ '--ball-scale': called ? 1 : 0.85 }"
  >
    <span class="bingo-ball__column">{{ column }}</span>
    <span class="bingo-ball__number">{{ number }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  number: number
  called?: boolean
}>()

const column = computed(() => {
  if (props.number <= 15) return 'B'
  if (props.number <= 30) return 'I'
  if (props.number <= 45) return 'N'
  if (props.number <= 60) return 'G'
  return 'O'
})
</script>
