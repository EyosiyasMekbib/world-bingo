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
  connectInbox,
  setFilter,
  watchThread,
  claim,
  release,
  resolve,
  reply,
} = useSupportInbox()

const draft = ref('')
const listEl = ref<HTMLElement | null>(null)

const FILTERS = ['unassigned', 'mine', 'all', 'resolved'] as const

onMounted(connectInbox)

const scrollToEnd = async () => {
  await nextTick()
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
}
watch(messages, scrollToEnd, { deep: true })

const send = () => {
  if (!draft.value.trim()) return
  reply(draft.value)
  draft.value = ''
}

// Defence in depth. The real fix lives server-side (support.gateway.ts
// rejects an unsafe attachmentUrl before it's ever persisted or broadcast),
// but this renders whatever it's handed, so the same shape check runs again
// here: `<a href>` executes a `javascript:` value on click, in this clerk's
// authenticated admin session. Mirrors isSafeAttachmentUrl in
// apps/api/src/services/support/attachment-url.ts.
const isSafeAttachmentUrl = (url: string): boolean => {
  if (!url) return false
  if (url.startsWith('/uploads/')) return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
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
  <div class="inbox">
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
        @click="watchThread(item.id)"
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
          </span>
        </header>

        <div ref="listEl" class="msgs">
          <article
            v-for="message in messages"
            :key="message.id"
            :class="`msg ${message.senderRole.toLowerCase()}`"
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
                <img :src="message.attachmentUrl" alt="Attachment" referrerpolicy="no-referrer" />
              </a>
              <img
                v-else
                :src="message.attachmentUrl"
                alt="Attachment"
                referrerpolicy="no-referrer"
              />
            </template>
          </article>
        </div>

        <form class="compose" @submit.prevent="send">
          <UInput v-model="draft" placeholder="Reply…" size="sm" class="compose-input" />
          <UButton type="submit" color="primary" size="sm">Send</UButton>
        </form>
      </template>

      <p v-else class="empty">Pick a conversation from the queue.</p>
    </div>

    <!-- Context -->
    <SupportPlayerContext :user-id="active?.userId ?? null" />
  </div>
</template>

<style scoped>
.inbox {
  display: grid;
  grid-template-columns: 18rem 1fr 17rem;
  /* admin-main contributes its own padding above/below this page's content,
     on top of the 52px header — approximate rather than hardcode both, since
     a mismatch just leaves a harmless sliver of outer scroll. */
  height: calc(100vh - 7rem);
  border: 1px solid var(--surface-border);
  border-radius: 12px;
  overflow: hidden;
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
  padding: 0.6rem 0.8rem;
  border-bottom: 1px solid var(--surface-border);
  font-size: 0.8rem;
}
.actions {
  display: flex;
  gap: 0.35rem;
}
.msgs {
  flex: 1;
  overflow-y: auto;
  padding: 0.8rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
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
.compose {
  display: flex;
  gap: 0.4rem;
  padding: 0.6rem 0.8rem;
  border-top: 1px solid var(--surface-border);
}
.compose-input {
  flex: 1;
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
</style>
