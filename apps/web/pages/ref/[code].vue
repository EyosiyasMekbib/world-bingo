<script setup lang="ts">
/**
 * Short referral link handler: /ref/WB3FA29C
 * Redirects to the registration page with the code pre-filled.
 */
const route = useRoute()
const code = route.params.code as string

// Redirect immediately to registration with ref param
navigateTo(`/auth/register?ref=${encodeURIComponent(code)}`, { replace: true })
</script>

<template>
  <div>Redirecting…</div>
</template>
