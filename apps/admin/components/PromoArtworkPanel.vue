<script setup lang="ts">
/**
 * Card artwork for one promotion.
 *
 * The promo tile is 3:1 at every breakpoint, so there is a single image to
 * manage rather than a desktop/mobile pair like a hero banner — and because the
 * shape never changes, an off-ratio upload is refused instead of cropped. This
 * panel therefore has to say no before the request leaves the browser, with the
 * same rule the server applies: `promoCardImageProblem`, shared, so the copy in
 * front of the admin and the 400 they would otherwise get cannot drift apart.
 *
 * It owns its own loading, error and toast state and emits nothing: the pages
 * that host it (a cashback promotion, a bonus rule, the settings-backed welcome
 * and referral offers) have no decision to make about artwork.
 */
import {
  PROMO_CARD_SPEC,
  promoCardImageProblem,
  type PromoArtworkDto,
  type PromoKind,
  type PublicPromotionDto,
} from '@world-bingo/shared-types'

const props = defineProps<{
  /**
   * Spelled as the enum or as the enum's value: the promotion detail page hands
   * this down as the literal `kind="CASHBACK"` from its template, and vue-tsc
   * will not widen a plain string into an enum member.
   */
  kind: PromoKind | `${PromoKind}`
  refId: string
}>()

const { getPromoArtwork, uploadPromoArtwork, updatePromoArtwork, deletePromoArtwork, fetch: apiFetch } = useAdminApi()
const toast = useToast()

const kind = computed(() => props.kind as PromoKind)

/* ── The spec, spelled once from the shared constant ─────────────────────── */

const MIME_LABELS: Record<string, string> = { 'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/webp': 'WebP' }
const ALLOWED_TYPES = PROMO_CARD_SPEC.allowedMimeTypes as readonly string[]

const typeLabel = ALLOWED_TYPES.map((t) => MIME_LABELS[t] ?? t).join(', ')
const acceptAttr = ALLOWED_TYPES.join(',')
const maxMb = PROMO_CARD_SPEC.maxFileBytes / (1024 * 1024)
const targetSize = `${PROMO_CARD_SPEC.width} × ${PROMO_CARD_SPEC.height}`
const ratioStyle = { aspectRatio: `${PROMO_CARD_SPEC.width} / ${PROMO_CARD_SPEC.height}` }
const tolerancePct = Number((PROMO_CARD_SPEC.ratioTolerance * 100).toFixed(2))

/** '3:1' for the 900x300 target, and the same helper for an uploaded file. */
const ratioLabel = (width: number, height: number) => `${Number((width / height).toFixed(2))}:1`
const targetRatio = ratioLabel(PROMO_CARD_SPEC.width, PROMO_CARD_SPEC.height)

const specLine =
  `One wide banner at ${targetRatio} — ${targetSize} or larger, at least ${PROMO_CARD_SPEC.minWidth}px wide. ` +
  `${typeLabel} up to ${maxMb}MB.`

const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

/* ── Shared plumbing ────────────────────────────────────────────────────── */

type ApiError = { data?: { error?: string }; statusCode?: number }
const errorMessage = (e: unknown, fallback: string) => (e as ApiError | undefined)?.data?.error ?? fallback
const statusOf = (e: unknown) => (e as ApiError | undefined)?.statusCode

const readDimensions = (src: string) =>
  new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('Image could not be decoded'))
    img.src = src
  })

/**
 * The stored row carries a URL and nothing about the file behind it, so the
 * facts an admin wants to check — its real dimensions, its weight — are read
 * back off the image itself. A HEAD that is refused (the bucket is another
 * origin once STORAGE_PROVIDER is gcs) costs the size line and nothing else.
 */
const byteSize = async (url: string): Promise<number | null> => {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    const length = res.headers.get('content-length')
    return length ? Number(length) : null
  } catch {
    return null
  }
}

/* ── Load ───────────────────────────────────────────────────────────────── */

const artwork = ref<PromoArtworkDto | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)

/* The caption is edited in place and saved on blur, so it mirrors the stored
   row rather than being read straight off it. */
const altDraft = ref('')

type StoredFacts = { name: string; width: number; height: number; bytes: number | null }
const storedFacts = ref<StoredFacts | null>(null)

// The tile list the players see, used for two things: the generated card this
// promotion falls back to, and where it currently lands in the carousel.
const promos = ref<PublicPromotionDto[]>([])

const fileName = (url: string) => (url.split('?')[0].split('/').pop() ?? url)

