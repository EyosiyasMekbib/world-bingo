<script setup lang="ts">
// `watchThread`, not `watch` — destructuring a `watch` here would shadow
// Vue's auto-imported `watch()` and silently break every watcher below.
const {
  queue,
  filter,
  active,
  messages,
  unassignedCount,
  error,
  connected,
  connectInbox,
  disconnectInbox,
  setFilter,
  watchThread,
  claim,
  release,
  resolve,
  reply,
} = useSupportInbox()

const draft = ref('')
const sending = ref(false)
const listEl = ref<HTMLElement | null>(null)

// Which of the two panes is showing on a single-column viewport. Ignored by
// the grid above 850px, where both are on screen at once.
const pane = ref<'queue' | 'thread'>('queue')
// The player context is a drawer rather than a third column below 1100px.
const ctxOpen = ref(false)

const FILTERS = ['unassigned', 'mine', 'all', 'resolved'] as const

onMounted(connectInbox)
// The socket, the queue-refresh debounce and the token-refresh interval are
// all owned by the composable and torn down together here. Without this the
// inbox kept polling and kept a socket open behind whatever page the clerk
// navigated to next.
onUnmounted(disconnectInbox)

// Anything closer than this to the bottom counts as "following the
// conversation" — a couple of pixels of rounding, or a half-scrolled last
// line, should not read as the clerk having deliberately scrolled away.
const SCROLL_PIN_SLACK_PX = 48
const pinned = ref(true)

const atBottom = () => {
  const el = listEl.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_PIN_SLACK_PX
}

const onListScroll = () => {
  pinned.value = atBottom()
}

const scrollToEnd = async () => {
  await nextTick()
  const el = listEl.value
  if (el) el.scrollTop = el.scrollHeight
}

// The measurement happens BEFORE the DOM updates: a watcher's default
// flush: 'pre' runs the callback ahead of the re-render, so this reads where
// the clerk was standing when the message arrived rather than where the new
// row has already pushed them. Scrolled up reading what the player said ten
// minutes ago, they used to have the transcript yanked out from under them
// every time the player typed another line.
//
// No `deep: true`: every write to `messages` replaces the array outright, so
// a shallow watch already fires — and the deep one walked the whole transcript
// on every keystroke-length message.
watch(messages, () => {
  pinned.value = atBottom()
  if (pinned.value) void scrollToEnd()
})

// An attachment has no height until it decodes, so the row it sits in grows
// after the watcher above has already run and the last message ends up under
// the fold. Re-scroll on load — and on error too, since a broken image still
// reflows to its alt text. `pinned` is the reading taken before the image
// expanded; re-measuring here would always say "not at the bottom", precisely
// because the image just pushed us off it.
const onAttachmentSettled = () => {
  if (pinned.value) void scrollToEnd()
}

const composerLocked = computed(() => !active.value || active.value.status === 'RESOLVED')
const canSend = computed(() => !composerLocked.value && connected.value)
const sendTitle = computed(() => {
  if (active.value?.status === 'RESOLVED') {
    return 'Resolved conversations are read-only — claim or reopen from the queue first'
  }
  if (!connected.value) return 'Live updates are disconnected — reconnecting before this can send'
  return undefined
})

const send = async () => {
  if (!draft.value.trim() || sending.value || !canSend.value) return
  sending.value = true
  try {
    // The draft stays in the box until the gateway acknowledges the message.
    // Clearing it on emit meant a reply refused by the rate limiter, or lost
    // with a dying socket, was deleted from under the clerk — who found out
    // about it from the player.
    const sent = await reply(draft.value, newClientMsgId())
    if (sent) draft.value = ''
  } finally {
    sending.value = false
  }
}

const openThread = (conversationId: string) => {
  watchThread(conversationId)
  // On a single-column viewport the queue and the thread are tabs, so picking
  // a conversation has to move the clerk to it.
  pane.value = 'thread'
}

// Defence in depth. The real fix lives server-side (support.gateway.ts
// rejects an unsafe attachmentUrl before it's ever persisted or broadcast
// unless its host is on an exact allowlist built from configuration — see
// apps/api/src/services/support/attachment-url.ts), but this renders
// whatever it's handed, so `<a href>` would execute a `javascript:` value
// on click, in this clerk's authenticated admin session.
//
// This client-side copy is deliberately STRICTER than the server, not a
// mirror of it: the server's allowlist is built from env config (MinIO
// endpoint, GCS bucket, SUPPORT_ATTACHMENT_HOSTS) that this page has no way
// to read, so it cannot reproduce that exact-host check. Rather than trust
// "any http(s) URL" here — which is what let a PLAYER-planted phishing link
// render as a bare clickable thumbnail in the first place — only the
// same-origin relative `/uploads/` shape is treated as clickable. Anything
// else (including a legitimate absolute MinIO/GCS URL the server accepted)
// still renders as an inert `<img>`: never inside an `<a href>`. The server
// is the authority on what's safe to persist; being stricter client-side
// costs nothing and can only ever reject something the server allowed, not
// accept something the server would have rejected.
const isSafeAttachmentUrl = (url: string): boolean => {
  if (!url) return false
  return url.startsWith('/uploads/')
}

