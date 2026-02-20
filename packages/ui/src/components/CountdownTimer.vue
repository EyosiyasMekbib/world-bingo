<template>
  <div class="countdown" :class="[`countdown--${size}`, urgencyClass]" :aria-label="`${secondsRemaining} seconds remaining`">
    <svg class="countdown__ring" viewBox="0 0 80 80">
      <circle class="countdown__ring-bg" cx="40" cy="40" r="34" />
      <circle
        class="countdown__ring-progress"
        cx="40"
        cy="40"
        r="34"
        :style="{ strokeDashoffset: dashOffset }"
      />
    </svg>
    <span class="countdown__number">{{ displaySeconds }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  secondsRemaining: number
  totalSeconds: number
  size?: 'sm' | 'lg'
}>()

const CIRCUMFERENCE = 2 * Math.PI * 34

const dashOffset = computed(() => {
  const pct = Math.max(0, props.secondsRemaining / props.totalSeconds)
  return CIRCUMFERENCE * (1 - pct)
})

const displaySeconds = computed(() => {
  if (props.secondsRemaining >= 60) {
    const m = Math.floor(props.secondsRemaining / 60)
    const s = (props.secondsRemaining % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }
  return props.secondsRemaining
})

const urgencyClass = computed(() => {
  if (props.secondsRemaining < 10) return 'countdown--critical'
  if (props.secondsRemaining < 30) return 'countdown--warning'
  return ''
})
</script>

<style scoped>
.countdown {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
}

.countdown--lg {
  width: 88px;
  height: 88px;
}

.countdown__ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.countdown__ring-bg {
  fill: none;
  stroke: var(--surface-border);
  stroke-width: 4;
}

.countdown__ring-progress {
  fill: none;
  stroke: var(--accent-primary);
  stroke-width: 4;
  stroke-linecap: round;
  stroke-dasharray: 213.6;
  transition: stroke-dashoffset 1s linear, stroke var(--duration-fast);
}

.countdown--warning .countdown__ring-progress {
  stroke: var(--brand-primary);
}

.countdown--critical .countdown__ring-progress {
  stroke: var(--status-error);
}

.countdown__number {
  font-family: var(--font-game);
  font-weight: 700;
  font-size: var(--text-base);
  color: var(--text-primary);
  z-index: 1;
}

.countdown--lg .countdown__number {
  font-size: var(--text-2xl);
}

.countdown--critical .countdown__number {
  color: var(--status-error);
  animation: pulse-red 0.8s ease infinite;
}
</style>