async function loadArtwork() {
  // There is no single-row GET: artwork is addressed by (kind, refId) and the
  // list is a handful of rows, one per promotion that has a banner at all.
  const { items } = await getPromoArtwork()
  const row = items.find((i) => i.kind === kind.value && i.refId === props.refId) ?? null
  artwork.value = row
  altDraft.value = row?.altText ?? ''
  storedFacts.value = null
  if (row) void measureStored(row)
}

async function measureStored(row: PromoArtworkDto) {
  const [dims, bytes] = await Promise.all([
    readDimensions(row.imageUrl).catch(() => null),
    byteSize(row.imageUrl),
  ])
  // A later upload may have landed while this was decoding.
  if (artwork.value?.imageUrl !== row.imageUrl) return
  storedFacts.value = dims ? { name: fileName(row.imageUrl), ...dims, bytes } : null
}

async function loadPromos() {
  // Public, cached and unauthenticated — the preview is a nicety, so a failure
  // hides the generated card and the position read-out rather than the panel.
  try {
    const payload = await apiFetch<{ promotions: PublicPromotionDto[] }>('/promotions')
    promos.value = payload.promotions ?? []
  } catch {
    promos.value = []
  }
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    await Promise.all([loadArtwork(), loadPromos()])
  } catch (e) {
    loadError.value = errorMessage(e, 'Failed to load the artwork')
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => `${props.kind}:${props.refId}`, () => {
  clearPick()
  void load()
})

/* ── Picking a file ─────────────────────────────────────────────────────── */

type Pick = {
  file: File
  previewUrl: string
  dims: { width: number; height: number } | null
  problem: string | null
  checking: boolean
}

const pick = ref<Pick | null>(null)
const dragging = ref(false)
// Bumped on every pick so a slow decode cannot overwrite a newer choice.
let pickSeq = 0

function clearPick() {
  pickSeq++
  if (pick.value) URL.revokeObjectURL(pick.value.previewUrl)
  pick.value = null
  dragging.value = false
}

async function acceptFile(file: File) {
  clearPick()

  if (!ALLOWED_TYPES.includes(file.type)) {
    pick.value = { file, previewUrl: '', dims: null, problem: `The image must be ${typeLabel}`, checking: false }
    return
  }
  if (file.size > PROMO_CARD_SPEC.maxFileBytes) {
    pick.value = {
      file,
      previewUrl: '',
      dims: null,
      problem: `The image must be ${maxMb}MB or smaller; this one is ${formatBytes(file.size)}`,
      checking: false,
    }
    return
  }

  const seq = ++pickSeq
  const previewUrl = URL.createObjectURL(file)
  pick.value = { file, previewUrl, dims: null, problem: null, checking: true }
  try {
    const dims = await readDimensions(previewUrl)
    if (seq !== pickSeq || !pick.value) return
    pick.value.dims = dims
    // The same function the route runs, so a refusal here reads exactly like
    // the 400 the admin would otherwise have had to upload a megabyte to see.
    pick.value.problem = promoCardImageProblem(dims.width, dims.height)
  } catch {
    if (seq !== pickSeq || !pick.value) return
    pick.value.problem = 'The image could not be read'
  } finally {
    if (seq === pickSeq && pick.value) pick.value.checking = false
  }
}

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) void acceptFile(file)
}

function onDrop(e: DragEvent) {
  dragging.value = false
  const file = e.dataTransfer?.files?.[0]
  if (file) void acceptFile(file)
}

const pickFacts = computed(() => {
  const p = pick.value
  if (!p) return null
  const parts = [p.dims ? `${p.dims.width} × ${p.dims.height}` : null, p.dims ? ratioLabel(p.dims.width, p.dims.height) : null, formatBytes(p.file.size)]
  return parts.filter(Boolean).join(' · ')
})

const storedFactsLine = computed(() => {
  const f = storedFacts.value
  if (!f) return null
  return [`${f.width} × ${f.height}`, ratioLabel(f.width, f.height), f.bytes == null ? null : formatBytes(f.bytes)]
    .filter(Boolean)
    .join(' · ')
})

onBeforeUnmount(clearPick)

/* ── Saving ─────────────────────────────────────────────────────────────── */

const uploading = ref(false)
const removing = ref(false)
const savingAlt = ref(false)
const moving = ref(false)

const canUpload = computed(() => !!pick.value && !pick.value.problem && !pick.value.checking && !uploading.value)

