<script setup lang="ts">
import {
  HERO_BANNER_SPEC,
  heroBannerImageProblem,
  isExternalHeroBannerLink,
  isValidHeroBannerLink,
  type HeroBannerDto,
  type HeroBannerVariant,
} from '@world-bingo/shared-types'

const { getHeroBanners, createHeroBanner, updateHeroBanner, reorderHeroBanners, deleteHeroBanner } = useAdminApi()
const toast = useToast()

const VARIANTS: HeroBannerVariant[] = ['desktop', 'mobile']
const ALLOWED_TYPES = HERO_BANNER_SPEC.allowedMimeTypes as readonly string[]
const MIME_LABELS: Record<string, string> = { 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/webp': 'WebP' }
const typeLabel = ALLOWED_TYPES.map(t => MIME_LABELS[t] ?? t).join(', ')
const maxMb = HERO_BANNER_SPEC.maxFileBytes / (1024 * 1024)
const acceptAttr = ALLOWED_TYPES.join(',')
const breakpoint = HERO_BANNER_SPEC.mobileMaxWidthPx

const size = (v: HeroBannerVariant) => `${HERO_BANNER_SPEC[v].width}×${HERO_BANNER_SPEC[v].height}`

const specLine =
  `Every banner needs both images. Desktop ${size('desktop')} (at least ${HERO_BANNER_SPEC.desktop.minWidth}px wide), ` +
  `mobile ${size('mobile')} (at least ${HERO_BANNER_SPEC.mobile.minWidth}px wide, same shape). ` +
  `${typeLabel} up to ${maxMb}MB each.`

const VARIANT_COPY: Record<HeroBannerVariant, { label: string; hint: string }> = {
  desktop: { label: 'Desktop image', hint: `${size('desktop')} · screens wider than ${breakpoint}px` },
  mobile: { label: 'Mobile image', hint: `${size('mobile')} · screens up to ${breakpoint}px` },
}

const boxStyle = (v: HeroBannerVariant) => ({
  aspectRatio: `${HERO_BANNER_SPEC[v].width} / ${HERO_BANNER_SPEC[v].height}`,
  background: 'var(--surface-overlay)',
})

type ApiError = { data?: { error?: string }; statusCode?: number }
const errorMessage = (e: unknown, fallback: string) => (e as ApiError | undefined)?.data?.error ?? fallback
const statusOf = (e: unknown) => (e as ApiError | undefined)?.statusCode

const linkProblem = (link: string) => {
  const trimmed = link.trim()
  if (!trimmed || isValidHeroBannerLink(trimmed)) return null
  return 'Use a site path like /games or a full https:// URL'
}

/* ── Add banner ─────────────────────────────────────────────────────────── */

type ImagePick = {
  file: File | null
  previewUrl: string | null
  dims: string | null
  problem: string | null
  checking: boolean
}

const emptyPick = (): ImagePick => ({ file: null, previewUrl: null, dims: null, problem: null, checking: false })

const picks = reactive<Record<HeroBannerVariant, ImagePick>>({ desktop: emptyPick(), mobile: emptyPick() })
// Bumped on every pick so a slow image decode can't overwrite a newer choice.
const pickSeq: Record<HeroBannerVariant, number> = { desktop: 0, mobile: 0 }

const createForm = reactive({ altText: '', linkUrl: '' })
const creating = ref(false)

const clearPick = (variant: HeroBannerVariant) => {
  pickSeq[variant]++
  const url = picks[variant].previewUrl
  if (url) URL.revokeObjectURL(url)
  picks[variant] = emptyPick()
}

const readDimensions = (src: string) =>
  new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('Image could not be decoded'))
    img.src = src
  })

const onPick = async (variant: HeroBannerVariant, e: Event) => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  clearPick(variant)
  const pick = picks[variant]

  if (!ALLOWED_TYPES.includes(file.type)) {
    pick.problem = `The ${variant} image must be ${typeLabel}`
    return
  }
  if (file.size > HERO_BANNER_SPEC.maxFileBytes) {
    pick.problem = `The ${variant} image must be ${maxMb}MB or smaller`
    return
  }

  const seq = pickSeq[variant]
  pick.file = file
  pick.previewUrl = URL.createObjectURL(file)
  pick.checking = true
  try {
    const { width, height } = await readDimensions(pick.previewUrl)
    if (seq !== pickSeq[variant]) return
    pick.dims = `${width}×${height}`
    pick.problem = heroBannerImageProblem(variant, width, height)
  } catch {
    if (seq !== pickSeq[variant]) return
    pick.problem = `The ${variant} image could not be read`
  } finally {
    if (seq === pickSeq[variant]) pick.checking = false
  }
}

