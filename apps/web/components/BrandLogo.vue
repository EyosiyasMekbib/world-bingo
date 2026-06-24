<script setup lang="ts">
withDefaults(defineProps<{ height?: number }>(), { height: 30 })
</script>

<template>
  <img
    src="/brands/arada/logo.png"
    alt="AradaBingo"
    class="brand-logo"
    :style="{ height: `${height}px` }"
    decoding="async"
  />
</template>

<style scoped>
.brand-logo {
  display: block;
  width: auto;
}
</style>