async function upload() {
  const p = pick.value
  if (!p || !canUpload.value) return
  uploading.value = true
  try {
    // The caption rides along with the image: the upsert writes altText every
    // time, so leaving it out of a replace would blank a caption that is still
    // correct.
    const { item } = await uploadPromoArtwork(kind.value, props.refId, {
      image: p.file,
      altText: altDraft.value.trim(),
    })
    artwork.value = item
    altDraft.value = item.altText
    clearPick()
    storedFacts.value = null
    void measureStored(item)
    void loadPromos()
    toast.add({
      title: 'Artwork saved',
      description: 'It replaces the generated card everywhere this promotion appears.',
      color: 'success',
    })
  } catch (e) {
    // Belt and braces: the browser check above already refused the obvious
    // failures, but the server sniffs the actual bytes and may still say no.
    toast.add({ title: 'Upload failed', description: errorMessage(e, 'Failed to upload the artwork'), color: 'error' })
  } finally {
    uploading.value = false
  }
}

/* Alt text saves when the field loses focus — there is no form to submit here. */
const altDirty = computed(() => !!artwork.value && altDraft.value.trim() !== artwork.value.altText)

async function onAltBlur() {
  if (!artwork.value || !altDirty.value || savingAlt.value) return
  const value = altDraft.value.trim()
  savingAlt.value = true
  try {
    const { item } = await updatePromoArtwork(kind.value, props.refId, { altText: value })
    artwork.value = item
    altDraft.value = item.altText
    toast.add({ title: 'Alt text saved', color: 'success' })
  } catch (e) {
    altDraft.value = artwork.value?.altText ?? ''
    toast.add({ title: 'Error', description: errorMessage(e, 'Failed to save the alt text'), color: 'error' })
    if (statusOf(e) === 404) void load()
  } finally {
    savingAlt.value = false
  }
}

const showRemoveConfirm = ref(false)

async function remove() {
  if (removing.value) return
  removing.value = true
  try {
    await deletePromoArtwork(kind.value, props.refId)
    artwork.value = null
    storedFacts.value = null
    altDraft.value = ''
    showRemoveConfirm.value = false
    void loadPromos()
    toast.add({ title: 'Artwork removed', description: 'The generated card is live again.', color: 'success' })
  } catch (e) {
    if (statusOf(e) === 404) {
      // Someone else already removed it; the outcome is the one we wanted.
      artwork.value = null
      storedFacts.value = null
      showRemoveConfirm.value = false
      void loadPromos()
    } else {
      toast.add({ title: 'Error', description: errorMessage(e, 'Failed to remove the artwork'), color: 'error' })
    }
  } finally {
    removing.value = false
  }
}

/* ── Carousel position ──────────────────────────────────────────────────── */

/** The ceiling PromoArtworkFieldsSchema accepts for `position`. */
const MAX_PIN = 999

const pin = computed(() => artwork.value?.position ?? null)

const slotIndex = computed(() => promos.value.findIndex((p) => p.kind === kind.value && p.refId === props.refId))
const inCarousel = computed(() => slotIndex.value >= 0)

const ordinal = (n: number) => {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'
  return `${n}${suffix}`
}

const rankLabel = computed(() =>
  inCarousel.value ? `${ordinal(slotIndex.value + 1)} of ${promos.value.length}` : 'Not in the carousel',
)

const pinLabel = computed(() => {
  if (!artwork.value) return 'Needs artwork'
  return pin.value == null ? 'Automatic order' : `Pinned at ${pin.value}`
})

const nextPin = (delta: number) => {
  // An unpinned tile has no number to step from, so the first press starts at
  // the slot it currently occupies.
  const base = pin.value ?? (inCarousel.value ? slotIndex.value : 0)
  return Math.min(MAX_PIN, Math.max(0, base + delta))
}

const canMove = (delta: number) => !!artwork.value && !moving.value && nextPin(delta) !== pin.value

async function move(delta: number) {
  if (!canMove(delta)) return
  moving.value = true
  try {
    const { item } = await updatePromoArtwork(kind.value, props.refId, { position: nextPin(delta) })
    artwork.value = item
    // Pinning is sparse and unpinned tiles trail pinned ones, so one step can
    // move a tile more than one slot. Re-read the row rather than predict it.
    await loadPromos()
  } catch (e) {
    toast.add({ title: 'Error', description: errorMessage(e, 'Failed to move the promotion'), color: 'error' })
    if (statusOf(e) === 404) void load()
  } finally {
    moving.value = false
  }
}

/* ── Live preview ───────────────────────────────────────────────────────── */

