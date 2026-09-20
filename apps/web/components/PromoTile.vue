<script setup lang="ts">
import type { PromotionProgressDto, PublicPromotionDto } from '@world-bingo/shared-types'

const props = withDefaults(
  defineProps<{
    promo: PublicPromotionDto
    progress?: PromotionProgressDto | null
    size?: 'carousel' | 'phone' | 'wide'
  }>(),
  { progress: null, size: 'carousel' },
)

const { t, te } = useI18n()

/**
 * The kicker colour, the left glow and the progress fill for each accent
 * family. Only four exist because `accent` is a closed union — a fifth would
 * have to be designed, not defaulted.
 *
 * The emerald rail is the one value not drawn in an artboard: emerald is the
 * referral tile, which has no progress. It follows the other three (a 700 shade
 * into a 400) so a future emerald promotion with a bar does not stand out.
 */
const ACCENTS = {
  amber: {
    kick: '#fcd34d',
    glow: 'rgba(245,158,11,0.34)',
    rail: 'linear-gradient(90deg, #b45309, #f59e0b)',
  },
  cyan: {
    kick: '#67e8f9',
    glow: 'rgba(34,211,238,0.26)',
    rail: 'linear-gradient(90deg, #0e7490, #22d3ee)',
  },
  emerald: {
    kick: '#6ee7b7',
    glow: 'rgba(52,211,153,0.22)',
    rail: 'linear-gradient(90deg, #047857, #34d399)',
  },
  rose: {
    kick: '#fda4af',
    glow: 'rgba(251,113,133,0.24)',
    rail: 'linear-gradient(90deg, #9f1239, #fb7185)',
  },
} as const

const accent = computed(() => ACCENTS[props.promo.accent] ?? ACCENTS.amber)

/**
 * An uploaded banner that 404s would otherwise leave a broken-image icon on an
 * otherwise blank tile. Falling back to the generated stack means a retired
 * asset costs the promotion its artwork and nothing else.
 */
const artworkBroken = ref(false)
watch(
  () => props.promo.artwork?.imageUrl,
  () => {
    artworkBroken.value = false
  },
)
const artwork = computed(() => (artworkBroken.value ? null : props.promo.artwork))

/**
 * The watermark behind the generated stack. The artboards hand-letter it per
 * promotion ('%', '24H', 'VS'); with nothing in the DTO to carry that, it
 * echoes the figure — or the percent sign, where the figure is a percentage and
 * repeating the digits twice reads as a typo.
 */
const mark = computed(() => (props.promo.unit.includes('%') ? '%' : props.promo.figure))

/**
 * 'ETB' sits a word-space off the figure, '% BACK' sits flush against it. An
 * em-relative margin rather than a literal space so the gap tracks the figure
 * size across the three sizes.
 */
const unitSpaced = computed(() => !props.promo.unit.trimStart().startsWith('%'))

/**
 * The chip is the only copy the tile owns; everything else is API-supplied.
 * 'Deposit' is already translated under the wallet keys. The referral label has
 * no key yet, so it ships English until the Amharic pass adds one — a visible
 * `promo.chip_link` would be worse than the word itself.
 */
const chipLabel = computed(() => {
  if (props.promo.action === 'deposit') return t('wallet.deposit')
  if (props.promo.action !== 'referral') return ''
  return te('promo.chip_link') ? t('promo.chip_link') : 'Link'
})

/** Null whenever there is nothing honest to draw, so the rail stays absent. */
const bar = computed(() => {
  const p = props.progress
  if (!p || !(p.target > 0)) return null
  // Clamped: a player who has already passed the target must not push the fill
  // past the tile edge while the payout waits for the period to close.
  return { ...p, pct: Math.min(100, Math.max(0, (p.current / p.target) * 100)) }
})

/** Intrinsic size for the <img>, so a landing banner cannot reflow the row. */
const IMG_BOX = {
  carousel: { width: 225, height: 75 },
  phone: { width: 300, height: 100 },
  wide: { width: 342, height: 114 },
} as const
const imgBox = computed(() => IMG_BOX[props.size])
</script>

