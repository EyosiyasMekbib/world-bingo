<script setup lang="ts">
const {
  conversation,
  messages,
  contact,
  showContact,
  error,
  sending,
  loading,
  closeChat,
  reportError,
  send,
  retry,
  escalate,
  uploadAttachment,
} = useSupport()

const draft = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const composeEl = ref<HTMLInputElement | null>(null)

const statusLabel = computed(() => {
  switch (conversation.value?.status) {
    case 'ASSIGNED':
      return `Talking to ${conversation.value.assignedToUsername ?? 'an agent'}`
    case 'RESOLVED':
      return 'Resolved'
    case 'BOT':
      return 'Assistant'
    default:
      return 'Waiting for an agent'
  }
})

// Relabelled rather than disabled outside BOT status. Pressing this is the
// ONLY thing that asks the server whether anyone is online, and so the only
// thing that produces the phone-number fallback when nobody is — disabling it
// on an OPEN or ASSIGNED thread would take away the escape hatch at precisely
// the moment a player needs it.
const escalateLabel = computed(() =>
  conversation.value?.status === 'BOT' ? 'Talk to a person' : 'Reach us another way',
)

// The phone/Telegram values are admin-configured but unvalidated (Task 7
// deliberately deferred format checks), so they're never interpolated
// straight into an href. telHref/telegramHref (useSupport.ts) allowlist the
// characters that are legitimate in each and return null for anything else
// — including a scheme-smuggling value like `javascript:...` — so the
// links below only render when there's a safe href to point at.
const phoneHref = computed(() => (contact.value?.phone ? telHref(contact.value.phone) : null))
const telegramLinkHref = computed(() =>
  contact.value?.telegram ? telegramHref(contact.value.telegram) : null,
)
// A brand that hasn't filled the support settings in answers with three empty
// strings, which is enough to satisfy `contact != null` and paint a heading
// over nothing.
const hasContactChannel = computed(() => hasUsableContactChannel(contact.value))

// ── Scroll pinning ────────────────────────────────────────────────────────
/** Whether the transcript was at the bottom when the last message arrived. */
const pinned = ref(true)
/** Something arrived while the player was reading further up. */
const hasNewBelow = ref(false)

const readPin = () => {
  const el = listEl.value
  if (!el) return true
  return isPinnedToBottom({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  })
}

const scrollToEnd = async () => {
  await nextTick()
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
  hasNewBelow.value = false
}

const onListScroll = () => {
  pinned.value = readPin()
  if (pinned.value) hasNewBelow.value = false
}

// The pin is measured BEFORE the DOM update, which is what the default
// `flush: 'pre'` gives us: the question being asked is "was the player at the
// bottom when this arrived?", and a post-flush reading already includes the
// new bubble's height and would report everyone as scrolled up. No `deep`
// option — `messages.value` is always replaced with a fresh array, so the
// shallow watch already fires, and a deep one walked every message on every
// keystroke-sized change.
watch(messages, () => {
  pinned.value = readPin()
  if (pinned.value) void scrollToEnd()
  else hasNewBelow.value = true
})

/** An attachment finishing (or failing) changes the transcript's height after
 *  the message itself was already laid out, so a list that was pinned when the
 *  bubble arrived is left short by the image's height. A broken image still
 *  reflows, via its alt text — hence `@error` as well as `@load`. */
const onAttachmentSettled = () => {
  if (pinned.value) void scrollToEnd()
}

// ── Mobile keyboard ───────────────────────────────────────────────────────
/**
 * Mirror the visual viewport onto the panel as two custom properties the
 * mobile stylesheet reads.
 *
 * When a phone keyboard opens, the LAYOUT viewport does not change: `100dvh`
 * still measures the full screen, so the sheet keeps its full height and the
 * composer — the one control the player is trying to use — sits behind the
 * keyboard. Only `visualViewport` knows the real visible box.
 * `interactive-widget=resizes-content` in the viewport meta (nuxt.config.ts)
 * handles the same thing on Chromium; it does nothing on iOS Safari, so this
 * is the primary half rather than the backup.
 */
