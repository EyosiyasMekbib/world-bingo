<script setup lang="ts">
/**
 * Six single digit boxes for a deposit code.
 *
 * Six real inputs rather than one wide one because the agent is copying digits
 * off a customer's phone one at a time and needs to see where they are. The
 * cost of that is every keyboard behaviour has to be put back by hand:
 * advancing, backspacing into the previous box, arrow keys, and pasting a whole
 * code into any box.
 */

const props = defineProps<{
  modelValue: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  complete: [value: string]
}>()

const LENGTH = 6

const inputs = ref<HTMLInputElement[]>([])

const setInputRef = (el: unknown, index: number) => {
  if (el instanceof HTMLInputElement) inputs.value[index] = el
}

const digits = computed(() => {
  const value = (props.modelValue || '').replace(/\D/g, '').slice(0, LENGTH)
  return Array.from({ length: LENGTH }, (_, i) => value[i] ?? '')
})

const commit = (next: string[]) => {
  const value = next.join('')
  emit('update:modelValue', value)
  if (value.length === LENGTH) emit('complete', value)
}

const focusBox = (index: number) => {
  const target = inputs.value[Math.min(Math.max(index, 0), LENGTH - 1)]
  target?.focus()
  target?.select()
}

const handleInput = (event: Event, index: number) => {
  const el = event.target as HTMLInputElement
  const typed = el.value.replace(/\D/g, '')

  if (!typed) {
    // A non digit was typed, or the box was cleared. Either way the box
    // shows what the model says, not what the keyboard left behind.
    const next = [...digits.value]
    next[index] = ''
    el.value = ''
    commit(next)
    return
  }

  const next = [...digits.value]
  // Typing several digits fast can land more than one character in a box.
  // Spread them forward instead of dropping all but the first.
  for (let offset = 0; offset < typed.length && index + offset < LENGTH; offset += 1) {
    next[index + offset] = typed[offset]
  }
  el.value = next[index]
  commit(next)

  const landed = Math.min(index + typed.length, LENGTH - 1)
  nextTick(() => focusBox(landed))
}

const handleKeydown = (event: KeyboardEvent, index: number) => {
  if (event.key === 'Backspace') {
    const next = [...digits.value]
    if (next[index]) {
      next[index] = ''
      commit(next)
      return
    }
    // Empty box: step back, clear the digit that is actually there. Without
    // this the agent presses backspace and nothing appears to happen.
    event.preventDefault()
    if (index === 0) return
    next[index - 1] = ''
    commit(next)
    nextTick(() => focusBox(index - 1))
    return
  }

  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    focusBox(index - 1)
    return
  }

  if (event.key === 'ArrowRight') {
    event.preventDefault()
    focusBox(index + 1)
    return
  }

  if (event.key === 'Delete') {
    const next = [...digits.value]
    next[index] = ''
    commit(next)
  }
}

const handlePaste = (event: ClipboardEvent, index: number) => {
  const text = event.clipboardData?.getData('text') ?? ''
  const pasted = text.replace(/\D/g, '')
  if (!pasted) return

  event.preventDefault()

  // A whole code pasted anywhere fills from the start, which is what someone
  // copying "482913" out of a chat actually means. A shorter run fills from
  // the box they pasted into.
  const start = pasted.length >= LENGTH ? 0 : index
  const next = [...digits.value]
  for (let offset = 0; offset < pasted.length && start + offset < LENGTH; offset += 1) {
    next[start + offset] = pasted[offset]
  }
  commit(next)
  nextTick(() => focusBox(Math.min(start + pasted.length, LENGTH - 1)))
}

const focusFirst = () => focusBox(0)

defineExpose({ focusFirst })
</script>

<template>
  <fieldset class="code-fieldset" :disabled="disabled">
    <legend class="code-legend">Deposit code</legend>
    <div class="code-boxes">
      <input
        v-for="(digit, index) in digits"
        :key="index"
        :ref="(el) => setInputRef(el, index)"
        :value="digit"
        type="text"
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="1"
        class="code-box"
        :aria-label="`Deposit code digit ${index + 1} of 6`"
        @input="handleInput($event, index)"
        @keydown="handleKeydown($event, index)"
        @paste="handlePaste($event, index)"
        @focus="($event.target as HTMLInputElement).select()"
      />
    </div>
  </fieldset>
</template>

<style scoped>
.code-fieldset {
  border: none;
  margin: 0;
  padding: 0;
  min-width: 0;
}

.code-legend {
  padding: 0;
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

.code-boxes {
  display: flex;
  gap: 10px;
}

.code-box {
  width: 56px;
  height: 66px;
  padding: 0;
  text-align: center;
  background: var(--surface-overlay);
  border: 1px solid var(--surface-border);
  border-radius: 10px;
  color: var(--text-primary);
  font-family: var(--font-body);
  font-size: 28px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  outline: none;
  -webkit-appearance: none;
  transition:
    border-color 0.14s ease,
    box-shadow 0.14s ease;
}

.code-box:focus {
  border-color: color-mix(in srgb, var(--brand-primary) 55%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand-primary) 13%, transparent);
}

.code-fieldset:disabled .code-box {
  opacity: 0.45;
  cursor: not-allowed;
}

@media (max-width: 480px) {
  .code-boxes {
    gap: 7px;
  }
  .code-box {
    width: 44px;
    height: 56px;
    font-size: 22px;
  }
}
</style>