<template>
  <NuxtLink :to="promo.href" class="tile" :class="`tile--${size}`">
    <img
      v-if="artwork"
      class="art"
      :src="artwork.imageUrl"
      :alt="artwork.altText || promo.name"
      :width="imgBox.width"
      :height="imgBox.height"
      @error="artworkBroken = true"
    />
    <template v-else>
      <div class="ground" :style="{ '--glow': accent.glow }" />
      <div class="lattice" />
      <div class="vignette" />
      <div class="mark" aria-hidden="true">{{ mark }}</div>
      <div class="body">
        <div class="stack">
          <p class="fig metal">
            {{ promo.figure }}<span class="unit" :class="{ 'unit--spaced': unitSpaced }">{{ promo.unit }}</span>
          </p>
          <span class="kick" :style="{ color: accent.kick }">{{ promo.name }}</span>
          <!-- Only the full-width tile has the room; below 114px tall the
               figure and the kicker are the whole story. -->
          <span v-if="size === 'wide' && promo.sub" class="sub">{{ promo.sub }}</span>
        </div>
        <span v-if="chipLabel" class="chip" :class="{ 'chip--light': promo.action === 'referral' }">
          {{ chipLabel }}
        </span>
        <svg
          v-else
          class="chev"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.3"
          aria-hidden="true"
        >
          <path d="m9 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
    </template>

    <!-- The scrim only earns its keep over artwork; the generated ground is
         already dark enough at the bottom edge. -->
    <div v-if="bar && artwork" class="railscrim" />
    <div
      v-if="bar"
      class="rail"
      role="progressbar"
      :aria-label="bar.label"
      :aria-valuenow="bar.current"
      aria-valuemin="0"
      :aria-valuemax="bar.target"
      :aria-valuetext="bar.hint"
    >
      <div class="fill" :style="{ width: `${bar.pct}%`, background: accent.rail }" />
    </div>
  </NuxtLink>
</template>

<style scoped>
/* Geometry and colour are lifted verbatim from
   docs/design/bonus-cashback/PromoCards.dc.html, which was itself tuned against
   the live stylesheets. The tile carries its own metal and navy rather than the
   brand tokens on purpose: one metal for the whole promo family, so variety
   comes from uploaded artwork and not from five competing accents. Only the
   fonts go through the theme, because they are the one part a brand replaces.

   3:1 at every size. border-box because five 225px tiles and four 16px gaps
   have three pixels to spare in a 1192px row — borders outside the box would
   overflow it. */
.tile {
  position: relative;
  display: block;
  width: 225px;
  height: 75px;
  flex-shrink: 0;
  box-sizing: border-box;
  border-radius: 12px;
  overflow: hidden;
  background: #0e1729;
  border: 1px solid rgba(255, 255, 255, 0.09);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.45);
  isolation: isolate;
  color: inherit;
  text-decoration: none;
  transition: transform 0.16s ease;
}
.tile:hover {
  transform: translateY(-1px);
}
.tile:focus-visible {
  outline: 2px solid #fcd34d;
  outline-offset: 2px;
}

/* isolation above is what lets these sit behind the body without escaping the
   tile's own background. */
.ground {
  position: absolute;
  inset: 0;
  z-index: -3;
  background:
    radial-gradient(70% 180% at 6% 50%, var(--glow), transparent 64%),
    linear-gradient(100deg, #1a2748 0%, #121e36 52%, #0b1223 100%);
}
.lattice {
  position: absolute;
  inset: 0;
  z-index: -2;
  background-image:
    repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.03) 0 1px, transparent 1px 14px),
    repeating-linear-gradient(-45deg, rgba(255, 255, 255, 0.03) 0 1px, transparent 1px 14px);
}
.vignette {
  position: absolute;
  inset: 0;
  z-index: -1;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
}
.mark {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  z-index: -1;
  font-family: var(--font-heading);
  font-weight: 700;
  font-size: 62px;
  line-height: 0.8;
  letter-spacing: -2px;
  color: rgba(255, 255, 255, 0.045);
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
}

/* Both filters matter: the first is the bevel that seats the figure on the
   ground, the second is the glow that makes it read as metal. */
