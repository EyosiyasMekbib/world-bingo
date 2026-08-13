<script setup lang="ts">
/**
 * Row-based segment builder.
 *
 * A non-technical operator must be able to express "last deposit more than 14
 * days ago AND lifetime deposits over 1000" without ever seeing JSON. Each row is
 * field / operator / value; the value input changes shape with the field type,
 * and the operator list is filtered to what the server will actually accept for
 * that field — the pickers are built from /admin/crm/fields, the same whitelist
 * the compiler validates against, so the UI cannot offer something that 400s.
 *
 * Deliberately NOT in v1: nested condition groups. The rule AST supports them and
 * the server compiles them, but mixing AND and OR in one screen is where builders
 * of this kind become unusable. One group, one connector.
 */

const props = defineProps<{
  modelValue: any
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [any] }>()

const { getCrmFields, countSegmentRules } = useAdminApi()

const fields = ref<Array<any>>([])
const loadingFields = ref(true)

const connector = ref<'AND' | 'OR'>('AND')
const rows = ref<Array<{ field: string; op: string; value: any; value2: any }>>([])

const count = ref<number | null>(null)
const counting = ref(false)
const countError = ref<string | null>(null)

const OPERATOR_LABELS: Record<string, string> = {
  eq: 'is exactly',
  neq: 'is not',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  between: 'is between',
  before: 'is before',
  after: 'is after',
  in_last_days: 'within the last (days)',
  not_in_last_days: 'more than (days) ago',
  is_null: 'is not set',
  is_not_null: 'is set',
}

const NO_VALUE = new Set(['is_null', 'is_not_null'])
const TWO_VALUES = new Set(['between'])

function fieldMeta(key: string) {
  return fields.value.find((f) => f.key === key)
}

/** Day-count operators take a number even though the field is a date. */
function valueIsNumeric(row: { field: string; op: string }) {
  const meta = fieldMeta(row.field)
  if (!meta) return true
  if (row.op === 'in_last_days' || row.op === 'not_in_last_days') return true
  return meta.type !== 'date'
}

onMounted(async () => {
  try {
    const result = await getCrmFields()
    fields.value = result.fields
  } finally {
    loadingFields.value = false
  }
  hydrate(props.modelValue)
})

/** Read an existing rule set into rows. Anything nested is left alone upstream. */
function hydrate(ruleSet: any) {
  const root = ruleSet?.root
  if (!root?.children?.length) {
    rows.value = []
    return
  }
  connector.value = root.op === 'OR' ? 'OR' : 'AND'
  rows.value = root.children
    .filter((c: any) => c.kind === 'cond')
    .map((c: any) => ({
      field: c.field,
      op: c.op,
      value: Array.isArray(c.value) ? c.value[0] : c.value ?? null,
      value2: Array.isArray(c.value) ? c.value[1] : null,
    }))
}

/** A row the operator is still filling in is not an error — it is just not ready. */
function rowIsComplete(r: { field: string; op: string; value: any; value2: any }) {
  if (!r.field || !r.op) return false
  if (NO_VALUE.has(r.op)) return true
  const filled = (v: any) => v !== null && v !== undefined && v !== ''
  return TWO_VALUES.has(r.op) ? filled(r.value) && filled(r.value2) : filled(r.value)
}

function buildRuleSet() {
  const children = rows.value
    .filter(rowIsComplete)
    .map((r) => {
      const leaf: any = { kind: 'cond', field: r.field, op: r.op }
      if (TWO_VALUES.has(r.op)) leaf.value = [r.value, r.value2]
      else if (!NO_VALUE.has(r.op)) leaf.value = r.value
      return leaf
    })

  if (!children.length) return null
  return { version: 1, root: { kind: 'group', op: connector.value, children } }
}

function addRow() {
  const first = fields.value[0]
  rows.value.push({ field: first?.key ?? '', op: first?.operators?.[0] ?? 'gte', value: null, value2: null })
}

function removeRow(index: number) {
  rows.value.splice(index, 1)
}

/** Keep the operator legal when the field changes. */
function onFieldChange(row: { field: string; op: string; value: any; value2: any }) {
  const meta = fieldMeta(row.field)
  if (meta && !meta.operators.includes(row.op)) {
    row.op = meta.operators[0]
    row.value = null
    row.value2 = null
  }
}

let countTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Debounced. Every keystroke in a number box would otherwise be a COUNT over the
 * metrics table.
 */
watch(
  [rows, connector],
  () => {
    const ruleSet = buildRuleSet()
    emit('update:modelValue', ruleSet)

    if (countTimer) clearTimeout(countTimer)
    if (!ruleSet) {
      count.value = null
      countError.value = null
      // No complete condition yet — show the neutral prompt, not an error.
      return
    }
    countTimer = setTimeout(async () => {
      counting.value = true
      countError.value = null
      try {
        const result = await countSegmentRules(ruleSet)
        count.value = result.count
      } catch (err: any) {
        count.value = null
        // Surface the server's precise message — it names the offending row.
        countError.value = err?.data?.error ?? 'Invalid rule'
      } finally {
        counting.value = false
      }
    }, 500)
  },
  { deep: true },
)
</script>

<template>
  <div class="space-y-4">
    <div v-if="loadingFields" class="space-y-2">
      <USkeleton class="h-10 w-full" />
      <USkeleton class="h-10 w-full" />
    </div>

    <template v-else>
      <div v-if="rows.length > 1" class="flex items-center gap-2">
        <span class="text-sm text-(--ui-text-muted)">Match</span>
        <USelect
          v-model="connector"
          :items="[
            { label: 'all of these', value: 'AND' },
            { label: 'any of these', value: 'OR' },
          ]"
          value-key="value"
          size="sm"
          class="w-40"
          :disabled="disabled"
        />
      </div>

      <div v-for="(row, index) in rows" :key="index" class="flex flex-wrap items-center gap-2">
        <USelect
          v-model="row.field"
          :items="fields.map((f) => ({ label: f.label, value: f.key }))"
          value-key="value"
          class="w-full sm:w-56"
          :disabled="disabled"
          @update:model-value="onFieldChange(row)"
        />

        <USelect
          v-model="row.op"
          :items="(fieldMeta(row.field)?.operators ?? []).map((op: string) => ({
            label: OPERATOR_LABELS[op] ?? op,
            value: op,
          }))"
          value-key="value"
          class="w-full sm:w-48"
          :disabled="disabled"
        />

        <template v-if="!NO_VALUE.has(row.op)">
          <UInput
            v-model="row.value"
            :type="valueIsNumeric(row) ? 'number' : 'date'"
            placeholder="Value"
            class="w-full sm:w-36"
            :disabled="disabled"
          />
          <template v-if="TWO_VALUES.has(row.op)">
            <span class="text-sm text-(--ui-text-muted)">and</span>
            <UInput
              v-model="row.value2"
              :type="valueIsNumeric(row) ? 'number' : 'date'"
              placeholder="Value"
              class="w-full sm:w-36"
              :disabled="disabled"
            />
          </template>
        </template>

        <UButton
          v-if="!disabled"
          icon="i-heroicons:x-mark"
          color="neutral"
          variant="ghost"
          size="xs"
          @click="removeRow(index)"
        />
      </div>

      <UButton
        v-if="!disabled"
        icon="i-heroicons:plus"
        label="Add condition"
        variant="subtle"
        color="neutral"
        size="sm"
        @click="addRow"
      />

      <!-- Live count. The number people will act on, so it shows its own state
           rather than silently going stale while a request is in flight. -->
      <div class="flex items-center gap-2 pt-2 border-t border-(--ui-border)">
        <UIcon
          :name="counting ? 'i-heroicons:arrow-path' : 'i-heroicons:users'"
          :class="counting ? 'animate-spin' : ''"
          class="size-4 text-(--ui-text-muted)"
        />
        <span v-if="countError" class="text-sm text-(--ui-error)">{{ countError }}</span>
        <span v-else-if="count !== null" class="text-sm">
          <strong class="tabular-nums">{{ count.toLocaleString() }}</strong>
          {{ count === 1 ? 'player matches' : 'players match' }}
        </span>
        <span v-else class="text-sm text-(--ui-text-muted)">Add a condition to see the count</span>
      </div>
    </template>
  </div>
</template>
