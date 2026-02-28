<template>
  <div class="redirecting">
    <div class="spinner" />
    <p>Loading game…</p>
  </div>
</template>

<script setup lang="ts">
/**
 * Redirect to play.vue which handles the full game lifecycle
 * (join → wait → 60s countdown → active game → end/refund).
 */
const route = useRoute()
const router = useRouter()

onMounted(() => {
  router.replace(`/quick/${route.params.gameId}/play`)
})
</script>

<style scoped>
.redirecting {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  gap: 1rem;
  color: #888;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid rgba(255, 255, 255, 0.08);
  border-top-color: var(--color-primary, #c9a96e);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
