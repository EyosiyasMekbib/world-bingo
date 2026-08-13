<script setup lang="ts">
/**
 * Create a prediction market. It always lands in DRAFT — publishing is a
 * separate, deliberate action from the market list.
 *
 * OVERRIDES ARE OPT-IN. `shareValue`, `feePct` and the order-size bounds are
 * snapshotted onto the market at creation, from `SiteSetting` unless the
 * operator overrides them here. Sending an unchecked "override" block would
 * bake this form's placeholder numbers into the market instead of the platform
 * defaults, so those fields are omitted from the body entirely unless the
 * override switch is on.
 *
 * On the wire an inbound price is a NUMBER — that is how a JSON body carries
 * it — constrained to whole birr (and two decimals for the fee percent) so the
 * number → `Prisma.Decimal` conversion at the API boundary is exact. Nothing
 * here does float arithmetic on money: the only computation is the price band,
 * which is integer subtraction on a whole-birr share value.
 */
definePageMeta({ layout: 'default' })

const { apiFetch } = useAdminAuth()
const toast = useToast()
const router = useRouter()

/** Mirrors the server fallbacks; shown as placeholders, never sent implicitly. */
const DEFAULT_SHARE_VALUE = 100
const DEFAULT_FEE_PCT = 15
const DEFAULT_MIN_SHARES = 1
const DEFAULT_MAX_SHARES = 10000

const saving = ref(false)

const form = reactive({
  eventName: '',
  question: '',
  outcomeA: '',
  outcomeB: '',
  closesAt: '',
  description: '',
  imageUrl: '',
  useOverrides: false,
  shareValue: DEFAULT_SHARE_VALUE,
  feePct: DEFAULT_FEE_PCT,
  minOrderShares: DEFAULT_MIN_SHARES,
  maxOrderShares: DEFAULT_MAX_SHARES,
})

/** The share value this market will actually carry, override or not. */
const effectiveShareValue = computed(() =>
  form.useOverrides ? Math.trunc(form.shareValue || 0) : DEFAULT_SHARE_VALUE,
)

/**
 * Valid limit prices are `1 .. shareValue - 1` in whole 1 ETB ticks:
 * `shareValue` would be a free share and 0 a free option, and a matched pair
 * must escrow exactly one share value.
 */
const priceBand = computed(() => {
  const share = effectiveShareValue.value
  if (!Number.isInteger(share) || share < 2) return null
  return { share, max: share - 1 }
})

const closesAtDate = computed(() => {
  if (!form.closesAt) return null
  const parsed = new Date(form.closesAt)
  return Number.isNaN(parsed.getTime()) ? null : parsed
})

/**
 * Client-side mirror of `CreatePredictionMarketSchema` plus the service's own
 * rules. The server is still the authority — this only stops the obvious.
 */
const errors = computed(() => {
  const found: string[] = []
  const eventName = form.eventName.trim()
  const question = form.question.trim()
  const a = form.outcomeA.trim()
  const b = form.outcomeB.trim()

  if (eventName.length < 2) found.push('Event name needs at least 2 characters')
  if (question.length < 4) found.push('Question needs at least 4 characters')
  if (!a || !b) found.push('Both outcome labels are required')
  else if (a.toLowerCase() === b.toLowerCase()) found.push('The two outcomes must be different')

  if (!closesAtDate.value) found.push('A closing time is required')
  else if (closesAtDate.value.getTime() <= Date.now()) found.push('Closing time must be in the future')

  if (form.useOverrides) {
    if (!priceBand.value) found.push('Share value must be a whole number of at least 2 ETB')
    if (form.feePct < 0 || form.feePct > 100) found.push('Fee must be between 0 and 100 percent')
    if (!Number.isInteger(form.minOrderShares) || form.minOrderShares < 1) {
      found.push('Minimum order size must be at least 1 share')
    }
    if (!Number.isInteger(form.maxOrderShares) || form.maxOrderShares < 1) {
      found.push('Maximum order size must be at least 1 share')
    }
    if (form.minOrderShares > form.maxOrderShares) {
      found.push('Maximum order size must not be below the minimum')
    }
  }

  return found
})

const canSave = computed(() => errors.value.length === 0)