const pickReady = (p: ImagePick) => !!p.file && !p.problem && !p.checking
const createLinkProblem = computed(() => linkProblem(createForm.linkUrl))
const canSubmit = computed(
  () => pickReady(picks.desktop) && pickReady(picks.mobile) && !createLinkProblem.value && !creating.value,
)

const submitHint = computed(() => {
  if (!picks.desktop.file || !picks.mobile.file) return 'Choose both images to continue'
  if (picks.desktop.checking || picks.mobile.checking) return 'Checking images…'
  if (picks.desktop.problem || picks.mobile.problem) return 'Fix the image problems above'
  if (createLinkProblem.value) return 'Fix the link'
  return ''
})

const formTouched = computed(
  () => VARIANTS.some(v => picks[v].previewUrl || picks[v].problem) || !!createForm.altText || !!createForm.linkUrl,
)

const resetForm = () => {
  VARIANTS.forEach(clearPick)
  createForm.altText = ''
  createForm.linkUrl = ''
}

const submit = async () => {
  const { desktop, mobile } = picks
  if (!canSubmit.value || !desktop.file || !mobile.file) return
  creating.value = true
  try {
    await createHeroBanner({
      desktop: desktop.file,
      mobile: mobile.file,
      altText: createForm.altText.trim(),
      linkUrl: createForm.linkUrl.trim(),
    })
    toast.add({ title: 'Banner added', description: 'It is live in the lobby, last in the rotation.', color: 'success' })
    resetForm()
    await fetchBanners()
  } catch (e) {
    toast.add({ title: 'Upload failed', description: errorMessage(e, 'Failed to add the banner'), color: 'error' })
  } finally {
    creating.value = false
  }
}

onBeforeUnmount(() => {
  VARIANTS.forEach((v) => {
    const url = picks[v].previewUrl
    if (url) URL.revokeObjectURL(url)
  })
})

/* ── Banner list ────────────────────────────────────────────────────────── */

const banners = ref<HeroBannerDto[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)
const togglingId = ref<string | null>(null)
const reordering = ref(false)

const activeCount = computed(() => banners.value.filter(b => b.isActive).length)

const fetchBanners = async () => {
  loadError.value = null
  try {
    const { items } = await getHeroBanners()
    banners.value = items
    if (editingId.value && !items.some(b => b.id === editingId.value)) editingId.value = null
  } catch (e) {
    loadError.value = errorMessage(e, 'Failed to load banners')
  } finally {
    loading.value = false
  }
}

const replaceBanner = (item: HeroBannerDto) => {
  const i = banners.value.findIndex(b => b.id === item.id)
  if (i !== -1) banners.value[i] = item
}

const failAndResync = (e: unknown, fallback: string) => {
  toast.add({ title: 'Error', description: errorMessage(e, fallback), color: 'error' })
  if (statusOf(e) === 404) fetchBanners()
}

const setActive = async (banner: HeroBannerDto, isActive: boolean) => {
  togglingId.value = banner.id
  try {
    const { item } = await updateHeroBanner(banner.id, { isActive })
    replaceBanner(item)
  } catch (e) {
    failAndResync(e, 'Failed to update the banner')
  } finally {
    togglingId.value = null
  }
}

const move = async (index: number, delta: number) => {
  const target = index + delta
  if (reordering.value || target < 0 || target >= banners.value.length) return
  const next = [...banners.value]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved)
  banners.value = next
  reordering.value = true
  try {
    const { items } = await reorderHeroBanners(next.map(b => b.id))
    banners.value = items
  } catch (e) {
    toast.add({ title: 'Error', description: errorMessage(e, 'Failed to save the order'), color: 'error' })
    await fetchBanners()
  } finally {
    reordering.value = false
  }
}

/* Inline edit of alt text + link */
const editingId = ref<string | null>(null)
const editDraft = reactive({ altText: '', linkUrl: '' })
const savingEdit = ref(false)

const editingBanner = computed(() => banners.value.find(b => b.id === editingId.value) ?? null)
const editLinkProblem = computed(() => linkProblem(editDraft.linkUrl))
const editDirty = computed(() => {
  const b = editingBanner.value
  if (!b) return false
  return editDraft.altText.trim() !== b.altText || (editDraft.linkUrl.trim() || null) !== b.linkUrl
})

const startEdit = (banner: HeroBannerDto) => {
  editingId.value = banner.id
  editDraft.altText = banner.altText
  editDraft.linkUrl = banner.linkUrl ?? ''
}