/**
 * Accent values lifted from apps/web/components/PromoTile.vue so the preview is
 * the tile and not a likeness of it.
 */
const ACCENTS = {
  amber: { kick: '#fcd34d', glow: 'rgba(245,158,11,0.34)', rail: 'linear-gradient(90deg, #b45309, #f59e0b)' },
  cyan: { kick: '#67e8f9', glow: 'rgba(34,211,238,0.26)', rail: 'linear-gradient(90deg, #0e7490, #22d3ee)' },
  emerald: { kick: '#6ee7b7', glow: 'rgba(52,211,153,0.22)', rail: 'linear-gradient(90deg, #047857, #34d399)' },
  rose: { kick: '#fda4af', glow: 'rgba(251,113,133,0.24)', rail: 'linear-gradient(90deg, #9f1239, #fb7185)' },
} as const

const promo = computed(() => (inCarousel.value ? promos.value[slotIndex.value] : null))
const accent = computed(() => ACCENTS[promo.value?.accent ?? 'amber'])
const mark = computed(() => (promo.value?.unit.includes('%') ? '%' : (promo.value?.figure ?? '')))
const unitSpaced = computed(() => !promo.value?.unit.trimStart().startsWith('%'))
const chipLabel = computed(() => {
  if (promo.value?.action === 'deposit') return 'Deposit'
  return promo.value?.action === 'referral' ? 'Link' : ''
})

/** What the tile shows: the saved image, or the one waiting to be saved. */
const previewImage = computed(() => {
  if (pick.value && !pick.value.problem && pick.value.previewUrl) {
    return { url: pick.value.previewUrl, alt: altDraft.value.trim() || promo.value?.name || '', pending: true }
  }
  if (artwork.value) return { url: artwork.value.imageUrl, alt: artwork.value.altText, pending: false }
  return null
})

const artworkCaption = computed(() => {
  if (!previewImage.value) return 'Nothing uploaded'
  return previewImage.value.pending ? 'Your pick, once saved' : 'With your artwork'
})

/** A stand-in bar, so the one thing ever drawn over artwork is visible here. */
const SAMPLE_PROGRESS = 64
</script>

