<script setup lang="ts">
import { useBrand } from '~/composables/useBrand'
import { themeLogoFor } from '~/utils/theme-logo'

withDefaults(defineProps<{ height?: number }>(), { height: 30 })
const brand = useBrand()
const logoSrc = computed(() => brand.value.logoUrl || themeLogoFor(brand.value.themeId))
</script>

<template>
  <img
    v-if="logoSrc"
    :src="logoSrc"
    :alt="brand.displayName"
    class="brand-logo"
    :style="{ height: `${height}px` }"
    decoding="async"
  />
  <span v-else class="brand-wordmark" :style="{ fontSize: `${height * 0.6}px` }">
    {{ brand.displayName }}
  </span>
</template>

<style scoped>
.brand-logo {
  display: block;
  width: auto;
}
.brand-wordmark {
  display: inline-block;
  font-family: var(--font-game, sans-serif);
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--brand-primary);
  white-space: nowrap;
}
</style>