.metal {
  background: linear-gradient(180deg, #fff6d0 0%, #fcd34d 26%, #f0a51b 58%, #a8570a 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 1px 0 rgba(0, 0, 0, 0.5)) drop-shadow(0 4px 12px rgba(245, 158, 11, 0.24));
}

.body {
  position: relative;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 13px;
  box-sizing: border-box;
}
.stack {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.fig {
  font-family: var(--font-heading);
  font-weight: 700;
  font-size: 26px;
  line-height: 1;
  letter-spacing: -0.3px;
  margin: 0;
  white-space: nowrap;
}
.unit {
  font-size: 13px;
  letter-spacing: 1.5px;
}
.unit--spaced {
  margin-left: 0.24em;
}
.kick {
  font-family: var(--font-ui);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 1.6px;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 12px rather than the artboard's 11.5: this is the only sentence on the tile
   and it has to clear the body-text floor. */
.sub {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip {
  font-family: var(--font-ui);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border-radius: 7px;
  background: linear-gradient(180deg, #fbbf24, #f59e0b);
  color: #1a1205;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  white-space: nowrap;
  box-shadow:
    0 4px 10px rgba(245, 158, 11, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.4);
}
/* Referral is the one white chip — it points off to a link, not at money. */
.chip--light {
  background: linear-gradient(180deg, #ffffff, #dbe3ee);
  color: #0b1120;
  box-shadow:
    0 4px 10px rgba(0, 0, 0, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.8);
}
/* 0.55 rather than the artboard's 0.4: it is the tile's only affordance when
   there is no chip, and it has to stay visible on a phone in daylight. */
.chev {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  color: rgba(255, 255, 255, 0.55);
}

/* Artwork fills the tile edge to edge. The rail is the only thing ever drawn
   over it, which is what makes a personalised tile cost none of the design. */
.art {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.rail {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(0, 0, 0, 0.42);
}
.rail .fill {
  height: 100%;
}
.railscrim {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 14px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.45), transparent);
  pointer-events: none;
}

/* ── phone · 300 x 100 ─────────────────────────────────────────────────── */
.tile--phone {
  width: 300px;
  height: 100px;
  border-radius: 14px;
}
.tile--phone .mark {
  font-size: 84px;
}
.tile--phone .body {
  padding: 0 17px;
}
.tile--phone .stack {
  gap: 3px;
}
.tile--phone .fig {
  font-size: 34px;
}
.tile--phone .unit {
  font-size: 16px;
}
.tile--phone .kick {
  font-size: 11px;
}
.tile--phone .chip {
  height: 34px;
  font-size: 12.5px;
  padding: 0 14px;
}
.tile--phone .chev {
  width: 18px;
  height: 18px;
}

/* ── wide · full width at 342 x 114 ────────────────────────────────────── */
.tile--wide {
  width: 100%;
  height: 114px;
  border-radius: 14px;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
}
.tile--wide .lattice {
  background-image:
    repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.03) 0 1px, transparent 1px 16px),
    repeating-linear-gradient(-45deg, rgba(255, 255, 255, 0.03) 0 1px, transparent 1px 16px);
}
.tile--wide .mark {
  right: 10px;
  font-size: 96px;
  letter-spacing: -3px;
}
.tile--wide .metal {
  filter: drop-shadow(0 1px 0 rgba(0, 0, 0, 0.5)) drop-shadow(0 5px 14px rgba(245, 158, 11, 0.24));
}
.tile--wide .body {
  gap: 12px;
  padding: 0 18px;
}
.tile--wide .stack {
  gap: 4px;
}
.tile--wide .fig {
  font-size: 38px;
  letter-spacing: -0.5px;
}
.tile--wide .unit {
  font-size: 18px;
  letter-spacing: 2px;
}
.tile--wide .kick {
  font-size: 11px;
  letter-spacing: 1.7px;
}
.tile--wide .chip {
  height: 36px;
  padding: 0 16px;
  border-radius: 8px;
  font-size: 13px;
  box-shadow:
    0 5px 12px rgba(245, 158, 11, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.4);
}
.tile--wide .chev {
  width: 18px;
  height: 18px;
}
.tile--wide .railscrim {
  height: 18px;
}

@media (prefers-reduced-motion: reduce) {
  .tile {
    transition: none;
  }
  .tile:hover {
    transform: none;
  }
}
</style>
