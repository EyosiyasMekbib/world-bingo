<script setup lang="ts">
import { BRAND_TOKEN_CSS_VARS, DEFAULT_BRAND, type BrandConfig, type BrandTokenKey } from '@world-bingo/shared-types'

const { getBrand, updateBrand, uploadBrandLogo, uploadBrandFavicon } = useAdminApi()
const toast = useToast()

const loading = ref(true)
const saving = ref(false)

const form = reactive({
  displayName: DEFAULT_BRAND.displayName,
  shortName: DEFAULT_BRAND.shortName,
  logoUrl: DEFAULT_BRAND.logoUrl as string | null,
  faviconUrl: DEFAULT_BRAND.faviconUrl as string | null,
  tokens: { ...DEFAULT_BRAND.tokens },
})

const GROUPS: { title: string; icon: string; match: (k: BrandTokenKey) => boolean }[] = [
  { title: 'Brand', icon: 'i-heroicons:swatch', match: (k) => k.startsWith('brand') },
  { title: 'Accent', icon: 'i-heroicons:sparkles', match: (k) => k.startsWith('accent') },
  { title: 'Surface', icon: 'i-heroicons:square-2-stack', match: (k) => k.startsWith('surface') },
  { title: 'Text', icon: 'i-heroicons:document-text', match: (k) => k.startsWith('text') },
  { title: 'Status', icon: 'i-heroicons:signal', match: (k) => k.startsWith('status') },
  { title: 'Balls', icon: 'i-heroicons:circle-stack', match: (k) => k.startsWith('ball') },
  { title: 'Cartela & Glow', icon: 'i-heroicons:table-cells', match: (k) => k.startsWith('cartela') || k.endsWith('Glow') || k === 'winnerGlow' || k === 'numberCalledGlow' },
]
const tokenKeys = Object.keys(BRAND_TOKEN_CSS_VARS) as BrandTokenKey[]

// Collect keys that belong to at least one group (to avoid duplicates from Glow overlap)
const assignedKeys = new Set<BrandTokenKey>()
function keysFor(group: (typeof GROUPS)[number]) {
  return tokenKeys.filter((k) => {
    if (assignedKeys.has(k)) return false
    if (group.match(k)) {
      assignedKeys.add(k)
      return true
    }
    return false
  })
}

// Pre-compute group keys once (reactive computed would re-run; call once at setup)
const groupKeys = GROUPS.map((g) => ({ group: g, keys: keysFor(g) }))

const previewStyle = computed(() =>
  Object.fromEntries(
    tokenKeys.flatMap((k) => BRAND_TOKEN_CSS_VARS[k].map((v) => [v, form.tokens[k]])),
  ),
)

async function load() {
  loading.value = true
  try {
    const b = await getBrand() as BrandConfig
    form.displayName = b.displayName
    form.shortName = b.shortName
    form.logoUrl = b.logoUrl
    form.faviconUrl = b.faviconUrl
    form.tokens = { ...DEFAULT_BRAND.tokens, ...b.tokens }
  } catch {
    toast.add({ title: 'Error', description: 'Failed to load branding', color: 'error' })
  } finally {
    loading.value = false
  }
}

async function onLogo(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const { url } = await uploadBrandLogo(file)
    form.logoUrl = url
    toast.add({ title: 'Logo uploaded', color: 'success' })
  } catch {
    toast.add({ title: 'Upload failed', color: 'error' })
  }
}

async function onFavicon(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const { url } = await uploadBrandFavicon(file)
    form.faviconUrl = url
    toast.add({ title: 'Favicon uploaded', color: 'success' })
  } catch {
    toast.add({ title: 'Upload failed', color: 'error' })
  }
}

