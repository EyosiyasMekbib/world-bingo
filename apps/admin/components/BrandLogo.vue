<script setup lang="ts">
import { useBrand } from '~/composables/useBrand'

withDefaults(defineProps<{ height?: number }>(), { height: 28 })
const brand = useBrand()
</script>

<template>
  <img
    v-if="brand.logoUrl"
    :src="brand.logoUrl"
    :alt="brand.displayName"
    class="brand-logo"
    :style="{ height: `${height}px` }"
    decoding="async"
  />
  <span v-else class="brand-wordmark" :style="{ fontSize: `${height * 0.65}px` }">
    {{ brand.displayName }}
  </span>
</template>

<style scoped>
.brand-logo {
  display: block;
  width: auto;
  object-fit: contain;
}
.brand-wordmark {
  display: inline-block;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--brand-primary);
  white-space: nowrap;
  line-height: 1;
}
</style>
