<script setup lang="ts">
const { getFeatureFlags, updateFeatureFlags } = useAdminApi()
const toast = useToast()

const loading = ref(true)
const saving = ref(false)

const features = reactive({
  feature_referrals: false,
  feature_tournaments: false,
})

const fetchFlags = async () => {
  loading.value = true
  try {
    const data = await getFeatureFlags()
    features.feature_referrals = data.feature_referrals ?? false
    features.feature_tournaments = data.feature_tournaments ?? false
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load feature flags', color: 'error' })
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

onMounted(fetchFlags)
</script>

<template>
  <div class="space-y-6 max-w-2xl">
    <div>
      <h1 class="text-2xl font-bold text-white">Feature Flags</h1>
      <p class="text-sm text-zinc-500 mt-0.5">Enable or disable optional features shown to players</p>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-16 text-zinc-500">
      <UIcon name="i-heroicons-arrow-path" class="w-5 h-5 animate-spin mr-2" />
      Loading…
    </div>

    <template v-else>
      <div class="space-y-4">
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
    </template>
  </div>
</template>
