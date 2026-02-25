<template>
  <div :class="compact ? 'countdown-inline' : 'countdown-bar'">
    <template v-if="compact">
      <span class="countdown-time-inline">{{ display }}</span>
    </template>
    <template v-else>
      <div class="countdown-icon">⏱️</div>
      <div class="countdown-text">
        <span class="countdown-label">Starting in</span>
        <span class="countdown-time">{{ display }}</span>
      </div>
      <div class="countdown-progress">
        <div class="countdown-progress-fill" :style="{ width: progressPct + '%' }" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  startsAt: string
  compact?: boolean
}>()

const remaining = ref(0)
const totalDuration = ref(60)
let timer: ReturnType<typeof setInterval> | null = null

const display = computed(() => {
  if (remaining.value <= 0) return 'Starting...'
  const s = Math.ceil(remaining.value)
  return `${s}s`
})

const progressPct = computed(() => {
  if (totalDuration.value <= 0) return 0
  return Math.max(0, (remaining.value / totalDuration.value) * 100)
})

function tick() {
  const now = Date.now()
  const target = new Date(props.startsAt).getTime()
  remaining.value = Math.max(0, (target - now) / 1000)
}

onMounted(() => {
  // Calculate total duration from now
  const target = new Date(props.startsAt).getTime()
  const now = Date.now()
  totalDuration.value = Math.max(1, (target - now) / 1000)
  remaining.value = totalDuration.value

  tick()
  timer = setInterval(tick, 250)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.countdown-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.75rem;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.2);
  margin-top: 0.5rem;
}

.countdown-icon {
  font-size: 1rem;
  flex-shrink: 0;
}

.countdown-text {
  display: flex;
  flex-direction: column;
  gap: 0;
  min-width: 0;
}

.countdown-label {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #94a3b8;
  font-weight: 600;
}

.countdown-time {
  font-family: 'Rajdhani', sans-serif;
  font-size: 1.25rem;
  font-weight: 700;
  color: #f59e0b;
  line-height: 1.1;
}

.countdown-progress {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.countdown-progress-fill {
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, #f59e0b, #d97706);
  transition: width 0.3s ease;
}

/* compact / inline mode */
.countdown-inline {
  display: inline;
}
.countdown-time-inline {
  font-family: 'Rajdhani', sans-serif;
  font-weight: 800;
  color: #fbbf24;
  font-size: inherit;
  line-height: inherit;
}
</style>
