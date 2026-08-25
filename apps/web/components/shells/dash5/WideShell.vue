<script setup lang="ts">
import Chrome from './Chrome.vue'
</script>

<template>
  <div class="d5-shell">
    <Chrome />
    <main class="d5-wide">
      <slot />
    </main>
    <footer class="d5-footer">
      <p>Responsible Gaming: 18+ only. Gambling can be addictive — play within your limits.</p>
      <span class="d5-18">18+</span>
    </footer>
  </div>
</template>
