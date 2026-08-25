<script setup lang="ts">
// Arada has no rails, so its wide shell is its rails shell. Delegating rather
// than duplicating keeps the two in step when the arada chrome changes.
import RailsShell from './RailsShell.vue'
</script>

<template>
  <RailsShell>
    <slot />
  </RailsShell>
</template>
