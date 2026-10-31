<script setup lang="ts">
import Chrome from './Chrome.vue'
import Rail from './Rail.vue'
</script>

<template>
  <div class="wn-shell">
    <Chrome />
    <!-- Drawer only: the Menu tab still needs somewhere to open on a phone. -->
    <Rail drawer-only />
    <main class="wn-wide">
      <slot />
    </main>
    <footer class="wn-footer">
      <p>Responsible Gaming: 18+ only. Gambling can be addictive — play within your limits.</p>
      <span class="wn-18">18+</span>
    </footer>
  </div>
</template>
