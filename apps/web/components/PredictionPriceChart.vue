<script setup lang="ts">
/**
 * Probability-over-time chart for one binary market — the Polymarket line.
 *
 * WHY HAND-ROLLED SVG, NOT A CHART LIBRARY. This is one series on a mobile PWA.
 * A charting dependency would add weight to the bundle and bring defaults that
 * read as generic; an inline SVG themes to the brand tokens exactly and lets the
 * mark specs (2px line, low-alpha area, a dashed 50% reference, a crosshair on
 * hover, the current value labelled at the end) be built to spec rather than
 * fought. The market being binary, ONE line tells the whole story: it tracks the
 * first fighter, and the other is always its mirror across 50%, so a second line
 * would be redundant. Price reads directly as that fighter's chance in percent.
 *
 * The colour rule from the data-viz method: the LINE carries identity (brand
 * amber); every number and label wears an ink token, never the series colour.
 */
import { computed, ref } from 'vue'
import type { PredictionHistoryPoint } from '@world-bingo/shared-types'

const props = defineProps<{
  points: PredictionHistoryPoint[]
  /** The fighter the line tracks. Named in the header so no legend box is needed. */
  outcomeLabel: string
  /** Share face value, so price → percent without assuming 100. */
  shareValue: number
  loading?: boolean
}>()

// ── Geometry. A fixed viewBox the SVG scales into; padding leaves room for the
//    axis labels and the end dot so nothing clips at the edges. ────────────────
const VW = 640
const VH = 260
const PAD = { top: 16, right: 44, bottom: 22, left: 34 }
const plotW = VW - PAD.left - PAD.right
const plotH = VH - PAD.top - PAD.bottom

type Range = '1h' | '1d' | 'all'
const range = ref<Range>('all')
const RANGES: { key: Range; ms: number | null; label: string }[] = [
  { key: '1h', ms: 60 * 60 * 1000, label: '1H' },
  { key: '1d', ms: 24 * 60 * 60 * 1000, label: '1D' },
  { key: 'all', ms: null, label: 'All' },
]

interface PlotPoint {
  x: number
  y: number
  t: number
  pct: number
}

/** Points inside the selected time window, projected to plot coordinates. */
const plotted = computed<PlotPoint[]>(() => {
  const raw = props.points
    .map((p) => ({ t: Date.parse(p.t), price: Number(p.price) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.price))
  if (raw.length === 0) return []

  const win = RANGES.find((r) => r.key === range.value)?.ms ?? null
  const latest = raw[raw.length - 1]!.t
  const visible = win === null ? raw : raw.filter((p) => p.t >= latest - win)
  // A window that clips everything but the last point would draw nothing; fall
  // back to the whole series so a range toggle never blanks the chart.
  const series = visible.length >= 2 ? visible : raw

  const tMin = series[0]!.t
  const tMax = series[series.length - 1]!.t
  const span = tMax - tMin || 1

  return series.map((p) => {
    const pct = (p.price / props.shareValue) * 100
    return {
      t: p.t,
      pct,
      x: PAD.left + ((p.t - tMin) / span) * plotW,
      // y inverted: 100% at the top, 0% at the baseline.
      y: PAD.top + (1 - pct / 100) * plotH,
    }
  })
})

const hasData = computed(() => plotted.value.length > 0)

/** The line path. A single point still shows as a dot via the end marker. */
const linePath = computed(() =>
  plotted.value.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' '),
)