const threadStatusVariant = (status: string) => {
  switch (status) {
    case 'RESOLVED':
      return 'positive'
    case 'ASSIGNED':
      return 'warning'
    case 'OPEN':
      return 'negative'
    default:
      return 'neutral'
  }
}
</script>

<template>
  <div class="inbox" :data-pane="pane">
    <!-- Pane switch. Only rendered as tabs on a single-column viewport; the
         grid hides it wherever both panes fit side by side. -->
    <div class="tabs">
      <button type="button" class="tab" :class="{ on: pane === 'queue' }" @click="pane = 'queue'">
        Queue
        <span v-if="unassignedCount" class="filter-count">{{ unassignedCount }}</span>
      </button>
      <button type="button" class="tab" :class="{ on: pane === 'thread' }" @click="pane = 'thread'">
        Conversation
      </button>
    </div>

    <!-- Queue -->
    <div class="col queue">
      <div class="filters">
        <UButton
          v-for="f in FILTERS"
          :key="f"
          size="xs"
          :variant="filter === f ? 'solid' : 'ghost'"
          :color="filter === f ? 'primary' : 'neutral'"
          class="filter-btn"
          @click="setFilter(f)"
        >
          <span class="filter-label">{{ f }}</span>
          <span v-if="f === 'unassigned' && unassignedCount" class="filter-count">{{
            unassignedCount
          }}</span>
        </UButton>
      </div>

      <p v-if="!queue.length" class="empty">Nothing here.</p>

      <button
        v-for="item in queue"
        :key="item.id"
        class="row"
        :class="{ on: active?.id === item.id }"
        @click="openThread(item.id)"
      >
        <span class="row-top">
          <strong>{{ item.username }}</strong>
          <em v-if="item.unreadForAgent">{{ item.unreadForAgent }}</em>
        </span>
        <span class="preview">{{ item.lastMessagePreview }}</span>
        <span class="meta">
          {{ item.status }}
          <template v-if="item.assignedToUsername">· {{ item.assignedToUsername }}</template>
        </span>
      </button>
    </div>

    <!-- Thread -->
    <div class="col thread">
      <p v-if="error" class="err" role="alert">{{ error }}</p>

      <template v-if="active">
        <header class="thread-head">
          <span class="status-tag" :class="`status-tag--${threadStatusVariant(active.status)}`">
            {{ active.status }}
          </span>
          <span class="actions">
            <UButton
              size="xs"
              color="primary"
              variant="soft"
              :disabled="active.status !== 'OPEN'"
              @click="claim(active.id)"
            >
              Claim
            </UButton>
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              :disabled="active.status !== 'ASSIGNED'"
              @click="release(active.id)"
            >
              Release
            </UButton>
            <UButton
              size="xs"
              color="success"
              variant="soft"
              :disabled="active.status === 'RESOLVED'"
              @click="resolve(active.id)"
            >
              Resolve
            </UButton>
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              class="ctx-toggle"
              :aria-expanded="ctxOpen"
              @click="ctxOpen = !ctxOpen"
            >
              Player
            </UButton>
          </span>
        </header>

        <div ref="listEl" class="msgs" @scroll.passive="onListScroll">
          <article
            v-for="message in messages"
            :key="message.id"
            :class="[
              `msg ${message.senderRole.toLowerCase()}`,
              { pending: message.pending, failed: message.failed },
            ]"
          >
            <span class="who">{{ message.senderRole }}</span>
            <!-- Interpolated as text, never v-html: a message body is typed by
                 the player and is fully attacker-controlled, and a clerk's
                 browser is authenticated to the admin app. -->
            <p v-if="message.body">{{ message.body }}</p>
            <!-- rel + referrerpolicy: a hostile attachment URL must not be able
                 to learn this admin page's URL or open a same-tab redirect.
                 The server already rejects a `javascript:`/`data:` attachmentUrl
                 before persisting it, but this is the anchor that would execute
                 one on click — only make it clickable when it re-checks safe. -->
            <template v-if="message.attachmentUrl">
              <a
                v-if="isSafeAttachmentUrl(message.attachmentUrl)"
                :href="message.attachmentUrl"
                target="_blank"
                rel="noopener noreferrer"
              >
                <img
                  :src="message.attachmentUrl"
                  alt="Attachment"
                  referrerpolicy="no-referrer"
                  @load="onAttachmentSettled"
                  @error="onAttachmentSettled"
                />
              </a>
              <img
                v-else
                :src="message.attachmentUrl"
                alt="Attachment"
                referrerpolicy="no-referrer"
                @load="onAttachmentSettled"
                @error="onAttachmentSettled"
              />
            </template>
            <span v-if="message.pending" class="msg-state">Sending…</span>
            <span v-else-if="message.failed" class="msg-state failed" role="status">
              Not delivered — it may not have reached the player.
            </span>
          </article>
        </div>

        <form class="compose" @submit.prevent="send">
          <UInput
            v-model="draft"
            placeholder="Reply…"
            size="sm"
            class="compose-input"
            :disabled="composerLocked || sending"
            :title="sendTitle"
          />
          <UButton
            type="submit"
            color="primary"
            size="sm"
            class="compose-send"
            :disabled="!canSend || sending"
            :title="sendTitle"
          >
            Send
          </UButton>
        </form>
        <p v-if="active.status === 'RESOLVED'" class="compose-hint">
          This conversation is resolved, so replying here is disabled. A player message will still
          reopen it automatically.
        </p>
      </template>

      <p v-else class="empty">Pick a conversation from the queue.</p>
    </div>

    <!-- Context. A third column on a wide screen, a drawer below 1100px. -->
    <aside class="ctx-pane" :class="{ open: ctxOpen }">
      <button
        type="button"
        class="ctx-close"
        aria-label="Close player details"
        @click="ctxOpen = false"
      >
        ✕
      </button>
      <SupportPlayerContext :user-id="active?.userId ?? null" />
    </aside>
  </div>
