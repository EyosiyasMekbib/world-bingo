<template>
  <div class="bingo-ball" :class="`ball--${column.toLowerCase()}`" :aria-label="`${column} ${number}`">
    <span class="ball__column">{{ column }}</span>
    <span class="ball__number">{{ number }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  number: number
  isAnimating?: boolean
}>()

const column = computed(() => {
  if (props.number <= 15) return 'B'
  if (props.number <= 30) return 'I'
  if (props.number <= 45) return 'N'
  if (props.number <= 60) return 'G'
  return 'O'
})
</script>

<style scoped>
.bingo-ball {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 120px;
  height: 120px;
  border-radius: var(--radius-full);
  border: 3px solid currentColor;
  background: radial-gradient(circle at 35% 35%, rgba(255,255,255,0.15), transparent 60%),
              var(--surface-raised);
  position: relative;
  animation: v-bind("isAnimating ? 'ball-enter var(--duration-xslow) var(--ease-bounce)' : 'none'");
}

.bingo-ball.ball--b { color: var(--ball-b); box-shadow: 0 0 32px rgba(245,158,11,0.4); }
.bingo-ball.ball--i { color: var(--ball-i); box-shadow: 0 0 32px rgba(6,182,212,0.4); }
.bingo-ball.ball--n { color: var(--ball-n); box-shadow: 0 0 32px rgba(139,92,246,0.4); }
.bingo-ball.ball--g { color: var(--ball-g); box-shadow: 0 0 32px rgba(16,185,129,0.4); }
.bingo-ball.ball--o { color: var(--ball-o); box-shadow: 0 0 32px rgba(239,68,68,0.4); }

.ball__column {
  font-family: var(--font-game);
  font-size: var(--text-lg);
  font-weight: 700;
  letter-spacing: 0.1em;
  opacity: 0.85;
  line-height: 1;
}

.ball__number {
  font-family: var(--font-game);
  font-size: var(--text-4xl);
  font-weight: 700;
  line-height: 1;
}
</style>