<template>
  <section class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-sm font-bold tracking-wide text-white">Card artwork</h2>
      <span v-if="!loading && !loadError" class="tag" :class="artwork ? 'tag--live' : ''">
        {{ artwork ? 'Artwork live' : 'Generated card' }}
      </span>
    </div>
    <p class="cap max-w-2xl">
      Upload a wide banner and it replaces the generated card everywhere this promotion appears. Leave it empty and the
      generated card is used.
    </p>

    <div v-if="loading" class="admin-card flex items-center gap-2 px-4 py-6 text-[13px] text-white/55">
      <UIcon name="i-heroicons:arrow-path" class="h-4 w-4 animate-spin" />
      Loading artwork…
    </div>

    <div v-else-if="loadError" class="admin-card flex flex-wrap items-center gap-3 px-4 py-4" style="border-color: rgba(239,68,68,0.3)">
      <UIcon name="i-heroicons:exclamation-triangle" class="h-5 w-5 shrink-0 text-red-400" />
      <p class="m-0 flex-1 text-[13px] text-white/70">{{ loadError }}</p>
      <button type="button" class="btn btn--ghost" @click="load">
        <UIcon name="i-heroicons:arrow-path" class="h-3.5 w-3.5" />
        Retry
      </button>
    </div>

    <template v-else>
      <div class="grid items-start gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <!-- ── The image ── -->
        <div class="admin-card flex flex-col gap-3.5 px-4 py-4 md:px-[18px]">
          <div class="flex items-center justify-between gap-3">
            <span class="h">Uploaded image</span>
            <span v-if="pick && !pick.problem" class="tag tag--pending">Not saved yet</span>
          </div>

          <!-- Empty: a dropzone that states the spec -->
          <label
            v-if="!artwork && !pick"
            class="drop"
            :class="{ 'drop--over': dragging }"
            :style="ratioStyle"
            @dragover.prevent="dragging = true"
            @dragenter.prevent="dragging = true"
            @dragleave="dragging = false"
            @drop.prevent="onDrop"
          >
            <UIcon name="i-heroicons:arrow-up-tray" class="h-6 w-6 text-white/55" />
            <span class="text-[13px] font-semibold text-white">Drop a banner here, or choose a file</span>
            <span class="cap px-6 text-center">{{ specLine }}</span>
            <input type="file" :accept="acceptAttr" class="sr-only" aria-label="Choose promo artwork" @change="onPick">
          </label>

          <template v-else>
            <!-- 240 x 80 — the 3:1 shape at a size that reads on the page -->
            <div class="thumb" :style="ratioStyle">
              <img v-if="previewImage" :src="previewImage.url" :alt="previewImage.alt" class="thumb-img">
              <div v-else class="flex h-full items-center justify-center px-3 text-center text-[12px] text-white/55">
                Nothing to show — the file was refused
              </div>
            </div>

            <p v-if="pick?.checking" class="flex items-center gap-1.5 text-[12.5px] text-white/55">
              <UIcon name="i-heroicons:arrow-path" class="h-3.5 w-3.5 animate-spin" />
              Checking the image…
            </p>
            <p v-else-if="pick?.problem" class="flex items-start gap-2 text-[12.5px] font-medium text-red-400">
              <UIcon name="i-heroicons:x-circle" class="mt-px h-4 w-4 shrink-0" />
              <span>{{ pick.problem }}</span>
            </p>

            <div class="flex flex-wrap items-center gap-x-3.5 gap-y-2">
              <div v-if="pick && !pick.problem && !pick.checking" class="flex items-center gap-2">
                <UIcon name="i-heroicons:check-circle" class="h-4 w-4 shrink-0 text-emerald-400" />
                <span class="text-[13px] text-white/85">{{ pickFacts }}</span>
              </div>
              <div v-else-if="!pick && storedFactsLine" class="flex items-center gap-2">
                <UIcon name="i-heroicons:check-circle" class="h-4 w-4 shrink-0 text-emerald-400" />
                <span class="text-[13px] text-white/85">{{ storedFactsLine }}</span>
              </div>
              <span v-if="pick || storedFacts" class="cap max-w-[16rem] truncate">
                {{ pick ? pick.file.name : storedFacts?.name }}
              </span>

              <div class="ml-auto flex flex-wrap gap-2">
                <template v-if="pick">
                  <button type="button" class="btn btn--ghost" :disabled="uploading" @click="clearPick">Cancel</button>
                  <button type="button" class="btn btn--primary" :disabled="!canUpload" @click="upload">
                    <UIcon v-if="uploading" name="i-heroicons:arrow-path" class="h-3.5 w-3.5 animate-spin" />
                    <UIcon v-else name="i-heroicons:check" class="h-3.5 w-3.5" />
                    {{ artwork ? 'Save replacement' : 'Save artwork' }}
                  </button>
                </template>
                <template v-else>
                  <label class="btn btn--ghost cursor-pointer">
                    <UIcon name="i-heroicons:arrow-up-tray" class="h-3.5 w-3.5" />
                    Replace
                    <input type="file" :accept="acceptAttr" class="sr-only" aria-label="Replace promo artwork" @change="onPick">
                  </label>
                  <button type="button" class="btn btn--danger" @click="showRemoveConfirm = true">
                    <UIcon name="i-heroicons:trash" class="h-3.5 w-3.5" />
                    Remove
                  </button>
                </template>
              </div>
            </div>

            <div class="border-t border-white/[0.06] pt-3.5">
              <label class="k mb-1.5 block" for="promo-art-alt">
                Alt text
                <span class="text-white/55">· read aloud instead of the image</span>
              </label>
              <UInput
                id="promo-art-alt"
                v-model="altDraft"
                :placeholder="promo ? `e.g. ${promo.name} — ${promo.figure}${promo.unit}` : 'Describe what the banner says'"
                maxlength="160"
                class="w-full"
                :disabled="savingAlt"
                @blur="onAltBlur"
              />
              <p class="cap mt-1.5">
                <template v-if="savingAlt">Saving…</template>
                <template v-else-if="!artwork">Saved with the image.</template>
                <template v-else-if="altDirty">Saves when you click away.</template>
                <template v-else>Saved.</template>
              </p>
            </div>
          </template>

          <div class="note">
            <UIcon name="i-heroicons:exclamation-triangle" class="mt-px h-4 w-4 shrink-0 text-amber-400" />
            <p class="m-0 text-[12.5px] leading-normal text-white/80">
              <strong class="font-semibold text-white">Anything that is not {{ targetRatio }} is refused</strong>
              rather than cropped, and the tile is only 75px tall on desktop — a wordmark and one figure is all that
              will read. Detail belongs in the promotion copy, not the image.
            </p>
          </div>
        </div>

        <!-- ── Requirements, read off PROMO_CARD_SPEC ── -->
        <div class="admin-card px-4 py-4 md:px-[18px]">
          <span class="h block pb-3">Image requirements</span>
          <div class="row"><span class="k">Orientation</span><span class="v">Landscape</span></div>
          <div class="row">
            <span class="k">Aspect ratio</span>
            <span class="v">{{ targetRatio }} · required, ±{{ tolerancePct }}%</span>
          </div>
          <div class="row"><span class="k">Recommended size</span><span class="v">{{ targetSize }} or larger</span></div>
          <div class="row"><span class="k">Minimum width</span><span class="v">{{ PROMO_CARD_SPEC.minWidth }}px</span></div>
          <div class="row"><span class="k">Formats</span><span class="v">{{ typeLabel }}</span></div>
          <div class="row"><span class="k">Maximum file size</span><span class="v">{{ maxMb }} MB</span></div>
          <div class="row"><span class="k">Mobile crop</span><span class="v">Not needed — one image</span></div>
          <div class="row"><span class="k">Keep clear</span><span class="v">Bottom 14px · progress rail</span></div>
          <p class="cap mt-3.5 border-t border-white/[0.06] pt-3.5 leading-relaxed">
            The artwork owns the tile. The only thing drawn over it is the player's progress, a 3px hairline on the
            bottom edge over a soft scrim, so a personalised card never costs you the design.
          </p>
          <p class="cap mt-3 leading-relaxed">
            The same file is used at every width. It is scaled, never re-cropped, so a wordmark that reads at 225px
            reads at 342 too.
          </p>
        </div>
      </div>

      <!-- ── How players will see it ── -->
      <div class="admin-card flex flex-col gap-3 px-4 py-4 md:px-[18px]">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="h">How players will see it</span>
          <span class="cap">Lobby carousel · 225 × 75 · bar shown at a sample {{ SAMPLE_PROGRESS }}%</span>
        </div>

        <div class="flex flex-wrap items-start gap-5">
          <!-- With artwork -->
          <figure class="m-0 flex flex-col gap-2.5">
            <div v-if="previewImage" class="tile">
              <img :src="previewImage.url" :alt="previewImage.alt" class="art">
              <div class="railscrim" />
              <div class="rail" aria-hidden="true">
                <div class="fill" :style="{ width: `${SAMPLE_PROGRESS}%`, background: accent.rail }" />
              </div>
            </div>
            <div v-else class="tile tile--empty">
              <span class="cap px-4 text-center">No artwork yet</span>
            </div>
            <figcaption class="tag" :class="previewImage ? 'tag--live' : ''">{{ artworkCaption }}</figcaption>
          </figure>

          <!-- The generated fallback, so Remove holds no surprises -->
          <figure class="m-0 flex flex-col gap-2.5">
            <div v-if="promo" class="tile">
              <div class="ground" :style="{ '--glow': accent.glow }" />
              <div class="lattice" />
              <div class="vignette" />
              <div class="mark" aria-hidden="true">{{ mark }}</div>
              <div class="body">
                <div class="stack">
                  <p class="fig metal">
                    {{ promo.figure }}<span class="unit" :class="{ 'unit--spaced': unitSpaced }">{{ promo.unit }}</span>
                  </p>
                  <span class="kick" :style="{ color: accent.kick }">{{ promo.name }}</span>
                </div>
                <span v-if="chipLabel" class="chip" :class="{ 'chip--light': promo.action === 'referral' }">
                  {{ chipLabel }}
                </span>
                <svg v-else class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" aria-hidden="true">
                  <path d="m9 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </div>
              <div class="rail" aria-hidden="true">
                <div class="fill" :style="{ width: `${SAMPLE_PROGRESS}%`, background: accent.rail }" />
              </div>
            </div>
            <div v-else class="tile tile--empty">
              <span class="cap px-4 text-center">Not in the carousel</span>
            </div>
            <figcaption class="tag">{{ artwork ? 'Generated, if you remove it' : 'Generated · live now' }}</figcaption>
          </figure>

          <!-- Where it appears, and the carousel pin -->
          <div class="flex min-w-[15rem] flex-1 flex-col gap-3">
            <span class="h">Where this artwork appears</span>
            <div class="flex items-center gap-2.5">
              <span class="pip"><UIcon name="i-heroicons:rectangle-group" class="h-4 w-4" /></span>
              <span class="flex flex-col"><span class="v">Lobby carousel</span><span class="k">Five across at 225 × 75</span></span>
            </div>
            <div class="flex items-center gap-2.5">
              <span class="pip"><UIcon name="i-heroicons:bars-3" class="h-4 w-4" /></span>
              <span class="flex flex-col"><span class="v">Promotions page</span><span class="k">Full width at 342 × 114</span></span>
            </div>
            <div class="flex items-center gap-2.5">
              <span class="pip pip--muted"><UIcon name="i-heroicons:wallet" class="h-4 w-4" /></span>
              <span class="flex flex-col"><span class="v text-white/62">Wallet — Earn More</span><span class="k">Generated only</span></span>
            </div>

            <div class="pinbox">
              <div class="flex flex-col gap-0.5">
                <span class="k">Carousel position</span>
                <span class="v tabular-nums">{{ rankLabel }}</span>
                <span class="k">{{ pinLabel }}</span>
              </div>
              <div class="flex gap-1.5">
                <button type="button" class="sq" aria-label="Move earlier in the carousel" :disabled="!canMove(-1)" @click="move(-1)">
                  <UIcon name="i-heroicons:chevron-left" class="h-3.5 w-3.5" />
                </button>
                <button type="button" class="sq" aria-label="Move later in the carousel" :disabled="!canMove(1)" @click="move(1)">
                  <UIcon name="i-heroicons:chevron-right" class="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <p class="cap mt-auto border-t border-white/[0.06] pt-2.5 leading-normal">
              <template v-if="!artwork">Position is stored with the artwork, so a promotion has to have a banner before it can be pinned.</template>
              <template v-else>Lower numbers come first; unpinned promotions follow the pinned ones. A promotion that is paused or outside its window keeps its artwork but drops out of the carousel.</template>
            </p>
          </div>
        </div>
      </div>
    </template>

    <UModal v-model:open="showRemoveConfirm" title="Remove artwork" :ui="{ footer: 'justify-end' }">
      <template #body>
        <div class="flex flex-col gap-3">
          <div v-if="artwork" class="thumb" :style="ratioStyle">
            <img :src="artwork.imageUrl" :alt="artwork.altText" class="thumb-img">
          </div>
          <p class="m-0 text-[13px] text-white/70">
            This image is dropped and the generated card — the one beside it in the preview — goes live in its place.
            The carousel pin goes with it. The promotion itself is untouched.
          </p>
        </div>
      </template>
      <template #footer>
        <button type="button" class="btn btn--ghost" :disabled="removing" @click="showRemoveConfirm = false">Cancel</button>
        <button type="button" class="btn btn--danger" :disabled="removing" @click="remove">
          <UIcon v-if="removing" name="i-heroicons:arrow-path" class="h-3.5 w-3.5 animate-spin" />
          <UIcon v-else name="i-heroicons:trash" class="h-3.5 w-3.5" />
          Remove artwork
        </button>
      </template>
    </UModal>
  </section>