const syncViewport = () => {
  const viewport = window.visualViewport
  const el = panelEl.value
  if (!viewport || !el) return
  el.style.setProperty('--sc-vvh', `${viewport.height}px`)
  el.style.setProperty(
    '--sc-kb',
    `${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`,
  )
}

/** Where focus was before the panel took it, so closing hands it back to the
 *  launcher rather than dropping the keyboard user at the top of the page. */
let focusOrigin: HTMLElement | null = null

onMounted(() => {
  void scrollToEnd()

  focusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null
  // The composer is disabled until the thread lands, and focus() on a disabled
  // input is a no-op — which would leave focus outside the panel and Escape
  // doing nothing. Fall back to the panel itself, which is why it carries
  // tabindex="-1".
  const firstFocus = composeEl.value?.disabled === false ? composeEl.value : panelEl.value
  firstFocus?.focus()

  // Guarded for SSR and for the browsers that predate visualViewport: without
  // it the sheet simply falls back to 100dvh, which is the current behaviour.
  if (typeof window !== 'undefined' && window.visualViewport) {
    syncViewport()
    window.visualViewport.addEventListener('resize', syncViewport)
    window.visualViewport.addEventListener('scroll', syncViewport)
  }
})

onBeforeUnmount(() => {
  if (typeof window !== 'undefined' && window.visualViewport) {
    window.visualViewport.removeEventListener('resize', syncViewport)
    window.visualViewport.removeEventListener('scroll', syncViewport)
  }
  focusOrigin?.focus()
})

// ── Composing ─────────────────────────────────────────────────────────────
const submit = () => {
  if (!draft.value.trim()) return
  // The draft is only cleared once `send` reports an optimistic row exists.
  // Clearing first destroyed the player's text whenever send() bailed on its
  // `!conversation` guard — which is the state a disconnected panel is in.
  // A row that goes straight to `failed` still counts: the text is visible in
  // the transcript with a tap-to-retry, so restoring the draft as well would
  // leave the player holding two copies of the same message.
  if (!send(draft.value)) return
  draft.value = ''
}

const pickFile = () => fileInput.value?.click()

const onFile = async (event: Event) => {
  const file = (event.target as HTMLInputElement).files?.[0]

  // Reset on EVERY exit, including the failures. An unchanged `value` means
  // re-picking the same file fires no `change` event, so after a rejection the
  // player taps the same photo again and nothing at all happens.
  const resetPicker = () => {
    if (fileInput.value) fileInput.value.value = ''
  }

  if (!file) {
    resetPicker()
    return
  }

  // Checked before the upload starts, not after: on a phone connection the
  // upload of an oversized photo runs for minutes before the API rejects it.
  const precheck = attachmentPrecheck(file)
  if (!precheck.ok) {
    reportError({ code: 'SUPPORT_ATTACHMENT_REJECTED', message: precheck.message })
    resetPicker()
    return
  }

  // Captured BEFORE the await. `uploadAttachment` can run for a long time and
  // the player keeps typing during it, so reading `draft.value` afterwards
  // would attach the caption they were writing for their NEXT message — and
  // then blank it.
  const caption = draft.value
  draft.value = ''

  const uploaded = await uploadAttachment(file)
  if (uploaded && send(caption, uploaded.url, uploaded.mimetype)) {
    resetPicker()
    return
  }

  draft.value = caption
  resetPicker()
}
</script>

