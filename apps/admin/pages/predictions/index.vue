<script setup lang="ts">
/**
 * Every prediction market, in every status.
 *
 * Publishing lives HERE and not only on the market page. The ETFC card seeds
 * eleven markets as DRAFT at once and the operator releases them selectively —
 * main event first, undercard as interest appears — so the control that opens a
 * book has to sit next to the list they are choosing from.
 *
 * MONEY IS NEVER A FLOAT ON THIS PAGE. Amounts arrive as decimal strings (a
 * Prisma `Decimal` serialized) and are formatted as strings; the one place that
 * has to add them up does it in integer minor units with BigInt. The only
 * numeric parse is `toWholeBirr`, which reads whole birr out of a price by
 * inspecting the text and refusing anything fractional.
 *
 * There is no hardcoded 100 anywhere here: the price-as-percentage reading is
 * computed from each market's own `shareValue`.
 */
import { toWholeBirr } from '@world-bingo/shared-types'
import type { PredictionMarketDto, PredictionOutcomeDto } from '@world-bingo/shared-types'

definePageMeta({ layout: 'default' })

type AdminMarket = PredictionMarketDto & { outcomes: PredictionOutcomeDto[] }

const { apiFetch } = useAdminAuth()
const toast = useToast()

const markets = ref<AdminMarket[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadingMore = ref(false)
const publishing = ref<string | null>(null)

const ALL = '__ALL__'
const selectedStatus = ref(ALL)

const statusOptions = [
  { label: 'All statuses', value: ALL },
  { label: 'Draft', value: 'DRAFT' },
  { label: 'Open', value: 'OPEN' },
  { label: 'Closed', value: 'CLOSED' },
  { label: 'Resolving', value: 'RESOLVING' },
  { label: 'Settled', value: 'SETTLED' },
  { label: 'Voided', value: 'VOIDED' },
]

// ── Formatting ──────────────────────────────────────────────────────────────

/**
 * Group a decimal-string amount for display. String work on purpose: these are
 * Decimals on the wire and must not round-trip through a JS float.
 */
function money(value: string | null | undefined, dp = 2): string {
  if (value === null || value === undefined || value === '') return '—'
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const decimals = dp > 0 ? `.${(fraction + '0'.repeat(dp)).slice(0, dp)}` : ''
  return `${negative ? '-' : ''}${grouped}${decimals}`
}

/** A decimal string as an exact integer count of minor units. */
function toMinor(value: string, dp = 2): bigint {
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const scale = BigInt(10) ** BigInt(dp)
  const minor = BigInt(whole || '0') * scale + BigInt((fraction + '0'.repeat(dp)).slice(0, dp) || '0')
  return negative ? -minor : minor
}

/** Exact sum of decimal strings, back out as a decimal string. */
function sumMoney(values: string[], dp = 2): string {
  const scale = BigInt(10) ** BigInt(dp)
  let total = BigInt(0)
  for (const value of values) total += toMinor(value, dp)
  const negative = total < BigInt(0)
  const abs = negative ? -total : total
  return `${negative ? '-' : ''}${abs / scale}.${(abs % scale).toString().padStart(dp, '0')}`
}

/**
 * Price as a probability. At the default 100 ETB share the two are the same
 * number, but the division is done against the market's own share value so a
 * market denominated differently still reads correctly.
 */
function pricePct(price: string | null, shareValue: string): number | null {
  if (!price) return null
  try {
    const share = toWholeBirr(shareValue)
    if (share <= 0) return null
    return Math.round((toWholeBirr(price) * 100) / share)
  } catch {
    return null
  }
}

function statusColor(status: string): 'primary' | 'success' | 'warning' | 'info' | 'error' | 'neutral' {
  switch (status) {
    case 'DRAFT': return 'neutral'
    case 'OPEN': return 'success'
    case 'CLOSED': return 'warning'
    case 'RESOLVING': return 'info'
    case 'SETTLED': return 'primary'
    case 'VOIDED': return 'error'
    default: return 'neutral'
  }
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function outcomeAt(market: AdminMarket, sortOrder: number): PredictionOutcomeDto | undefined {
  return market.outcomes.find((outcome) => outcome.sortOrder === sortOrder)
}

// ── Data ────────────────────────────────────────────────────────────────────

function query(cursor?: string | null) {
  const params = new URLSearchParams({ limit: '100' })
  if (selectedStatus.value !== ALL) params.set('status', selectedStatus.value)
  if (cursor) params.set('cursor', cursor)
  return params.toString()
}

async function load() {
  loading.value = true
  try {
    const data = await apiFetch<{ markets: AdminMarket[]; nextCursor: string | null }>(
      `/admin/prediction/markets?${query()}`,
    )
    markets.value = data.markets
    nextCursor.value = data.nextCursor
  } catch (err: any) {
    toast.add({
      title: 'Could not load markets',
      description: err?.data?.error ?? 'Is the prediction market feature enabled?',
      color: 'error',
    })
  } finally {
    loading.value = false
  }
}

async function loadMore() {
  if (!nextCursor.value) return
  loadingMore.value = true
  try {
    const data = await apiFetch<{ markets: AdminMarket[]; nextCursor: string | null }>(
      `/admin/prediction/markets?${query(nextCursor.value)}`,
    )
    markets.value = [...markets.value, ...data.markets]
    nextCursor.value = data.nextCursor
  } catch (err: any) {
    toast.add({ title: 'Could not load more', description: err?.data?.error ?? '', color: 'error' })
  } finally {
    loadingMore.value = false
  }
}

watch(selectedStatus, load)
onMounted(load)

// ── Summary ─────────────────────────────────────────────────────────────────

const countBy = (status: string) => markets.value.filter((market) => market.status === status).length

/**
 * Escrow across the whole board — player money the book is currently holding
 * against matched pairs. Summed exactly, in minor units.
 */
const totalEscrow = computed(() => sumMoney(markets.value.map((market) => market.totalVolume)))

// ── Publish ─────────────────────────────────────────────────────────────────

const publishTarget = ref<AdminMarket | null>(null)

/**
 * The price band is derived from the market's own share value, so the confirm
 * dialog states the real rule rather than the 1–99 that only happens to be true
 * at the default denomination.
 */
const publishBand = computed(() => {
  if (!publishTarget.value) return null
  try {
    const share = toWholeBirr(publishTarget.value.shareValue)
    return { share, max: share - 1 }
  } catch {
    return null
  }
})

async function publish() {
  const market = publishTarget.value
  if (!market) return
  publishing.value = market.id
  try {
    await apiFetch(`/admin/prediction/markets/${market.id}/publish`, { method: 'POST' })
    toast.add({ title: 'Market published', description: market.question, color: 'success' })
    publishTarget.value = null
    await load()
  } catch (err: any) {
    toast.add({
      title: 'Could not publish',
      description: err?.data?.error ?? 'Publish failed',
      color: 'error',
    })
  } finally {
    publishing.value = null
  }
}
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-2xl font-bold text-white tracking-tight">Prediction Markets</h1>
        <p class="text-sm text-white/50 mt-0.5 font-medium">
          Binary order book — players trade against each other, the house never takes a position.
        </p>
      </div>
      <UButton icon="i-heroicons:plus" color="primary" to="/predictions/new">New market</UButton>
    </div>

    <!-- Filter + refresh -->
    <div class="flex gap-2 flex-wrap">
      <USelect v-model="selectedStatus" :items="statusOptions" value-key="value" class="w-48" />
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-heroicons:arrow-path"
        :loading="loading"
        @click="load"
      >
        Refresh
      </UButton>
    </div>

    <!-- Summary -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <div class="rounded-2xl border border-(--surface-border) p-5 text-center shadow-lg" style="background:var(--surface-raised);">
        <div class="text-2xl font-bold text-white tracking-tight">{{ markets.length }}</div>
        <div class="text-xs text-white/40 mt-1 uppercase tracking-widest font-bold">Loaded</div>
      </div>
      <div class="rounded-2xl border border-(--surface-border) p-5 text-center shadow-lg" style="background:var(--surface-raised);">
        <div class="text-2xl font-bold text-zinc-300 tracking-tight">{{ countBy('DRAFT') }}</div>
        <div class="text-xs text-white/40 mt-1 uppercase tracking-widest font-bold">Unpublished</div>
      </div>
      <div class="rounded-2xl border border-(--surface-border) p-5 text-center shadow-lg" style="background:var(--surface-raised);">
        <div class="text-2xl font-bold text-emerald-400 tracking-tight">{{ countBy('OPEN') }}</div>
        <div class="text-xs text-white/40 mt-1 uppercase tracking-widest font-bold">Books Open</div>
      </div>
      <div class="rounded-2xl border border-(--surface-border) p-5 text-center shadow-lg" style="background:var(--surface-raised);">
        <div class="text-2xl font-bold text-yellow-500 tracking-tight tabular-nums">{{ money(totalEscrow) }}</div>
        <div class="text-xs text-white/40 mt-1 uppercase tracking-widest font-bold">ETB Escrowed</div>
      </div>
    </div>

    <!-- Table -->
    <div class="rounded-2xl border border-(--surface-border) overflow-hidden shadow-xl" style="background:var(--surface-raised);">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="border-b border-(--surface-border)" style="background:var(--surface-overlay);">
            <tr>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Market</th>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Status</th>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Prices</th>
              <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Shares</th>
              <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Escrow</th>
              <th class="text-left px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Closes</th>
              <th class="text-right px-4 py-3 text-white/50 font-semibold text-xs uppercase tracking-wide">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-white/5">
            <tr v-if="loading">
              <td colspan="7" class="px-4 py-12 text-center text-zinc-500">
                <div class="flex justify-center">
                  <UIcon name="i-heroicons:arrow-path" class="w-5 h-5 animate-spin" />
                </div>
              </td>
            </tr>
            <tr v-else-if="!markets.length">
              <td colspan="7" class="px-4 py-12 text-center text-zinc-600">
                <UIcon name="i-heroicons:scale" class="w-10 h-10 mx-auto mb-2 opacity-30" />
                <p>No markets in this status</p>
              </td>
            </tr>
            <tr
              v-for="market in markets"
              :key="market.id"
              class="hover:bg-white/3 transition-colors cursor-pointer"
              @click="navigateTo(`/predictions/${market.id}`)"
            >
              <td class="px-4 py-3 max-w-xs">
                <div class="font-medium text-zinc-200 truncate">{{ market.question }}</div>
                <div class="text-[11px] text-white/35 truncate">{{ market.eventName }}</div>
              </td>
              <td class="px-4 py-3">
                <UBadge :color="statusColor(market.status)" variant="soft" size="xs">
                  {{ market.status }}
                </UBadge>
              </td>
              <td class="px-4 py-3">
                <!-- Last traded price per side. Birr and percent are the same
                     number at a 100 ETB share; showing both makes that legible. -->
                <div class="space-y-0.5">
                  <div
                    v-for="side in [0, 1]"
                    :key="side"
                    class="flex items-center gap-2 text-xs"
                  >
                    <span class="text-white/45 truncate max-w-28">
                      {{ outcomeAt(market, side)?.label ?? '—' }}
                    </span>
                    <span
                      v-if="outcomeAt(market, side)?.lastPrice"
                      class="font-bold text-white tabular-nums"
                    >
                      {{ money(outcomeAt(market, side)!.lastPrice, 0) }}
                      <span class="text-white/40 font-medium">
                        ETB ({{ pricePct(outcomeAt(market, side)!.lastPrice, market.shareValue) }}%)
                      </span>
                    </span>
                    <span v-else class="text-white/25">no trades</span>
                  </div>
                </div>
              </td>
              <td class="px-4 py-3 text-right text-zinc-300 tabular-nums">
                {{ market.totalShares.toLocaleString() }}
              </td>
              <td class="px-4 py-3 text-right tabular-nums font-medium text-yellow-500">
                {{ money(market.totalVolume) }}
              </td>
              <td class="px-4 py-3 text-white/40 text-xs font-medium whitespace-nowrap">
                {{ when(market.closesAt) }}
              </td>
              <td class="px-4 py-3 text-right" @click.stop>
                <div class="flex gap-2 justify-end">
                  <UButton
                    v-if="market.status === 'DRAFT'"
                    size="xs"
                    color="success"
                    variant="soft"
                    icon="i-heroicons:megaphone"
                    :loading="publishing === market.id"
                    @click="publishTarget = market"
                  >
                    Publish
                  </UButton>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-heroicons:arrow-top-right-on-square"
                    :to="`/predictions/${market.id}`"
                  >
                    Open
                  </UButton>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="nextCursor" class="border-t border-(--surface-border) p-3 text-center">
        <UButton color="neutral" variant="ghost" :loading="loadingMore" @click="loadMore">
          Load more
        </UButton>
      </div>
    </div>

    <!-- Publish confirmation. Opening a book is the point at which the terms
         freeze and real money starts being escrowed against them. -->
    <UModal
      :open="!!publishTarget"
      title="Publish market"
      :ui="{ footer: 'justify-end' }"
      @update:open="(value: boolean) => { if (!value) publishTarget = null }"
    >
      <template #body>
        <div v-if="publishTarget" class="space-y-4">
          <div>
            <div class="text-base font-semibold text-white">{{ publishTarget.question }}</div>
            <div class="text-xs text-white/40 mt-0.5">{{ publishTarget.eventName }}</div>
          </div>

          <dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div>
              <dt class="text-xs text-white/40 uppercase tracking-wide">Outcomes</dt>
              <dd class="text-zinc-200">
                {{ publishTarget.outcomes.map((outcome) => outcome.label).join('  vs  ') }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-white/40 uppercase tracking-wide">Closes</dt>
              <dd class="text-zinc-200">{{ when(publishTarget.closesAt) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-white/40 uppercase tracking-wide">Share value</dt>
              <dd class="text-zinc-200 tabular-nums">{{ money(publishTarget.shareValue) }} ETB</dd>
            </div>
            <div>
              <dt class="text-xs text-white/40 uppercase tracking-wide">Fee</dt>
              <dd class="text-zinc-200 tabular-nums">{{ money(publishTarget.feePct) }}% of profit</dd>
            </div>
          </dl>

          <UAlert color="warning" variant="subtle" icon="i-heroicons:lock-closed">
            <template #description>
              <div class="space-y-1 text-xs">
                <div v-if="publishBand">
                  A share pays <strong>{{ publishBand.share }} ETB</strong> if its outcome wins.
                  Limit prices will run <strong>1 – {{ publishBand.max }} ETB</strong> in 1 ETB ticks,
                  and every matched pair escrows exactly {{ publishBand.share }} ETB.
                </div>
                <div>
                  Once open, the question, share value, fee and outcome labels are frozen — money
                  will be escrowed against them. Only the description, image and a
                  <em>later</em> closing time stay editable.
                </div>
              </div>
            </template>
          </UAlert>
        </div>
      </template>
      <template #footer>
        <UButton color="neutral" variant="ghost" @click="publishTarget = null">Cancel</UButton>
        <UButton color="primary" :loading="!!publishing" @click="publish">Publish market</UButton>
      </template>
    </UModal>
  </div>
</template>