</template>

<style scoped>
/* Panel chrome, lifted from docs/design/bonus-cashback/AdminPromoArtwork.dc.html.
   Two deliberate departures from the artboard: every control is 44px rather than
   40 or 34 so it clears the hit-target floor, and no grey goes below
   rgba(255,255,255,0.55) on these surfaces. */
.h {
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: #fff;
}
.k {
  font-size: 12.5px;
  color: rgba(255, 255, 255, 0.55);
}
.v {
  font-size: 13px;
  font-weight: 500;
  color: #fff;
}
.cap {
  font-size: 12.5px;
  color: rgba(255, 255, 255, 0.55);
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.tag {
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.55);
}
.tag--live {
  color: #34d399;
}
.tag--pending {
  color: #fbbf24;
}
.note {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 12px;
  border-radius: 10px;
  background: rgba(251, 191, 36, 0.07);
  border: 1px solid rgba(251, 191, 36, 0.22);
}
.pip {
  display: flex;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: rgba(245, 166, 35, 0.13);
  color: var(--brand-primary);
}
.pip--muted {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.55);
}
.pinbox {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
}

/* ── Controls ──────────────────────────────────────────────────────────── */
.btn {
  font-family: var(--font-ui);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 44px;
  padding: 0 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.03em;
  white-space: nowrap;
  border: 1px solid transparent;
}
.btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.btn--primary {
  background: var(--brand-primary);
  color: #12203a;
}
.btn--primary:not(:disabled):hover {
  background: var(--brand-primary-dim);
}
.btn--ghost {
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--surface-border);
  color: rgba(255, 255, 255, 0.85);
}
.btn--ghost:not(:disabled):hover {
  color: #fff;
  border-color: rgba(255, 255, 255, 0.22);
}
.btn--danger {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.28);
  color: #f87171;
}
.btn--danger:not(:disabled):hover {
  background: rgba(239, 68, 68, 0.16);
}
.sq {
  display: flex;
  width: 44px;
  height: 44px;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--surface-border);
  color: #fff;
}
.sq:disabled {
  opacity: 0.4;
  cursor: default;
}
.btn:focus-visible,
.btn:focus-within,
.sq:focus-visible,
.drop:focus-within {
  outline: 2px solid var(--brand-primary);
  outline-offset: 2px;
}