</template>

<style scoped>
.inbox {
  display: grid;
  /* minmax, not fixed tracks: CSS grid does not shrink a fixed track, so
     `18rem 1fr 17rem` resolved the middle column to 0px on anything under
     ~850px — the transcript, the Claim/Release/Resolve row and the reply box
     all rendered at zero width and the inbox was unusable rather than merely
     cramped. */
  grid-template-columns: minmax(12rem, 18rem) minmax(0, 1fr) minmax(13rem, 17rem);
  /* admin-main contributes its own padding above/below this page's content,
     on top of the 52px header — approximate rather than hardcode both, since
     a mismatch just leaves a harmless sliver of outer scroll. */
  height: calc(100vh - 7rem);
  border: 1px solid var(--surface-border);
  border-radius: 12px;
  overflow: hidden;
  /* Anchors the context drawer at the narrow breakpoints. */
  position: relative;
}
/* dvh, where it exists, so a mobile browser's collapsing address bar does not
   park the reply box underneath its own chrome. */
@supports (height: 100dvh) {
  .inbox {
    height: calc(100dvh - 7rem);
  }
}
.col {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.queue {
  border-right: 1px solid var(--surface-border);
  overflow-y: auto;
}
.tabs {
  display: none;
  grid-column: 1 / -1;
  border-bottom: 1px solid var(--surface-border);
}
.tab {
  flex: 1;
  /* Full 44px touch target: this is the only way between the two panes on a
     phone, and the tab strip is the first thing a thumb reaches for. */
  min-height: 44px;
  padding: 0 0.6rem;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-muted);
  font-family: var(--font-ui);
  font-size: 0.78rem;
  text-transform: capitalize;
  cursor: pointer;
}
.tab.on {
  color: var(--text-primary);
  border-bottom-color: var(--brand-primary);
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  padding: 0.6rem;
  border-bottom: 1px solid var(--surface-border);
}
.filter-btn {
  flex: 1;
  justify-content: center;
  text-transform: capitalize;
}
.filter-label {
  font-size: 0.72rem;
}
.filter-count {
  margin-left: 0.3rem;
  padding: 0 0.35rem;
  border-radius: 999px;
  background: var(--negative);
  color: #fff;
  font-size: 0.65rem;
  line-height: 1.4;
}
.row {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  width: 100%;
  padding: 0.6rem 0.7rem;
  border: none;
  border-bottom: 1px solid var(--surface-line);
  background: none;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  font-family: var(--font-body);
}
.row:hover {
  background: rgba(255, 255, 255, 0.03);
}
.row.on {
  background: var(--brand-glow);
}
.row-top {
  display: flex;
  justify-content: space-between;
}
.row-top em {
  font-style: normal;
  background: var(--negative);
  color: #fff;
  border-radius: 999px;
  padding: 0 0.35rem;
  font-size: 0.68rem;
}
.preview,
.meta {
  font-size: 0.75rem;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.thread-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* Wraps rather than pushing the action buttons off the right edge once the
     thread column is only a few hundred pixels wide. */
  flex-wrap: wrap;
  gap: 0.4rem;
  padding: 0.6rem 0.8rem;
  border-bottom: 1px solid var(--surface-border);
  font-size: 0.8rem;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.ctx-toggle {
  display: none;
}
.msgs {
  flex: 1;
  overflow-y: auto;
  padding: 0.8rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  /* min-height: 0 so this is what scrolls, rather than the flex column growing
     past the pane and taking the compose row with it. */
  min-height: 0;
}
.msg {
  max-width: 70%;
  padding: 0.45rem 0.65rem;
  border-radius: 0.6rem;
  background: var(--surface-raised);
  border: 1px solid var(--surface-line);
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
.msg.agent {
  align-self: flex-end;
  background: var(--brand-glow);
  border-color: rgba(245, 166, 35, 0.28);
}
/* Escalation acknowledgements ("Talk to a person") are written by the server,
   not by either party. Centred and quiet so a clerk scanning the transcript
   reads them as a marker in the conversation rather than as a message someone
   sent — matching how the player's own panel renders them. */
.msg.system {
  align-self: center;
  max-width: 85%;
  background: none;
  border: none;
  text-align: center;
  font-size: 0.78rem;
  color: var(--text-muted);
}
.msg.pending {
  opacity: 0.6;
}
.msg.failed {
  border-color: var(--negative);
}
.msg .who {
  display: block;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.msg p {
  margin: 0.15rem 0 0;
  color: var(--text-primary);
}
.msg img {
  max-width: 100%;
  border-radius: 0.35rem;
  margin-top: 0.3rem;
}
.msg-state {
  display: block;
  margin-top: 0.2rem;
  font-size: 0.68rem;
  color: var(--text-muted);
}
.msg-state.failed {
  color: var(--negative);
}
.compose {
  display: flex;
  gap: 0.4rem;
  padding: 0.6rem 0.8rem;
  border-top: 1px solid var(--surface-border);
}
.compose-input {
  flex: 1;
  min-width: 0;
}
.compose-send {
  flex-shrink: 0;
}
.compose-hint {
  margin: 0;
  padding: 0 0.8rem 0.6rem;
  color: var(--text-muted);
  font-size: 0.72rem;
}
.empty {
  margin: auto;
  color: var(--text-muted);
  font-size: 0.85rem;
}
.err {
  margin: 0;
  padding: 0.4rem 0.8rem;
  background: var(--negative-bg);
  color: var(--negative);
  font-size: 0.8rem;
}
.ctx-pane {
  display: flex;
  min-width: 0;
  min-height: 0;
}
.ctx-close {
  display: none;
}

/* Below three columns' worth of room, the player context stops being a column
   and becomes a drawer over the thread. It is the pane a clerk consults rather
   than works in, so it is the one that gives up its space first. */
@media (max-width: 1100px) {
  .inbox {
    grid-template-columns: minmax(11rem, 16rem) minmax(0, 1fr);
  }
  .ctx-pane {
    position: absolute;
    inset: 0 0 0 auto;
    width: min(20rem, 88%);
    z-index: 2;
    background: var(--surface-raised);
    box-shadow: -10px 0 28px rgba(0, 0, 0, 0.35);
    transform: translateX(101%);
    transition: transform 0.18s ease;
  }
  .ctx-pane.open {
    transform: translateX(0);
  }
  .ctx-toggle,
  .ctx-close {
    display: inline-flex;
  }
  .ctx-close {
    position: absolute;
    top: 0.35rem;
    right: 0.35rem;
    z-index: 1;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border: none;
    background: none;
    color: var(--text-muted);
    font-size: 1rem;
    cursor: pointer;
  }
}
@media (prefers-reduced-motion: reduce) {
  .ctx-pane {
    transition: none;
  }
}

/* One column: the queue and the thread become tabs. Two 12rem side tracks and
   a usable transcript do not fit on a phone, and a squeezed three-up is worse
   than a clean one-up. */
@media (max-width: 850px) {
  .inbox {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
  }
  .tabs {
    display: flex;
  }
  .queue,
  .thread {
    display: none;
    border-right: none;
  }
  .inbox[data-pane='queue'] .queue {
    display: flex;
  }
  .inbox[data-pane='thread'] .thread {
    display: flex;
  }
  .ctx-pane {
    width: min(22rem, 92%);
  }
  .msg {
    max-width: 88%;
  }
}
</style>