<template>
  <!-- tabindex="-1" so Escape reaches this element from anywhere inside it.
       Deliberately NOT `aria-modal` and deliberately no focus trap: on desktop
       this panel is non-modal — the page behind it stays scrollable, there is
       no scrim, and the launcher stays clickable — so claiming modality would
       lie to a screen reader about what Tab can reach. -->
  <section
    ref="panelEl"
    class="sc-panel"
    aria-label="Support conversation"
    tabindex="-1"
    @keydown.esc="closeChat"
  >
    <header class="sc-head">
      <div>
        <strong>Support</strong>
        <small>{{ statusLabel }}</small>
      </div>
      <button aria-label="Close support chat" @click="closeChat">✕</button>
    </header>

    <div ref="listEl" class="sc-list" aria-live="polite" @scroll="onListScroll">
      <!-- A transcript that is still loading must not claim to be empty: a
           returning player with twenty messages saw "Send us a message" for
           the length of the round trip. -->
      <div v-if="loading && !messages.length" class="sc-skeleton" aria-hidden="true">
        <span v-for="row in 3" :key="row" class="sc-skeleton-row" />
      </div>

      <p v-else-if="!messages.length" class="sc-empty">
        Send us a message and an agent will reply here.
      </p>

      <article
        v-for="message in messages"
        :key="message.id"
        class="sc-msg"
        :class="[
          `sc-${message.senderRole.toLowerCase()}`,
          message.sendState && `sc-${message.sendState}`,
        ]"
      >
        <!-- Players must be able to tell a bot from a person at a glance. -->
        <span v-if="message.senderRole === 'AI'" class="sc-tag">Assistant</span>
        <span v-else-if="message.senderRole === 'AGENT'" class="sc-tag">Agent</span>

        <!-- Bodies are interpolated as text, never v-html: a support message
             body is attacker-controlled (a player types it). -->
        <p v-if="message.body">{{ message.body }}</p>
        <img
          v-if="message.attachmentUrl"
          :src="message.attachmentUrl"
          alt="Attachment"
          @load="onAttachmentSettled"
          @error="onAttachmentSettled"
        />

        <!-- Never retried automatically: a missing ack does not prove the
             message failed to save, so the resend is the player's call. -->
        <button
          v-if="message.sendState === 'failed'"
          type="button"
          class="sc-retry"
          @click="retry(message)"
        >
          Not sent · tap to retry
        </button>
      </article>
    </div>

    <button v-if="hasNewBelow" type="button" class="sc-jump" @click="scrollToEnd()">
      New messages ↓
    </button>

    <div v-if="showContact && contact && hasContactChannel" class="sc-contact">
      <strong>Need us faster?</strong>
      <a v-if="phoneHref" :href="phoneHref">{{ contact.phone }}</a>
      <a v-if="telegramLinkHref" :href="telegramLinkHref" target="_blank" rel="noopener">
        {{ contact.telegram }}
      </a>
      <small v-if="contact.hours">{{ contact.hours }}</small>
    </div>

    <p v-if="error" class="sc-error" role="alert">{{ error }}</p>

    <footer class="sc-foot">
      <button class="sc-human" @click="escalate">{{ escalateLabel }}</button>
      <form class="sc-compose" @submit.prevent="submit">
        <input
          ref="composeEl"
          v-model="draft"
          placeholder="Type a message…"
          :disabled="sending || !conversation"
        />
        <input ref="fileInput" type="file" accept="image/*" hidden @change="onFile" />
        <button
          type="button"
          :disabled="sending || !conversation"
          aria-label="Attach image"
          @click="pickFile"
        >
          📎
        </button>
        <button type="submit" :disabled="sending || !conversation">Send</button>
      </form>
    </footer>
  </section>
</template>