/** The area under the line, closed to the baseline for the soft fill. */
const areaPath = computed(() => {
  const pts = plotted.value
  if (pts.length === 0) return ''
  const base = PAD.top + plotH
  const top = pts.map((p) => `L${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ')
  return `M${pts[0]!.x.toFixed(2)} ${base} ${top} L${pts[pts.length - 1]!.x.toFixed(2)} ${base} Z`
})

const yRefY = PAD.top + 0.5 * plotH // the 50% line
const baselineY = PAD.top + plotH

const latest = computed(() => (hasData.value ? plotted.value[plotted.value.length - 1]! : null))

// ── Hover / crosshair. Move over the plot → snap to the nearest point, draw a
//    vertical crosshair, show a tooltip with the time and the exact chance. ────
const hoverIndex = ref<number | null>(null)
const hovered = computed(() => (hoverIndex.value === null ? null : plotted.value[hoverIndex.value] ?? null))
const svgEl = ref<SVGSVGElement | null>(null)

function onMove(evt: PointerEvent) {
  const pts = plotted.value
  const svg = svgEl.value
  if (!svg || pts.length === 0) return
  const rect = svg.getBoundingClientRect()
  // Client px → viewBox x. The SVG scales uniformly on width, so one ratio maps.
  const vx = ((evt.clientX - rect.left) / rect.width) * VW
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i < pts.length; i++) {
    const d = Math.abs(pts[i]!.x - vx)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  hoverIndex.value = best
}

function onLeave() {
  hoverIndex.value = null
}

function fmtTime(t: number): string {
  const d = new Date(t)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function fmtPct(pct: number): string {
  return `${Math.round(pct)}%`
}

/** Tooltip x, kept inside the plot so it never spills past the right edge. */
const tooltipX = computed(() => {
  if (!hovered.value) return 0
  const half = 62
  return Math.min(Math.max(hovered.value.x, PAD.left + half), PAD.left + plotW - half)
})
</script>

<template>
  <div class="pc">
    <div class="pc-head">
      <div class="pc-titles">
        <span class="pc-outcome">{{ outcomeLabel }}</span>
        <span class="pc-sub">{{ $t('prediction.chartChance') }}</span>
      </div>
      <div v-if="latest" class="pc-now">
        <span class="pc-now-val">{{ fmtPct(latest.pct) }}</span>
        <span class="pc-now-label">{{ $t('prediction.chartNow') }}</span>
      </div>
    </div>

    <div class="pc-plot">
      <!-- Empty + loading are real states: a market with no trades has no line. -->
      <div v-if="loading" class="pc-empty">{{ $t('prediction.chartLoading') }}</div>
      <div v-else-if="!hasData" class="pc-empty">
        <svg viewBox="0 0 24 24" class="pc-empty-icon" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M3 3v18h18" stroke-linecap="round" />
          <path d="M7 14l4-4 3 3 4-6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <p class="pc-empty-title">{{ $t('prediction.chartEmptyTitle') }}</p>
        <p class="pc-empty-note">{{ $t('prediction.chartEmptyNote') }}</p>
      </div>

      <svg
        v-else
        ref="svgEl"
        :viewBox="`0 0 ${VW} ${VH}`"
        class="pc-svg"
        preserveAspectRatio="none"
        role="img"
        :aria-label="$t('prediction.chartAria', { name: outcomeLabel })"
        @pointermove="onMove"
        @pointerdown="onMove"
        @pointerleave="onLeave"
      >
        <defs>
          <linearGradient id="pc-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--brand-primary)" stop-opacity="0.22" />
            <stop offset="100%" stop-color="var(--brand-primary)" stop-opacity="0" />
          </linearGradient>
        </defs>

        <!-- Recessive reference lines. Text tokens, not the series colour. -->
        <line :x1="PAD.left" :y1="baselineY" :x2="PAD.left + plotW" :y2="baselineY" class="pc-axis" />
        <line :x1="PAD.left" :y1="yRefY" :x2="PAD.left + plotW" :y2="yRefY" class="pc-ref" />
        <text :x="PAD.left - 6" :y="PAD.top + 4" class="pc-ytick" text-anchor="end">100%</text>
        <text :x="PAD.left - 6" :y="yRefY + 4" class="pc-ytick" text-anchor="end">50%</text>
        <text :x="PAD.left - 6" :y="baselineY + 2" class="pc-ytick" text-anchor="end">0%</text>

        <path :d="areaPath" fill="url(#pc-fill)" />
        <path :d="linePath" class="pc-line" fill="none" />

        <!-- Crosshair on hover -->
        <g v-if="hovered">
          <line :x1="hovered.x" :y1="PAD.top" :x2="hovered.x" :y2="baselineY" class="pc-cross" />
          <circle :cx="hovered.x" :cy="hovered.y" r="4.5" class="pc-cross-dot" />
        </g>

        <!-- Current value marker, always shown at the end of the line -->
        <circle v-if="latest" :cx="latest.x" :cy="latest.y" r="4" class="pc-end-dot" />
      </svg>

      <!-- Tooltip is HTML over the SVG so its text uses real font tokens -->
      <div
        v-if="hovered"
        class="pc-tip"
        :style="{ left: `${(tooltipX / VW) * 100}%`, top: `${(hovered.y / VH) * 100}%` }"
      >
        <span class="pc-tip-pct">{{ fmtPct(hovered.pct) }}</span>
        <span class="pc-tip-time">{{ fmtTime(hovered.t) }}</span>
      </div>
    </div>

    <div v-if="hasData" class="pc-ranges">
      <button
        v-for="r in RANGES"
        :key="r.key"
        type="button"
        class="pc-range"
        :class="{ 'pc-range-on': range === r.key }"
        @click="range = r.key"
      >
        {{ r.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.pc {
  background: var(--surface-raised);
  border: 1px solid var(--surface-border);
  border-radius: 14px;
  padding: 14px 14px 10px;
}
.pc-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}
.pc-titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pc-outcome {
  font-family: var(--font-ui);
  font-weight: 700;
  font-size: 0.95rem;
  color: var(--text-primary);
}
.pc-sub {
  font-size: 0.72rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.pc-now {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  line-height: 1.1;
}
.pc-now-val {
  font-family: var(--font-ui);
  font-weight: 800;
  font-size: 1.35rem;
  /* The headline number is ink, not the series colour — the line carries hue. */
  color: var(--text-primary);
}
.pc-now-label {
  font-size: 0.65rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.pc-plot {
  position: relative;
  width: 100%;
}
.pc-svg {
  width: 100%;
  height: auto;
  display: block;
  touch-action: none;
}
.pc-axis {
  stroke: var(--surface-border);
  stroke-width: 1;
}
.pc-ref {
  stroke: var(--surface-border);
  stroke-width: 1;
  stroke-dasharray: 3 4;
}
.pc-ytick {
  fill: var(--text-secondary);
  font-family: var(--font-ui);
  font-size: 11px;
}
.pc-line {
  stroke: var(--brand-primary);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
.pc-cross {
  stroke: var(--text-secondary);
  stroke-width: 1;
  stroke-dasharray: 2 3;
  opacity: 0.7;
}
.pc-cross-dot {
  fill: var(--brand-primary);
  stroke: var(--surface-raised);
  stroke-width: 2;
}
.pc-end-dot {
  fill: var(--brand-primary);
  stroke: var(--surface-raised);
  stroke-width: 2;
}
.pc-tip {
  position: absolute;
  transform: translate(-50%, calc(-100% - 12px));
  background: var(--surface-overlay, #1c2537);
  border: 1px solid var(--surface-border);
  border-radius: 8px;
  padding: 5px 9px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  pointer-events: none;
  white-space: nowrap;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}
.pc-tip-pct {
  font-family: var(--font-ui);
  font-weight: 800;
  font-size: 0.9rem;
  color: var(--text-primary);
}
.pc-tip-time {
  font-size: 0.68rem;
  color: var(--text-secondary);
}
.pc-ranges {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  justify-content: flex-end;
}
.pc-range {
  font-family: var(--font-ui);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--surface-border);
  border-radius: 999px;
  padding: 3px 12px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.pc-range:hover {
  color: var(--text-primary);
}
.pc-range-on {
  color: var(--text-on-brand, #000);
  background: var(--brand-primary);
  border-color: var(--brand-primary);
}
.pc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 6px;
  min-height: 180px;
  color: var(--text-secondary);
}
.pc-empty-icon {
  width: 34px;
  height: 34px;
  opacity: 0.5;
}
.pc-empty-title {
  font-family: var(--font-ui);
  font-weight: 700;
  color: var(--text-primary);
  margin: 0;
}
.pc-empty-note {
  font-size: 0.82rem;
  max-width: 32ch;
  margin: 0;
}
</style>
