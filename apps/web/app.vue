<template>
  <NuxtErrorBoundary @error="handleError">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
    <template #error="{ error, clearError }">
      <div style="position:fixed;top:0;left:0;right:0;bottom:0;background:#0a0d14;color:#f87171;padding:2rem;font-family:monospace;overflow:auto;z-index:9999">
        <h2 style="font-size:1.5rem;margin-bottom:1rem">⚠️ App Error</h2>
        <p style="font-size:1.1rem;color:#fbbf24;margin-bottom:1rem">{{ error?.message }}</p>
        <pre style="font-size:0.75rem;color:#94a3b8;white-space:pre-wrap;background:#1e293b;padding:1rem;border-radius:8px">{{ error?.stack }}</pre>
        <button
          style="margin-top:1rem;padding:0.5rem 1rem;background:#f59e0b;color:#000;border:none;border-radius:8px;font-weight:700;cursor:pointer"
          @click="clearError()"
        >Clear Error</button>
      </div>
    </template>
  </NuxtErrorBoundary>
</template>

<script setup lang="ts">
function handleError(error: unknown) {
  console.error('[app.vue] NuxtErrorBoundary caught:', error)
}
</script>