<style scoped>
.sc-panel {
  position: fixed;
  right: 1rem;
  bottom: 5rem;
  z-index: var(--z-support, 60);
  display: flex;
  flex-direction: column;
  width: min(22rem, calc(100vw - 2rem));
  height: min(30rem, calc(100vh - 8rem));
  border: 1px solid var(--surface-border);
  border-radius: var(--radius-lg, 16px);
  background: var(--surface-raised);
  color: var(--text-primary);
  box-shadow: 0 18px 48px rgb(0 0 0 / 45%);
  /* Kept on purpose. The panel has a radius and a shadow, and dropping the
     clip to let children shrink would let the header, transcript and composer
     paint outside the rounded corners. The `min-height: 0` on each section
     below is what actually makes them shrinkable. */
  overflow: hidden;
}
.sc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 0;
  padding: 0.75rem 0.9rem;
  border-bottom: 1px solid var(--surface-border);
  background: var(--surface-overlay);
}
.sc-head small {
  display: block;
  opacity: 0.65;
  font-size: 0.72rem;
}
.sc-head button {
  display: flex;
  align-items: center;
  justify-content: center;
  /* Tailwind's preflight strips button padding, so the hit area used to be
     the ✕ glyph itself — about 16×19px against a 44px guideline. The negative
     margins match .sc-head's own 0.75rem/0.9rem padding exactly, so the target
     grows into the header instead of making it taller or pushing the glyph in
     off the right edge. */
  min-width: 44px;
  min-height: 44px;
  margin: -0.75rem -0.9rem -0.75rem 0;
  border: none;
  background: none;
  color: inherit;
  font-size: 1rem;
  cursor: pointer;
}
.sc-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.sc-empty {
  margin: auto;
  opacity: 0.6;
  font-size: 0.85rem;
  text-align: center;
}
.sc-skeleton {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.sc-skeleton-row {
  height: 2.25rem;
  border-radius: 0.7rem;
  background: var(--surface-overlay);
  animation: sc-pulse 1.4s ease-in-out infinite;
}
.sc-skeleton-row:nth-child(2) {
  width: 70%;
  align-self: flex-end;
}
.sc-skeleton-row:nth-child(3) {
  width: 85%;
}
@keyframes sc-pulse {
  50% {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .sc-skeleton-row {
    animation: none;
  }
}
.sc-msg {
  max-width: 85%;
  padding: 0.5rem 0.7rem;
  border-radius: 0.7rem;
  background: var(--surface-overlay);
  font-size: 0.88rem;
  overflow-wrap: anywhere;
}
.sc-msg img {
  display: block;
  max-width: 100%;
  /* `contain`, never `cover`: support attachments are receipts and error
     screenshots, and cover crops away exactly the detail the player is trying
     to show. No aspect-ratio either — on a replaced element the specified
     ratio beats the intrinsic one and every non-matching photo gets squashed. */
  max-height: 12rem;
  width: auto;
  object-fit: contain;
  border-radius: 0.4rem;
}
.sc-player {
  align-self: flex-end;
  background: var(--brand-primary);
  color: var(--text-on-brand);
}
.sc-pending {
  opacity: 0.6;
}
.sc-failed {
  background: color-mix(in srgb, var(--status-error) 30%, var(--surface-overlay));
  color: var(--text-primary);
}
.sc-retry {
  display: block;
  margin-top: 0.3rem;
  border: none;
  background: none;
  color: inherit;
  padding: 0;
  font-size: 0.72rem;
  text-decoration: underline;
  cursor: pointer;
}
.sc-system {
  align-self: center;
  background: transparent;
  opacity: 0.7;
  font-size: 0.78rem;
}
.sc-tag {
  display: block;
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.6;
}
.sc-jump {
  align-self: center;
  margin: 0 0 0.4rem;
  padding: 0.3rem 0.8rem;
  border: 1px solid var(--surface-border);
  border-radius: 999px;
  background: var(--surface-overlay);
  color: var(--text-primary);
  font-size: 0.74rem;
  cursor: pointer;
}
.sc-contact {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: baseline;
  min-height: 0;
  /* The `hours` string is admin-typed and length-unlimited, so this strip
     could otherwise grow until it pushed the transcript off the panel. */
  max-height: 4.5rem;
  overflow-y: auto;
  padding: 0.6rem 0.75rem;
  background: color-mix(in srgb, var(--brand-primary) 16%, var(--surface-raised));
  font-size: 0.8rem;
}
.sc-contact a {
  color: var(--brand-primary);
}
.sc-error {
  margin: 0;
  min-height: 0;
  padding: 0.4rem 0.75rem;
  /* Mixed against the brand's own error colour rather than a fixed maroon
     tint: dash5's statusError is a pure red that a hand-picked dark-red
     background clashes with badly, and only the brand knows which red it
     ships. */
  background: color-mix(in srgb, var(--status-error) 22%, var(--surface-raised));
  color: color-mix(in srgb, var(--status-error) 45%, var(--text-primary));
  font-size: 0.78rem;
}
.sc-foot {
  min-height: 0;
  padding: 0.6rem 0.75rem;
  border-top: 1px solid var(--surface-border);
  background: var(--surface-overlay);
}
.sc-human {
  margin-bottom: 0.5rem;
  border: 1px solid var(--surface-border);
  border-radius: 999px;
  background: none;
  color: inherit;
  padding: 0.25rem 0.7rem;
  font-size: 0.75rem;
  cursor: pointer;
}
.sc-compose {
  display: flex;
  gap: 0.4rem;
}
.sc-compose input[type='text'],
.sc-compose input:not([type]) {
  flex: 1;
  min-width: 0;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--surface-border);
  border-radius: 0.5rem;
  background: var(--surface-base);
  color: inherit;
  /* Not inherited. The body font size is 13px under dash5, and Safari
     auto-zooms the whole page when a field under 16px takes focus — which
     leaves the player zoomed in on a panel they then have to pinch back out
     of. `--wb-font-size-base` is set on `body`, not `:root`, so `1rem` here
     is already 16px and `max(1rem, 16px)` would be redundant. */
  font-size: 16px;
}
.sc-compose button {
  /* Without this the 📎 and Send buttons are shrinkable, and at 320px they
     squeeze the text field down to a few characters. */
  flex-shrink: 0;
  border: none;
  border-radius: 0.5rem;
  background: var(--brand-primary);
  color: var(--text-on-brand);
  padding: 0.45rem 0.7rem;
  cursor: pointer;
}

/* Full-screen sheet on phones. The max-height half is not redundant: a
   landscape iPhone SE is 568×320, which clears the 640px width query but has
   less vertical room than the 30rem panel asks for, and the docked panel
   collapsed to a couple of unusable rows. 600px rather than 480px so the
   568-tall case is covered. */
@media (max-width: 640px), (max-height: 600px) {
  .sc-panel {
    inset: 0;
    /* `top: auto` so both declarations below take effect: with top, height and
       bottom all set, CSS drops `bottom` and the sheet stops tracking the
       keyboard. Anchoring the sheet to its bottom edge is what keeps the
       composer above the keyboard rather than behind it. */
    top: auto;
    width: 100%;
    height: var(--sc-vvh, 100dvh);
    bottom: var(--sc-kb, 0px);
    border: none;
    border-radius: 0;
  }
  .sc-compose input[type='text'],
  .sc-compose input:not([type]),
  .sc-compose button {
    /* dash5 ships `inputH: 36px`, so `var(--input-h, 44px)` on its own still
       resolves under the 44px minimum on that brand. */
    min-height: max(var(--input-h, 44px), 44px);
  }
  /* Height alone left the attach button 38px wide — a target has two
     dimensions, and this one sits in the bottom corner where thumb accuracy
     is worst. */
  .sc-compose button {
    min-width: max(var(--control-h, 44px), 44px);
  }
  /* "Talk to a person" is the escape hatch for a player nobody has answered.
     At 24px it was the smallest target in the panel and the one that matters
     most when the chat is not working. */
  .sc-human {
    min-height: max(var(--control-h, 44px), 44px);
    padding-inline: 1rem;
  }
}
</style>