/* ── Dropzone and thumbnail ────────────────────────────────────────────── */
.drop {
  position: relative;
  display: flex;
  width: 100%;
  max-width: 420px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: 10px;
  border: 1px dashed var(--surface-border);
  background: var(--surface-overlay);
  cursor: pointer;
}
.drop:hover,
.drop--over {
  border-color: color-mix(in srgb, var(--brand-primary) 45%, transparent);
}
.thumb {
  position: relative;
  width: 240px;
  overflow: hidden;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: var(--surface-overlay);
}
.thumb-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* ── The player tile, at its real 225 x 75 ─────────────────────────────────
   Geometry and colour copied from the artboard, which matches
   apps/web/components/PromoTile.vue: this has to be the tile itself, or the
   preview is worth nothing. Static here — no link, no hover. */
.tile {
  position: relative;
  width: 225px;
  height: 75px;
  flex-shrink: 0;
  box-sizing: border-box;
  border-radius: 12px;
  overflow: hidden;
  background: #0e1729;
  border: 1px solid rgba(255, 255, 255, 0.09);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.45);
  isolation: isolate;
}
.tile--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  border-style: dashed;
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.02);
  box-shadow: none;
}
.ground {
  position: absolute;
  inset: 0;
  z-index: -3;
  background:
    radial-gradient(70% 180% at 6% 50%, var(--glow), transparent 64%),
    linear-gradient(100deg, #1a2748 0%, #121e36 52%, #0b1223 100%);
}
.lattice {
  position: absolute;
  inset: 0;
  z-index: -2;
  background-image:
    repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.03) 0 1px, transparent 1px 14px),
    repeating-linear-gradient(-45deg, rgba(255, 255, 255, 0.03) 0 1px, transparent 1px 14px);
}
.vignette {
  position: absolute;
  inset: 0;
  z-index: -1;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
}
.mark {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  z-index: -1;
  font-family: 'Oswald', system-ui, sans-serif;
  font-weight: 700;
  font-size: 62px;
  line-height: 0.8;
  letter-spacing: -2px;
  color: rgba(255, 255, 255, 0.045);
  white-space: nowrap;
  user-select: none;
}
.metal {
  background: linear-gradient(180deg, #fff6d0 0%, #fcd34d 26%, #f0a51b 58%, #a8570a 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 1px 0 rgba(0, 0, 0, 0.5)) drop-shadow(0 4px 12px rgba(245, 158, 11, 0.24));
}
.body {
  position: relative;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 13px;
  box-sizing: border-box;
}
.stack {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
}
.fig {
  font-family: 'Oswald', system-ui, sans-serif;
  font-weight: 700;
  font-size: 26px;
  line-height: 1;
  letter-spacing: -0.3px;
  margin: 0;
  white-space: nowrap;
}
.unit {
  font-size: 13px;
  letter-spacing: 1.5px;
}
.unit--spaced {
  margin-left: 0.24em;
}
.kick {
  font-family: var(--font-ui);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 1.6px;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip {
  font-family: var(--font-ui);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border-radius: 7px;
  background: linear-gradient(180deg, #fbbf24, #f59e0b);
  color: #1a1205;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  white-space: nowrap;
  box-shadow:
    0 4px 10px rgba(245, 158, 11, 0.32),
    inset 0 1px 0 rgba(255, 255, 255, 0.4);
}
.chip--light {
  background: linear-gradient(180deg, #ffffff, #dbe3ee);
  color: #0b1120;
  box-shadow:
    0 4px 10px rgba(0, 0, 0, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.8);
}
.chev {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  color: rgba(255, 255, 255, 0.55);
}
.art {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.rail {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgba(0, 0, 0, 0.42);
}
.rail .fill {
  height: 100%;
}
.railscrim {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 14px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.45), transparent);
  pointer-events: none;
}
</style>
