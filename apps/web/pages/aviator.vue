<script setup lang="ts">
/**
 * The Aviator nav tab. Resolves the catalog's Aviator (whichever provider the
 * admin's priority puts first) and forwards into the game; a logged-out player
 * gets the login screen from the play page and lands back in the game after.
 * With no Aviator in the catalog right now, the tab shows the Mini Games list
 * it used to link to, so it never dead-ends.
 */
import { AVIATOR_NAME_KEY, aviatorDestination, type NamedGame } from '~/utils/aviator-launch'

definePageMeta({ shell: 'wide' })
useHead({ title: 'Aviator — World Bingo' })

const config = useRuntimeConfig()
const { track } = useAnalytics()

onMounted(async () => {
  const game = await $fetch<NamedGame>(
    `${config.public.apiBase}/providers/games/by-name/${AVIATOR_NAME_KEY}`,
    { retry: 0 },
  ).catch(() => null)
  const to = aviatorDestination(game)
  track('aviator_tab_open', {
    resolved: to !== aviatorDestination(null),
    providerCode: game?.providerCode ?? null,
  })
  await navigateTo(to, { replace: true })
})
</script>

<template>
  <div class="aviator-resolving" role="status" aria-live="polite">
    <span class="aviator-spinner" aria-hidden="true" />
    <p>Opening Aviator…</p>
  </div>
</template>

<style scoped>
.aviator-resolving {
  min-height: 50vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--text-muted, #94a3b8);
  font-size: 0.95rem;
}
.aviator-spinner {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 3px solid rgba(148, 163, 184, 0.25);
  border-top-color: #34d399;
  animation: aviator-spin 0.8s linear infinite;
}
@keyframes aviator-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