const cancelEdit = () => {
  editingId.value = null
}

const saveEdit = async () => {
  const b = editingBanner.value
  if (!b || !editDirty.value || editLinkProblem.value || savingEdit.value) return
  savingEdit.value = true
  try {
    const { item } = await updateHeroBanner(b.id, {
      altText: editDraft.altText.trim(),
      linkUrl: editDraft.linkUrl.trim() || null,
    })
    replaceBanner(item)
    editingId.value = null
    toast.add({ title: 'Banner saved', color: 'success' })
  } catch (e) {
    failAndResync(e, 'Failed to save the banner')
  } finally {
    savingEdit.value = false
  }
}

/* Delete */
const showDeleteConfirm = ref(false)
const deleteTarget = ref<HeroBannerDto | null>(null)
const deleting = ref(false)

const askDelete = (banner: HeroBannerDto) => {
  deleteTarget.value = banner
  showDeleteConfirm.value = true
}

const doDelete = async () => {
  const target = deleteTarget.value
  if (!target) return
  deleting.value = true
  try {
    await deleteHeroBanner(target.id)
    banners.value = banners.value.filter(b => b.id !== target.id)
    if (editingId.value === target.id) editingId.value = null
    showDeleteConfirm.value = false
    toast.add({ title: 'Banner deleted', color: 'success' })
  } catch (e) {
    failAndResync(e, 'Failed to delete the banner')
    if (statusOf(e) === 404) showDeleteConfirm.value = false
  } finally {
    deleting.value = false
  }
}

onMounted(fetchBanners)
</script>

