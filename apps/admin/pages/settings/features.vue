<script setup lang="ts">
const { getFeatureFlags, updateFeatureFlags, getGameSettings, updateGameSettings } = useAdminApi()
const toast = useToast()

const loading = ref(true)
const saving = ref(false)
const savingGame = ref(false)

const features = reactive({
  feature_referrals: false,
  feature_tournaments: false,
})

const gameSettings = reactive({
  ball_interval_secs: 3,
})

const fetchAll = async () => {
  loading.value = true
  try {
    const [flags, gs] = await Promise.all([getFeatureFlags(), getGameSettings()])
    features.feature_referrals = flags.feature_referrals ?? false
    features.feature_tournaments = flags.feature_tournaments ?? false
    gameSettings.ball_interval_secs = gs.ball_interval_secs ?? 3
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load settings', color: 'error' })
  } finally {
    loading.value = false
  }
}

const saveFlags = async () => {
  saving.value = true
  try {
    await updateFeatureFlags({ ...features })
    toast.add({ title: 'Saved ✅', description: 'Feature flags updated successfully', color: 'success' })
  } catch {
    toast.add({ title: 'Error', description: 'Failed to save feature flags', color: 'error' })
  } finally {
    saving.value = false
  }
}

const saveGameSettings = async () => {
  savingGame.value = true
  try {
    const result = await updateGameSettings({ ball_interval_secs: gameSettings.ball_interval_secs })
    gameSettings.ball_interval_secs = result.ball_interval_secs
    toast.add({ title: 'Saved ✅', description: 'Game settings updated successfully', color: 'success' })
  } catch {
    toast.add({ title: 'Error', description: 'Failed to save game settings', color: 'error' })
  } finally {
    savingGame.value = false
  }
}

onMounted(fetchAll)
</script>

<template>
  <div class="space-y-8 max-w-2xl">
    <div>
      <h1 class="text-2xl font-bold text-white">Settings</h1>
      <p class="text-sm text-zinc-500 mt-0.5">Manage game settings and optional features</p>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-16 text-zinc-500">
      <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 animate-spin mr-2" />
      Loading…
    </div>

    <template v-else>
      <!-- ── Game Settings ── -->
      <div class="space-y-4">
        <h2 class="text-base font-semibold text-zinc-300 flex items-center gap-2">
          <UIcon name="i-heroicons-cog-6-tooth" class="w-4 h-4 text-amber-400" />
          Game Settings
        </h2>

        <div
          class="rounded-2xl border border-white/8 p-5"
          style="background: #111827;"
        >
          <div class="flex items-start gap-3 mb-4">
            <div class="p-2.5 rounded-xl border border-amber-400/20 shrink-0" style="background:rgba(245,158,11,0.08);">
              <UIcon name="i-heroicons-clock" class="w-5 h-5 text-amber-400" />
            </div>
            <div class="flex-1">
              <p class="text-sm font-semibold text-white">Ball Calling Interval</p>
              <p class="text-xs text-zinc-500 mt-0.5">Seconds between each ball call during a live game (1–30s)</p>
            </div>
          </div>

          <div class="flex items-center gap-3">
            <div class="flex items-center gap-2 flex-1">
              <UInput
                v-model.number="gameSettings.ball_interval_secs"
                type="number"
                min="1"
                max="30"
                class="w-28"
              />
              <span class="text-sm text-zinc-400">seconds</span>
            </div>
            <div class="flex items-center gap-2">
              <span
                class="text-xs px-2 py-1 rounded-full font-mono"
                :class="gameSettings.ball_interval_secs <= 3 ? 'bg-green-500/10 text-green-400 border border-green-500/20' : gameSettings.ball_interval_secs <= 8 ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-zinc-700 text-zinc-400 border border-white/10'"
              >
                {{ gameSettings.ball_interval_secs <= 3 ? 'Fast' : gameSettings.ball_interval_secs <= 8 ? 'Medium' : 'Slow' }}
              </span>
            </div>
          </div>

          <div class="flex justify-end mt-4">
            <UButton
              color="primary"
              :loading="savingGame"
              icon="i-heroicons-check"
              size="sm"
              @click="saveGameSettings"
            >
              Save
            </UButton>
          </div>
        </div>
      </div>

      <!-- ── Feature Flags ── -->
      <div class="space-y-4">
        <h2 class="text-base font-semibold text-zinc-300 flex items-center gap-2">
          <UIcon name="i-heroicons-beaker" class="w-4 h-4 text-cyan-400" />
          Feature Flags
        </h2>

        <div class="space-y-3">
          <!-- Refer & Earn -->
          <div
            class="flex items-center justify-between rounded-2xl border border-white/8 p-5 hover:border-amber-400/30 transition-all"
            style="background: #111827;"
          >
            <div class="flex items-center gap-3">
              <div class="p-2.5 rounded-xl border border-amber-400/20" style="background:rgba(245,158,11,0.08);">
                <UIcon name="i-heroicons-gift" class="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <p class="text-sm font-semibold text-white">Refer &amp; Earn</p>
                <p class="text-xs text-zinc-500 mt-0.5">Allow players to share referral links and earn bonuses</p>
              </div>
            </div>
            <USwitch v-model="features.feature_referrals" />
          </div>

          <!-- Tournaments -->
          <div
            class="flex items-center justify-between rounded-2xl border border-white/8 p-5 hover:border-amber-400/30 transition-all"
            style="background: #111827;"
          >
            <div class="flex items-center gap-3">
              <div class="p-2.5 rounded-xl border border-amber-400/20" style="background:rgba(245,158,11,0.08);">
                <UIcon name="i-heroicons-trophy" class="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <p class="text-sm font-semibold text-white">Tournaments</p>
                <p class="text-xs text-zinc-500 mt-0.5">Show tournament listings and allow players to register</p>
              </div>
            </div>
            <USwitch v-model="features.feature_tournaments" />
          </div>
        </div>

        <!-- Save button -->
        <div class="flex justify-end pt-2">
          <UButton
            color="primary"
            :loading="saving"
            icon="i-heroicons-check"
            @click="saveFlags"
          >
            Save Changes
          </UButton>
        </div>
      </div>
    </template>
  </div>
</template>
