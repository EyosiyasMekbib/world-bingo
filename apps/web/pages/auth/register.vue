<script setup lang="ts">
definePageMeta({
  middleware: () => navigateTo('/auth/login', { redirectCode: 301 }),
})
</script>
<template><div /></template>