<template>
  <div class="space-y-8 max-w-4xl">
    <div>
      <h1 class="text-2xl font-bold text-white tracking-tight">Hero Banners</h1>
      <p class="text-sm text-white/50 mt-0.5 font-medium">
        Image banners at the top of the player lobby, rotated in this order.
      </p>
      <p class="text-xs text-white/40 mt-2 font-medium flex items-start gap-1.5">
        <UIcon name="i-heroicons:information-circle" class="w-4 h-4 shrink-0 text-yellow-500/80" />
        <span>{{ specLine }}</span>
      </p>
    </div>

    <!-- ── Add banner ── -->
    <div class="space-y-4">
      <h2 class="text-base font-bold text-white flex items-center gap-2">
        <UIcon name="i-heroicons:plus-circle" class="w-5 h-5 text-yellow-500" />
        Add banner
      </h2>

      <form
        class="rounded-2xl border border-(--surface-border) p-5 shadow-lg space-y-5"
        style="background: var(--surface-raised);"
        @submit.prevent="submit"
      >
        <div class="grid gap-5 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] items-start">
          <div v-for="variant in VARIANTS" :key="variant">
            <p class="text-sm font-bold text-white mb-1">{{ VARIANT_COPY[variant].label }}</p>
            <p class="text-xs text-white/40 mb-3 font-medium">{{ VARIANT_COPY[variant].hint }}</p>

            <label
              class="relative block rounded-xl border border-dashed overflow-hidden cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-yellow-500/60"
              :class="picks[variant].problem ? 'border-red-400/60' : 'border-(--surface-border) hover:border-yellow-500/40'"
              :style="boxStyle(variant)"
            >
              <img
                v-if="picks[variant].previewUrl"
                :src="picks[variant].previewUrl ?? undefined"
                alt=""
                class="absolute inset-0 w-full h-full object-cover"
              >
              <span
                v-if="picks[variant].previewUrl"
                class="absolute bottom-2 right-2 rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white/80"
              >Change</span>
              <span v-else class="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs text-white/50">
                <UIcon name="i-heroicons:arrow-up-tray" class="w-5 h-5" />
                Choose file…
              </span>
              <input
                type="file"
                :accept="acceptAttr"
                class="sr-only"
                :aria-label="VARIANT_COPY[variant].label"
                @change="onPick(variant, $event)"
              >
            </label>

            <p v-if="picks[variant].checking" class="text-xs mt-2 text-white/40 flex items-center gap-1.5">
              <UIcon name="i-heroicons:arrow-path" class="w-3.5 h-3.5 animate-spin" /> Checking size…
            </p>
            <p v-else-if="picks[variant].problem" class="text-xs mt-2 text-red-400 font-medium">
              {{ picks[variant].problem }}
            </p>
            <p v-else-if="picks[variant].file" class="text-xs mt-2 text-emerald-400/80 flex items-center gap-1.5 min-w-0">
              <UIcon name="i-heroicons:check-circle" class="w-3.5 h-3.5 shrink-0" />
              <span class="truncate">{{ picks[variant].file?.name }} · {{ picks[variant].dims }}</span>
            </p>
          </div>
        </div>

        <div class="grid gap-5 sm:grid-cols-2">
          <div>
            <p class="text-sm font-bold text-white mb-1.5">Alt text</p>
            <p class="text-xs text-white/40 mb-2 font-medium">Read by screen readers. Describe what the banner says.</p>
            <UInput v-model="createForm.altText" placeholder="e.g. Weekend cashback: 10% back" maxlength="160" class="w-full" />
          </div>
          <div>
            <p class="text-sm font-bold text-white mb-1.5">Link <span class="text-white/30 font-medium">(optional)</span></p>
            <p class="text-xs text-white/40 mb-2 font-medium">/games or https://… Leave empty for no link.</p>
            <UInput v-model="createForm.linkUrl" placeholder="/games" maxlength="500" class="w-full" />
            <p v-if="createLinkProblem" class="text-xs mt-2 text-red-400 font-medium">{{ createLinkProblem }}</p>
          </div>
        </div>

        <div class="flex items-center justify-end gap-3">
          <span v-if="submitHint" class="text-xs text-white/40 font-medium mr-auto">{{ submitHint }}</span>
          <UButton
            color="neutral"
            variant="ghost"
            :disabled="creating || !formTouched"
            @click="resetForm"
          >
            Clear
          </UButton>
          <UButton type="submit" color="primary" icon="i-heroicons:arrow-up-tray" :loading="creating" :disabled="!canSubmit">
            Add banner
          </UButton>
        </div>
      </form>
    </div>

    <!-- ── Banners ── -->
    <div class="space-y-4">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-base font-bold text-white flex items-center gap-2">
          <UIcon name="i-heroicons:photo" class="w-5 h-5 text-yellow-500" />
          Banners
        </h2>
        <span v-if="!loading && !loadError && banners.length" class="text-xs text-white/40 font-medium">
          {{ banners.length }} {{ banners.length === 1 ? 'banner' : 'banners' }} · {{ activeCount }} active
        </span>
      </div>

      <div v-if="loading" class="flex items-center justify-center py-16 text-zinc-500">
        <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin mr-2" />
        Loading…
      </div>

      <div
        v-else-if="loadError"
        class="rounded-2xl border border-red-400/30 p-6 flex items-center gap-4"
        style="background: var(--surface-raised);"
      >
        <UIcon name="i-heroicons:exclamation-triangle" class="w-5 h-5 text-red-400 shrink-0" />
        <p class="text-sm text-white/70 flex-1">{{ loadError }}</p>
        <UButton color="neutral" variant="outline" size="sm" icon="i-heroicons:arrow-path" @click="fetchBanners">Retry</UButton>
      </div>

      <div v-else-if="!banners.length" class="rounded-2xl border border-dashed border-white/10 p-8 text-center text-sm text-white/30">
        No banners yet. The lobby shows its built-in slides.
      </div>

      <template v-else>
        <p
          v-if="activeCount === 0"
          class="rounded-xl border border-amber-400/20 px-4 py-3 text-xs font-medium text-amber-400/80 flex items-center gap-2"
          style="background: var(--surface-raised);"
        >
          <UIcon name="i-heroicons:eye-slash" class="w-4 h-4 shrink-0" />
          No banner is active, so the lobby falls back to its built-in slides.
        </p>

        <div class="space-y-3">
          <div
            v-for="(banner, index) in banners"
            :key="banner.id"
            class="rounded-2xl border border-(--surface-border) p-4 space-y-4"
            style="background: var(--surface-raised);"
          >
            <div class="flex items-center gap-3">
              <span class="w-6 text-center text-xs font-bold text-yellow-400/80 shrink-0">{{ index + 1 }}</span>
              <USwitch
                :model-value="banner.isActive"
                color="primary"
                :disabled="togglingId === banner.id"
                :aria-label="banner.isActive ? 'Hide banner' : 'Show banner'"
                @update:model-value="setActive(banner, $event)"
              />
              <span
                class="text-[10px] font-bold uppercase tracking-wider"
                :class="banner.isActive ? 'text-emerald-400' : 'text-white/30'"
              >{{ banner.isActive ? 'Active' : 'Hidden' }}</span>

              <div class="ml-auto flex items-center gap-1 shrink-0">
                <UButton
                  icon="i-heroicons:chevron-up"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  aria-label="Move up"
                  :disabled="index === 0 || reordering"
                  @click="move(index, -1)"
                />
                <UButton
                  icon="i-heroicons:chevron-down"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  aria-label="Move down"
                  :disabled="index === banners.length - 1 || reordering"
                  @click="move(index, 1)"
                />
                <UButton
                  icon="i-heroicons:trash"
                  color="error"
                  variant="ghost"
                  size="xs"
                  aria-label="Delete banner"
                  @click="askDelete(banner)"
                />
              </div>
            </div>

            <div class="flex flex-col sm:flex-row gap-3 items-start" :class="{ 'opacity-50': !banner.isActive }">
              <div class="w-full sm:flex-1 min-w-0">
                <p class="text-[10px] font-semibold uppercase tracking-wider text-white/30 mb-1">Desktop</p>
                <div class="rounded-xl overflow-hidden border border-(--surface-border)" :style="boxStyle('desktop')">
                  <img :src="banner.desktopImageUrl" :alt="banner.altText" class="w-full h-full object-cover" loading="lazy">
                </div>
              </div>
              <div class="w-40 shrink-0">
                <p class="text-[10px] font-semibold uppercase tracking-wider text-white/30 mb-1">Mobile</p>
                <div class="rounded-xl overflow-hidden border border-(--surface-border)" :style="boxStyle('mobile')">
                  <img :src="banner.mobileImageUrl" alt="" class="w-full h-full object-cover" loading="lazy">
                </div>
              </div>
            </div>

            <form v-if="editingId === banner.id" class="space-y-3" @submit.prevent="saveEdit">
              <div class="grid gap-3 sm:grid-cols-2">
                <div>
                  <p class="text-xs font-semibold text-white/60 mb-1.5">Alt text</p>
                  <UInput v-model="editDraft.altText" maxlength="160" size="sm" class="w-full" />
                </div>
                <div>
                  <p class="text-xs font-semibold text-white/60 mb-1.5">Link <span class="text-white/30 font-medium">· /games or https://…</span></p>
                  <UInput v-model="editDraft.linkUrl" placeholder="No link" maxlength="500" size="sm" class="w-full" />
                  <p v-if="editLinkProblem" class="text-xs mt-1.5 text-red-400 font-medium">{{ editLinkProblem }}</p>
                </div>
              </div>
              <div class="flex justify-end gap-2">
                <UButton color="neutral" variant="ghost" size="sm" :disabled="savingEdit" @click="cancelEdit">Cancel</UButton>
                <UButton
                  type="submit"
                  color="primary"
                  size="sm"
                  icon="i-heroicons:check"
                  :loading="savingEdit"
                  :disabled="!editDirty || !!editLinkProblem"
                >
                  Save
                </UButton>
              </div>
            </form>

            <div v-else class="flex items-start gap-3">
              <dl class="flex-1 min-w-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt class="text-white/30 font-semibold">Alt</dt>
                <dd class="truncate" :class="banner.altText ? 'text-white/80' : 'text-white/30 italic'">
                  {{ banner.altText || 'None' }}
                </dd>
                <dt class="text-white/30 font-semibold">Link</dt>
                <dd class="min-w-0 flex items-center gap-1" :class="banner.linkUrl ? 'text-white/80' : 'text-white/30 italic'">
                  <span class="truncate">{{ banner.linkUrl || 'Not clickable' }}</span>
                  <UIcon
                    v-if="banner.linkUrl && isExternalHeroBannerLink(banner.linkUrl)"
                    name="i-heroicons:arrow-top-right-on-square"
                    class="w-3.5 h-3.5 shrink-0 text-white/40"
                  />
                </dd>
              </dl>
              <UButton
                icon="i-heroicons:pencil-square"
                color="neutral"
                variant="ghost"
                size="xs"
                :disabled="editingId !== null && savingEdit"
                @click="startEdit(banner)"
              >
                Edit
              </UButton>
            </div>
          </div>
        </div>
      </template>
    </div>

    <UModal v-model:open="showDeleteConfirm" title="Delete banner" :ui="{ footer: 'justify-end' }">
      <template #body>
        <div class="space-y-3">
          <div
            v-if="deleteTarget"
            class="rounded-xl overflow-hidden border border-(--surface-border)"
            :style="boxStyle('desktop')"
          >
            <img :src="deleteTarget.desktopImageUrl" :alt="deleteTarget.altText" class="w-full h-full object-cover">
          </div>
          <p class="text-sm text-white/70">
            The banner is removed from the lobby straight away. This can't be undone.
          </p>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" :disabled="deleting" @click="showDeleteConfirm = false">Cancel</UButton>
        <UButton color="error" icon="i-heroicons:trash" :loading="deleting" @click="doDelete">Delete</UButton>
      </template>
    </UModal>
  </div>
</template>
