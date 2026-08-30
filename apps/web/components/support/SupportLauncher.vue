<script setup lang="ts">
const { isOpen, unread, toggle } = useSupport()
</script>

<template>
  <div>
    <button class="sc-launcher" :aria-expanded="isOpen" aria-label="Support chat" @click="toggle">
      <span aria-hidden="true">{{ isOpen ? '✕' : '💬' }}</span>
      <span v-if="unread > 0 && !isOpen" class="sc-badge">{{ unread }}</span>
    </button>
    <SupportPanel v-if="isOpen" />
  </div>
</template>

<style scoped>
.sc-launcher {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  /* Shared scale, defined in assets/css/components.css. Above the in-game
     surface, below the mobile drawer — see the comment there for the full
     order. */
  z-index: var(--z-support, 60);
  width: 3.25rem;
  height: 3.25rem;
  border: none;
  border-radius: 50%;
  background: var(--brand-primary);
  color: var(--text-on-brand);
  font-size: 1.35rem;
  cursor: pointer;
  box-shadow: 0 6px 20px rgb(0 0 0 / 35%);
}
.sc-badge {
  position: absolute;
  top: -0.25rem;
  right: -0.25rem;
  min-width: 1.25rem;
  padding: 0 0.3rem;
  border-radius: 999px;
  background: var(--status-error);
  color: var(--text-primary);
  font-size: 0.72rem;
  line-height: 1.25rem;
}
</style>