async function save() {
  if (!canSave.value || !closesAtDate.value) return
  saving.value = true
  try {
    const body: Record<string, unknown> = {
      eventName: form.eventName.trim(),
      question: form.question.trim(),
      closesAt: closesAtDate.value.toISOString(),
      outcomes: [
        { label: form.outcomeA.trim(), sortOrder: 0 },
        { label: form.outcomeB.trim(), sortOrder: 1 },
      ],
    }
    if (form.description.trim()) body.description = form.description.trim()
    if (form.imageUrl.trim()) body.imageUrl = form.imageUrl.trim()

    // Only sent when explicitly overridden — otherwise the server snapshots the
    // platform defaults onto the market.
    if (form.useOverrides) {
      body.shareValue = Math.trunc(form.shareValue)
      body.feePct = form.feePct
      body.minOrderShares = Math.trunc(form.minOrderShares)
      body.maxOrderShares = Math.trunc(form.maxOrderShares)
    }

    const market = await apiFetch<{ id: string }>('/admin/prediction/markets', {
      method: 'POST',
      body,
    })
    toast.add({
      title: 'Market created as a draft',
      description: 'It is not tradeable until you publish it.',
      color: 'success',
    })
    router.push(`/predictions/${market.id}`)
  } catch (err: any) {
    toast.add({
      title: 'Could not create market',
      description: err?.data?.error ?? 'Create failed',
      color: 'error',
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-6 max-w-3xl">
    <div class="flex items-center gap-2">
      <UButton icon="i-heroicons:arrow-left" variant="ghost" color="neutral" to="/predictions" />
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">New prediction market</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">
          Creates a draft. Nothing is tradeable until you publish it.
        </p>
      </div>
    </div>

    <!-- The event -->
    <div class="rounded-2xl border border-(--surface-border) p-5 shadow-lg space-y-4" style="background:var(--surface-raised);">
      <h2 class="text-sm font-bold text-white uppercase tracking-widest">The event</h2>

      <UFormField label="Event name" required>
        <UInput v-model="form.eventName" placeholder="ETFC Fight Night" class="w-full" />
      </UFormField>

      <UFormField label="Question" required>
        <UInput
          v-model="form.question"
          placeholder="Sedo vs Johnny — who wins?"
          class="w-full"
        />
      </UFormField>

      <UFormField label="Description" hint="Optional">
        <UTextarea
          v-model="form.description"
          :rows="2"
          placeholder="Heavyweight, 5 rounds. Adwa Museum, Addis Ababa."
          class="w-full"
        />
      </UFormField>

      <UFormField label="Image URL" hint="Optional">
        <UInput v-model="form.imageUrl" placeholder="https://…" class="w-full" />
      </UFormField>
    </div>

    <!-- The two sides -->
    <div class="rounded-2xl border border-(--surface-border) p-5 shadow-lg space-y-4" style="background:var(--surface-raised);">
      <div>
        <h2 class="text-sm font-bold text-white uppercase tracking-widest">The two outcomes</h2>
        <p class="text-xs text-white/40 mt-1">
          Exactly two, and they are frozen once the market opens. Buying one side is offering the
          other — both live in a single book.
        </p>
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField label="Outcome A" required>
          <UInput v-model="form.outcomeA" placeholder="Sedo" class="w-full" />
        </UFormField>
        <UFormField label="Outcome B" required>
          <UInput v-model="form.outcomeB" placeholder="Johnny" class="w-full" />
        </UFormField>
      </div>

      <UFormField label="Closes at" required hint="Orders stop when the book closes">
        <UInput v-model="form.closesAt" type="datetime-local" class="w-full" />
      </UFormField>
    </div>

    <!-- Terms -->
    <div class="rounded-2xl border border-(--surface-border) p-5 shadow-lg space-y-4" style="background:var(--surface-raised);">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-sm font-bold text-white uppercase tracking-widest">Terms</h2>
          <p class="text-xs text-white/40 mt-1">
            Snapshotted onto the market at creation. Leave the switch off to use the platform
            defaults ({{ DEFAULT_SHARE_VALUE }} ETB share, {{ DEFAULT_FEE_PCT }}% fee).
          </p>
        </div>
        <USwitch v-model="form.useOverrides" color="primary" />
      </div>

      <div v-if="form.useOverrides" class="grid gap-4 sm:grid-cols-2">
        <UFormField label="Share value (ETB)" hint="What a winning share pays">
          <UInput v-model.number="form.shareValue" type="number" min="2" step="1" class="w-full" />
        </UFormField>
        <UFormField label="Fee (% of profit)" hint="Never of gross payout">
          <UInput v-model.number="form.feePct" type="number" min="0" max="100" step="0.01" class="w-full" />
        </UFormField>
        <UFormField label="Min order size (shares)">
          <UInput v-model.number="form.minOrderShares" type="number" min="1" step="1" class="w-full" />
        </UFormField>
        <UFormField label="Max order size (shares)">
          <UInput v-model.number="form.maxOrderShares" type="number" min="1" step="1" class="w-full" />
        </UFormField>
      </div>

      <!-- The mechanism, stated in the market's own denomination. -->
      <div
        v-if="priceBand"
        class="rounded-xl border border-yellow-500/20 p-4 text-xs space-y-1"
        style="background:var(--surface-overlay);"
      >
        <div class="font-bold text-yellow-500 uppercase tracking-widest text-[10px]">How this market prices</div>
        <div class="text-white/60">
          A share pays exactly <strong class="text-white">{{ priceBand.share }} ETB</strong> if its
          outcome wins, and 0 otherwise.
        </div>
        <div class="text-white/60">
          Limit prices run <strong class="text-white">1 – {{ priceBand.max }} ETB</strong> in 1 ETB
          ticks. A buy at <em>p</em> on one side matches a buy at
          {{ priceBand.share }} − <em>p</em> on the other, so each matched pair escrows exactly
          {{ priceBand.share }} ETB. The house is never a counterparty.
        </div>
        <div v-if="priceBand.share === 100" class="text-white/60">
          At a 100 ETB share the price in birr <em>is</em> the probability in percent — 35 ETB = 35%.
        </div>
      </div>
    </div>

    <!-- Validation -->
    <UAlert v-if="errors.length" color="warning" variant="subtle" icon="i-heroicons:exclamation-triangle">
      <template #description>
        <ul class="list-disc pl-4 space-y-0.5 text-xs">
          <li v-for="error in errors" :key="error">{{ error }}</li>
        </ul>
      </template>
    </UAlert>

    <div class="flex items-center justify-end gap-2">
      <UButton label="Cancel" color="neutral" variant="ghost" to="/predictions" />
      <UButton
        label="Create draft"
        color="primary"
        :loading="saving"
        :disabled="!canSave"
        @click="save"
      />
    </div>
  </div>
</template>