async function save() {
  saving.value = true
  try {
    await updateBrand({
      displayName: form.displayName,
      shortName: form.shortName,
      logoUrl: form.logoUrl,
      faviconUrl: form.faviconUrl,
      tokens: form.tokens,
    })
    toast.add({ title: 'Branding saved ✅', description: 'Reload the player app to see changes.', color: 'success' })
  } catch (err: any) {
    toast.add({ title: 'Save failed', description: err?.data?.error ?? 'Invalid values', color: 'error' })
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="space-y-8 max-w-3xl">
    <div>
      <h1 class="text-2xl font-bold text-white tracking-tight">Branding</h1>
      <p class="text-sm text-white/50 mt-0.5 font-medium">Customize the white-label appearance across the player app</p>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-16 text-zinc-500">
      <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin mr-2" />
      Loading…
    </div>

    <template v-else>
      <!-- ── Identity ── -->
      <div class="space-y-4">
        <h2 class="text-base font-bold text-white flex items-center gap-2">
          <UIcon name="i-heroicons:identification" class="w-5 h-5 text-yellow-500" />
          Identity
        </h2>

        <div
          class="rounded-2xl border border-(--surface-border) p-5 shadow-lg"
          style="background: var(--surface-raised);"
        >
          <div class="grid gap-5 sm:grid-cols-2">
            <div>
              <p class="text-sm font-bold text-white mb-1.5">Display Name</p>
              <p class="text-xs text-white/40 mb-2 font-medium">Shown in the player app header and page titles</p>
              <UInput v-model="form.displayName" placeholder="e.g. World Bingo" class="w-full" />
            </div>
            <div>
              <p class="text-sm font-bold text-white mb-1.5">Short Name</p>
              <p class="text-xs text-white/40 mb-2 font-medium">Used in compact UI areas (e.g. PWA name)</p>
              <UInput v-model="form.shortName" placeholder="e.g. World" class="w-full" />
            </div>
          </div>
        </div>
      </div>

      <!-- ── Assets ── -->
      <div class="space-y-4">
        <h2 class="text-base font-bold text-white flex items-center gap-2">
          <UIcon name="i-heroicons:photo" class="w-5 h-5 text-yellow-500" />
          Assets
        </h2>

        <div
          class="rounded-2xl border border-(--surface-border) p-5 shadow-lg"
          style="background: var(--surface-raised);"
        >
          <div class="grid gap-6 sm:grid-cols-2">
            <!-- Logo -->
            <div>
              <p class="text-sm font-bold text-white mb-1">Logo</p>
              <p class="text-xs text-white/40 mb-3 font-medium">Displayed in the app header. Recommended: 200×200px, PNG.</p>
              <label
                class="flex items-center gap-2 px-3 py-2 rounded-lg border border-(--surface-border) cursor-pointer hover:border-yellow-500/40 transition-colors text-sm text-white/60"
                style="background: var(--surface-overlay);"
              >
                <UIcon name="i-heroicons:arrow-up-tray" class="w-4 h-4 shrink-0" />
                <span>Choose file…</span>
                <input type="file" accept="image/*" class="sr-only" @change="onLogo" />
              </label>
              <div v-if="form.logoUrl" class="mt-3 flex items-center gap-3">
                <img :src="form.logoUrl" alt="Logo preview" class="h-10 w-10 object-contain rounded border border-(--surface-border)" />
                <span class="text-xs text-white/40 truncate flex-1">{{ form.logoUrl }}</span>
              </div>
            </div>

            <!-- Favicon -->
            <div>
              <p class="text-sm font-bold text-white mb-1">Favicon</p>
              <p class="text-xs text-white/40 mb-3 font-medium">Browser tab icon. Recommended: 32×32px or 64×64px, ICO/PNG.</p>
              <label
                class="flex items-center gap-2 px-3 py-2 rounded-lg border border-(--surface-border) cursor-pointer hover:border-yellow-500/40 transition-colors text-sm text-white/60"
                style="background: var(--surface-overlay);"
              >
                <UIcon name="i-heroicons:arrow-up-tray" class="w-4 h-4 shrink-0" />
                <span>Choose file…</span>
                <input type="file" accept="image/*" class="sr-only" @change="onFavicon" />
              </label>
              <div v-if="form.faviconUrl" class="mt-3 flex items-center gap-3">
                <img :src="form.faviconUrl" alt="Favicon preview" class="h-8 w-8 object-contain rounded border border-(--surface-border)" />
                <span class="text-xs text-white/40 truncate flex-1">{{ form.faviconUrl }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Color Tokens (grouped) ── -->
      <div v-for="{ group, keys } in groupKeys" :key="group.title" class="space-y-4">
        <template v-if="keys.length > 0">
          <h2 class="text-base font-bold text-white flex items-center gap-2">
            <UIcon :name="group.icon" class="w-5 h-5 text-yellow-500" />
            {{ group.title }} Colors
          </h2>

          <div
            class="rounded-2xl border border-(--surface-border) p-5 shadow-lg"
            style="background: var(--surface-raised);"
          >
            <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div v-for="k in keys" :key="k" class="flex flex-col gap-1.5">
                <p class="text-xs font-semibold text-white/70">{{ k }}</p>
                <div class="flex items-center gap-2">
                  <!-- Color picker (hex only — rgba tokens will show black but text input is source of truth) -->
                  <input
                    type="color"
                    :value="form.tokens[k].startsWith('#') ? form.tokens[k].slice(0, 7) : '#000000'"
                    class="h-8 w-10 rounded border border-(--surface-border) cursor-pointer p-0.5 shrink-0"
                    style="background: var(--surface-overlay);"
                    @input="(e) => { if ((e.target as HTMLInputElement).value) form.tokens[k] = (e.target as HTMLInputElement).value }"
                  />
                  <!-- Text input — source of truth, supports rgba() values -->
                  <input
                    v-model="form.tokens[k]"
                    class="flex-1 min-w-0 border border-(--surface-border) rounded px-2 py-1.5 font-mono text-xs text-white/80"
                    style="background: var(--surface-overlay);"
                    spellcheck="false"
                  />
                </div>
                <!-- Swatch preview -->
                <div
                  class="h-2 rounded-full"
                  :style="{ background: form.tokens[k] }"
                />
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- ── Live Preview ── -->
      <div class="space-y-4">
        <h2 class="text-base font-bold text-white flex items-center gap-2">
          <UIcon name="i-heroicons:eye" class="w-5 h-5 text-yellow-500" />
          Live Preview
        </h2>

        <div
          :style="previewStyle"
          class="rounded-2xl border p-6"
          style="background: var(--surface-base); border-color: var(--surface-border);"
        >
          <p class="text-xs font-semibold uppercase tracking-wider mb-4" style="color: var(--text-disabled);">
            Token preview — rendered with your current values
          </p>
          <div class="flex flex-wrap gap-3 items-center mb-4">
            <span
              class="px-4 py-1.5 rounded-lg font-semibold text-sm"
              :style="{ background: 'var(--brand-primary)', color: 'var(--text-on-brand)' }"
            >Primary</span>
            <span
              class="px-4 py-1.5 rounded-lg font-semibold text-sm"
              :style="{ background: 'var(--brand-primary-dim)', color: 'var(--text-on-brand)' }"
            >Primary Dim</span>
            <span
              class="px-4 py-1.5 rounded-lg font-semibold text-sm"
              :style="{ background: 'var(--accent-primary)', color: '#fff' }"
            >Accent</span>
            <span
              class="px-4 py-1.5 rounded-lg font-semibold text-sm"
              :style="{ background: 'var(--cartela-marked-bg)', color: 'var(--cartela-marked-text)' }"
            >Marked Cell</span>
            <span
              class="px-4 py-1.5 rounded-lg font-semibold text-sm"
              :style="{ background: 'var(--cartela-free-bg)', color: 'var(--cartela-free-text)' }"
            >Free Cell</span>
          </div>
          <div class="flex flex-wrap gap-3 items-center mb-4">
            <!-- Ball colours -->
            <span
              v-for="ball in ['B', 'I', 'N', 'G', 'O']"
              :key="ball"
              class="w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm text-white shadow-md"
              :style="{ background: `var(--ball-${ball.toLowerCase()})` }"
            >{{ ball }}</span>
          </div>
          <div class="flex flex-wrap gap-4">
            <span class="text-sm font-semibold" style="color: var(--text-primary);">Text Primary</span>
            <span class="text-sm font-medium" style="color: var(--text-secondary);">Text Secondary</span>
            <span class="text-sm" style="color: var(--text-disabled);">Text Disabled</span>
            <span class="text-sm font-medium" :style="{ color: 'var(--status-success)' }">Success</span>
            <span class="text-sm font-medium" :style="{ color: 'var(--status-error)' }">Error</span>
            <span class="text-sm font-medium" :style="{ color: 'var(--status-warning)' }">Warning</span>
            <span class="text-sm font-medium" :style="{ color: 'var(--status-info)' }">Info</span>
          </div>
        </div>
      </div>

      <!-- ── Save ── -->
      <div class="flex justify-end pt-2">
        <UButton
          color="primary"
          :loading="saving"
          icon="i-heroicons:check"
          @click="save"
        >
          Save Branding
        </UButton>
      </div>
    </template>
  </div>
</template>
