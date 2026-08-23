<script setup lang="ts">
const {
  conversation,
  messages,
  contact,
  showContact,
  error,
  sending,
  closeChat,
  send,
  escalate,
  uploadAttachment,
} = useSupport()

const draft = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

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

const scrollToEnd = async () => {
  await nextTick()
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
}

watch(messages, scrollToEnd, { deep: true })
onMounted(scrollToEnd)

const submit = () => {
  if (!draft.value.trim()) return
  send(draft.value)
  draft.value = ''
}

const pickFile = () => fileInput.value?.click()

const onFile = async (event: Event) => {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  const uploaded = await uploadAttachment(file)
  if (uploaded) send(draft.value, uploaded.url, uploaded.mimetype)
  draft.value = ''
  if (fileInput.value) fileInput.value.value = ''
}
</script>

<template>
  <section class="sc-panel" aria-label="Support conversation">
    <header class="sc-head">
      <div>
        <strong>Support</strong>
        <small>{{ statusLabel }}</small>
      </div>
      <button aria-label="Close support chat" @click="closeChat">✕</button>
    </header>

    <div ref="listEl" class="sc-list">
      <p v-if="!messages.length" class="sc-empty">
        Send us a message and an agent will reply here.
      </p>

      <article
        v-for="message in messages"
        :key="message.id"
        class="sc-msg"
        :class="`sc-${message.senderRole.toLowerCase()}`"
      >
        <!-- Players must be able to tell a bot from a person at a glance. -->
        <span v-if="message.senderRole === 'AI'" class="sc-tag">Assistant</span>
        <span v-else-if="message.senderRole === 'AGENT'" class="sc-tag">Agent</span>

        <!-- Bodies are interpolated as text, never v-html: a support message
             body is attacker-controlled (a player types it). -->
        <p v-if="message.body">{{ message.body }}</p>
        <img v-if="message.attachmentUrl" :src="message.attachmentUrl" alt="Attachment" />
      </article>
    </div>

    <div v-if="showContact && contact" class="sc-contact">
      <strong>Need us faster?</strong>
      <a v-if="phoneHref" :href="phoneHref">{{ contact.phone }}</a>
      <a v-if="telegramLinkHref" :href="telegramLinkHref" target="_blank" rel="noopener">
        {{ contact.telegram }}
      </a>
      <small v-if="contact.hours">{{ contact.hours }}</small>
    </div>

    <p v-if="error" class="sc-error" role="alert">{{ error }}</p>

    <footer class="sc-foot">
      <button class="sc-human" @click="escalate">Talk to a person</button>
      <form class="sc-compose" @submit.prevent="submit">
        <input v-model="draft" placeholder="Type a message…" :disabled="!conversation" />
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
  z-index: 60;
  display: flex;
  flex-direction: column;
  width: min(22rem, calc(100vw - 2rem));
  height: min(30rem, calc(100vh - 8rem));
  border-radius: 0.9rem;
  background: #17181c;
  color: #f4f4f5;
  box-shadow: 0 18px 48px rgb(0 0 0 / 45%);
  overflow: hidden;
}
.sc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 0.9rem;
  background: #202127;
}
.sc-head small {
  display: block;
  opacity: 0.65;
  font-size: 0.72rem;
}
.sc-head button {
  border: none;
  background: none;
  color: inherit;
  font-size: 1rem;
  cursor: pointer;
}
.sc-list {
  flex: 1;
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
.sc-msg {
  max-width: 85%;
  padding: 0.5rem 0.7rem;
  border-radius: 0.7rem;
  background: #26272e;
  font-size: 0.88rem;
  overflow-wrap: anywhere;
}
.sc-msg img {
  max-width: 100%;
  border-radius: 0.4rem;
}
.sc-player {
  align-self: flex-end;
  background: #f59e0b;
  color: #111;
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
.sc-contact {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: baseline;
  padding: 0.6rem 0.75rem;
  background: #2a2118;
  font-size: 0.8rem;
}
.sc-contact a {
  color: #fbbf24;
}
.sc-error {
  margin: 0;
  padding: 0.4rem 0.75rem;
  background: #3b1414;
  color: #fca5a5;
  font-size: 0.78rem;
}
.sc-foot {
  padding: 0.6rem 0.75rem;
  background: #202127;
}
.sc-human {
  margin-bottom: 0.5rem;
  border: 1px solid #3f3f46;
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
  border: 1px solid #3f3f46;
  border-radius: 0.5rem;
  background: #17181c;
  color: inherit;
}
.sc-compose button {
  border: none;
  border-radius: 0.5rem;
  background: #f59e0b;
  color: #111;
  padding: 0.45rem 0.7rem;
  cursor: pointer;
}
</style>
