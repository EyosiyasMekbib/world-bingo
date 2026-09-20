<script setup lang="ts">
import { NotificationType } from '@world-bingo/shared-types'
import type { Notification } from '@world-bingo/shared-types'
import { useAuthStore } from '~/store/auth'

const auth = useAuthStore()
const { connect } = useSocket()
const { t } = useI18n()

// ── State ──────────────────────────────────────────────────────────────────
const notifications = ref<Notification[]>([])
const isOpen = ref(false)
const loading = ref(false)

const unreadCount = computed(() => notifications.value.filter((n) => !n.isRead).length)

// ── Fetch ──────────────────────────────────────────────────────────────────
// `/user/notifications` answers with UNREAD ONLY (NotificationService.getUnread;
// getRecent exists but no route exposes it), so this panel is an unread queue
// and the footer says so rather than calling what it holds a total.
//
// Through `auth.apiFetch`, not a bare $fetch with a snapshotted header: access
// tokens live 15 minutes, and the bell is mounted for as long as the tab is
// open, so the first refresh would otherwise leave every fetch 401ing silently.
async function fetchNotifications() {
  if (!auth.isAuthenticated) return
  loading.value = true
  try {
    notifications.value = (await auth.apiFetch<Notification[]>('/user/notifications')) ?? []
  } catch {
    // A bell that renders an error is worse than one that renders nothing.
  } finally {
    loading.value = false
  }
}

// ── Mark one as read ───────────────────────────────────────────────────────
async function markRead(notif: Notification) {
  if (notif.isRead) return
  try {
    await auth.apiFetch(`/user/notifications/${notif.id}/read`, { method: 'POST' })
    const idx = notifications.value.findIndex((n) => n.id === notif.id)
    if (idx !== -1) notifications.value[idx] = { ...notif, isRead: true }
  } catch {
    // fail silently
  }
}

// ── Mark all as read ───────────────────────────────────────────────────────
// The rows and the badge both derive from `notifications`, and the endpoint
// behind it answers with unread only — so flipping `isRead` locally left every
// row on screen under a footer that counted none of them. Re-reading is the
// only way the two cannot disagree, and it has to run on the failure path too:
// a POST that never landed must leave the rows the server still holds unread
// where they are, not hide them behind a flag only this tab believes.
async function markAllRead() {
  try {
    await auth.apiFetch('/user/notifications/read-all', { method: 'POST' })
  } catch {
    // Falls through to the refetch instead of reporting: whether the server
    // marked none, some or all of them, the next read is what the panel shows.
  }
  await fetchNotifications()
}

// ── Open / close ───────────────────────────────────────────────────────────
function toggleOpen() {
  isOpen.value = !isOpen.value
  if (isOpen.value) fetchNotifications()
}

const bellRef = ref<HTMLElement | null>(null)
function onClickOutside(e: MouseEvent) {
  if (bellRef.value && !bellRef.value.contains(e.target as Node)) {
    isOpen.value = false
  }
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') isOpen.value = false
}

// ── Icons ──────────────────────────────────────────────────────────────────
/** Tone token plus the strokes drawn in it. Paths only — no `<circle>` or
 *  `<rect>` — so one `v-for` renders every icon in the set. */
type NotifIcon = { tone: string; paths: string[] }

/** A full circle as two 180° arcs, the outline most of these icons sit in. */
const RING = 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18'

/** The bell itself: the button, the empty state and the fallback icon are all
 *  the same drawing, so it lives in one place. */
const BELL = [
  'M18 15.6V11a6 6 0 1 0-12 0v4.6l-1.4 1.7A.8.8 0 0 0 5.2 18.6h13.6a.8.8 0 0 0 .6-1.3Z',
  'M9.5 18.6a2.5 2.5 0 0 0 5 0',
]

const TONE = {
  success: 'var(--status-success)',
  error: 'var(--status-error)',
  warning: 'var(--status-warning)',
  info: 'var(--status-info)',
  accent: 'var(--accent-primary)',
  brand: 'var(--brand-primary)',
  muted: 'var(--text-secondary)',
}

/** Every member of `NotificationType`, exhaustively — the map is typed on the
 *  enum so a type added later fails the build here instead of quietly falling
 *  back to a bell in production. */
const NOTIF_ICONS: Record<NotificationType, NotifIcon> = {
  [NotificationType.DEPOSIT_APPROVED]: {
    tone: TONE.success,
    paths: [RING, 'm8.4 12.2 2.4 2.4 4.8-4.8'],
  },
  [NotificationType.DEPOSIT_REJECTED]: {
    tone: TONE.error,
    paths: [RING, 'm9.2 9.2 5.6 5.6', 'm14.8 9.2-5.6 5.6'],
  },
  [NotificationType.WITHDRAWAL_PROCESSED]: {
    tone: TONE.info,
    paths: ['M4.5 5h15', 'M12 20.5V9', 'm7.6 13.4 4.4-4.4 4.4 4.4'],
  },
  [NotificationType.REFUND_PROCESSED]: {
    tone: TONE.info,
    paths: [RING, 'M15 12H9.2', 'm11.6 9.4-2.4 2.6 2.4 2.6'],
  },
  [NotificationType.CASHBACK_AWARDED]: {
    tone: TONE.accent,
    paths: ['M21 12a9 9 0 1 1-3.5-7.1', 'M21 4v5h-5'],
  },
  [NotificationType.GAME_STARTING]: {
    tone: TONE.brand,
    paths: [RING, 'm10.4 8.6 5 3.4-5 3.4z'],
  },
  [NotificationType.GAME_CANCELLED]: {
    tone: TONE.error,
    paths: [RING, 'M6.6 6.6 17.4 17.4'],
  },
  [NotificationType.GAME_WON]: {
    tone: TONE.brand,
    paths: [
      'M8 4.5h8V9a4 4 0 0 1-8 0Z',
      'M8 5.8H5.6A2.4 2.4 0 0 0 8 8.2',
      'M16 5.8h2.4A2.4 2.4 0 0 1 16 8.2',
      'M12 13v3.4',
      'M8.6 19.4h6.8',
    ],
  },
  [NotificationType.REFERRAL_BONUS]: {
    tone: TONE.brand,
    paths: [
      'M9.4 11.2a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 1 0 0 6.2',
      'M3.8 19.4c0-3 2.5-5.2 5.6-5.2s5.6 2.2 5.6 5.2',
      'M16.4 5.6a3 3 0 0 1 0 5.6',
      'M17.6 14.6c1.9.7 3.2 2.5 3.2 4.8',
    ],
  },
  [NotificationType.TOURNAMENT_STARTING]: {
    tone: TONE.brand,
    paths: ['M6 3.5v17', 'M6 4.8h11l-1.7 3.9 1.7 3.9H6'],
  },
  [NotificationType.TOURNAMENT_WON]: {
    tone: TONE.brand,
    paths: [RING, 'm12 7.6 1.5 3 3.3.5-2.4 2.3.6 3.3-3-1.6-3 1.6.6-3.3-2.4-2.3 3.3-.5z'],
  },
  [NotificationType.TOURNAMENT_ELIMINATED]: {
    tone: TONE.muted,
    paths: [RING, 'M8.4 12h7.2'],
  },
  [NotificationType.CAMPAIGN_MESSAGE]: {
    tone: TONE.info,
    paths: ['M4.5 10.2 14 6.2v9.6l-9.5-4z', 'M7 14.6 8 20h2.6l-.8-4.4', 'M17 9.6a3 3 0 0 1 0 4.8'],
  },
  [NotificationType.PREDICTION_SETTLED]: {
    tone: TONE.success,
    paths: [RING, 'm8.4 12.2 2.4 2.4 4.8-4.8'],
  },
  [NotificationType.PREDICTION_VOIDED]: {
    tone: TONE.info,
    paths: [RING, 'M15 12H9.2', 'm11.6 9.4-2.4 2.6 2.4 2.6'],
  },
  [NotificationType.SUPPORT_REPLY]: {
    tone: TONE.info,
    paths: [
      'M20.5 12.2c0 3.8-3.8 6.9-8.5 6.9-1 0-2-.1-2.9-.4l-4.6 1.8 1.4-3.5a6.6 6.6 0 0 1-2.4-4.8c0-3.8 3.8-6.9 8.5-6.9s8.5 3.1 8.5 6.9Z',
    ],
  },
  [NotificationType.ACCOUNT_STATUS_CHANGED]: {
    tone: TONE.warning,
    paths: [
      'M12 3.5 5.5 6v5.6c0 4 2.7 7.3 6.5 8.4 3.8-1.1 6.5-4.4 6.5-8.4V6z',
      'm9.4 12.2 1.9 1.9 3.4-3.6',
    ],
  },
  [NotificationType.BONUS_GRANTED]: {
    tone: TONE.brand,
    paths: [
      'M3.5 8h17v4h-17z',
      'M5 12v8h14v-8',
      'M12 8V4',
      'M12 8c-2 0-4-1.2-4-2.6S9.5 3 12 4',
      'M12 8c2 0 4-1.2 4-2.6S14.5 3 12 4',
    ],
  },
  [NotificationType.BONUS_EXPIRING]: {
    tone: TONE.error,
    paths: [RING, 'M12 7.6V12l3 2'],
  },
}

const FALLBACK_ICON: NotifIcon = { tone: TONE.muted, paths: BELL }

function notifIcon(type: string): NotifIcon {
  return NOTIF_ICONS[type as NotificationType] ?? FALLBACK_ICON
}

/** Rows carry their icon so the template resolves it once per notification. */
const rows = computed(() =>
  notifications.value.map((notif) => ({ notif, icon: notifIcon(notif.type) })),
)

// ── Format relative time ───────────────────────────────────────────────────
function relativeTime(date: Date | string): string {
  const now = Date.now()
  const then = new Date(date).getTime()
  const diff = Math.floor((now - then) / 1000)
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

// ── The e2e hook ───────────────────────────────────────────────────────────
// A shell mounts a bell in each of its header rows and the stylesheet shows
// exactly one, so two bells live in the DOM at once. The locator in
// e2e/wallet-deposit-withdrawal.spec.ts asserts on a SINGLE element, and a
// second copy of the attribute turns that into a strict-mode violation — so
// the hook follows whichever copy is actually on screen, and which one that is
// stays the stylesheet's business rather than a breakpoint duplicated here.
const buttonRef = ref<HTMLButtonElement | null>(null)
const onScreen = ref(false)
function syncOnScreen() {
  onScreen.value = (buttonRef.value?.getClientRects().length ?? 0) > 0
}

// ── Socket: listen for new notifications ──────────────────────────────────
const onNewNotification = (notif: Notification) => {
  notifications.value = [notif, ...notifications.value]
}

// The socket instance this component bound to. Removal is BY HANDLER
// REFERENCE on this same instance — `socket.off('notification:new')` would
// also unhook the support widget's own handler on that event, which is what
// keeps the support badge counting clerk replies (see composables/useSupport.ts).
let socket: ReturnType<typeof connect> | null = null

onMounted(() => {
  syncOnScreen()
  window.addEventListener('resize', syncOnScreen)
  document.addEventListener('click', onClickOutside)
  document.addEventListener('keydown', onKeydown)

  if (!auth.isAuthenticated) return
  fetchNotifications()

  socket = connect()
  socket?.on('notification:new', onNewNotification)
})

onUnmounted(() => {
  window.removeEventListener('resize', syncOnScreen)
  document.removeEventListener('click', onClickOutside)
  document.removeEventListener('keydown', onKeydown)
  socket?.off('notification:new', onNewNotification)
  socket = null
})
</script>

<template>
  <div ref="bellRef" class="nb">
    <button
      ref="buttonRef"
      type="button"
      class="nb-trigger"
      :data-testid="onScreen ? 'notification-bell' : undefined"
      :aria-label="t('notification.title')"
      aria-haspopup="true"
      :aria-expanded="isOpen"
      @click.stop="toggleOpen"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path v-for="d in BELL" :key="d" :d="d" />
      </svg>
      <span v-if="unreadCount > 0" class="nb-badge">
        {{ unreadCount > 99 ? '99+' : unreadCount }}
      </span>
    </button>

    <Transition name="nb-pop">
      <div v-if="isOpen" class="nb-panel" @click.stop>
        <div class="nb-head">
          <span class="nb-title">{{ t('notification.title') }}</span>
          <button v-if="unreadCount > 0" type="button" class="nb-markall" @click="markAllRead">
            {{ t('notification.markAllReadShort') }}
          </button>
        </div>

        <div class="nb-list">
          <div v-if="loading" class="nb-state">
            <span class="nb-spinner" />
          </div>

          <div v-else-if="rows.length === 0" class="nb-state nb-empty">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path v-for="d in BELL" :key="d" :d="d" />
            </svg>
            <span>{{ t('notification.noUnread') }}</span>
          </div>

          <button
            v-for="row in rows"
            :key="row.notif.id"
            type="button"
            class="nb-row"
            :class="{ 'nb-row--unread': !row.notif.isRead }"
            @click="markRead(row.notif)"
          >
            <span class="nb-ico" :style="{ color: row.icon.tone }">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.9"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path v-for="d in row.icon.paths" :key="d" :d="d" />
              </svg>
            </span>
            <span class="nb-body">
              <span class="nb-row-top">
                <span class="nb-row-title">{{ row.notif.title }}</span>
                <span v-if="!row.notif.isRead" class="nb-dot" />
              </span>
              <!-- data-ph-mask: notification bodies carry reviewer rejection
                   notes, which are free text about a specific player. -->
              <span class="nb-text" data-ph-mask>{{ row.notif.body }}</span>
              <span class="nb-time">{{ relativeTime(row.notif.createdAt) }}</span>
            </span>
          </button>
        </div>

        <!-- The endpoint returns unread only, so a "total" here would be a
             claim about a history this panel never receives. -->
        <div v-if="rows.length > 0" class="nb-foot">
          <span>Unread only · {{ unreadCount }} waiting</span>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.nb {
  position: relative;
  flex: none;
}

/* 44px square: the smallest comfortable tap target, and the size the
   mockup's header bell is drawn at. */
.nb-trigger {
  position: relative;
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 999px;
  background: rgb(255 255 255 / 8%);
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.12s;
}
.nb-trigger:hover {
  background: rgb(255 255 255 / 14%);
}
.nb-trigger svg {
  width: 20px;
  height: 20px;
}

.nb-badge {
  position: absolute;
  top: 1px;
  right: 1px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  /* The ring punches the badge off the bell at any header background. */
  border: 2px solid var(--surface-raised);
  background: var(--status-error);
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
}

.nb-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 330px;
  /* Phone headers put the bell close to the right edge, so the panel gives
     back the gutter instead of pushing the page sideways. */
  max-width: calc(100vw - 20px);
  border: 1px solid var(--surface-border);
  border-radius: 14px;
  background: var(--surface-raised);
  box-shadow: 0 20px 48px rgb(0 0 0 / 60%);
  /* Above the sticky header's own contents — see the z-index scale in
     assets/css/components.css; still under the modal layer. */
  z-index: 70;
  overflow: hidden;
}

.nb-head {
  min-height: 48px;
  padding: 6px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid rgb(255 255 255 / 7%);
}
.nb-title {
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.7px;
  text-transform: uppercase;
  color: var(--text-primary);
}
.nb-markall {
  /* Full 44px of height without stretching the header: the button eats the
     header's own padding rather than adding to it. */
  min-height: 44px;
  margin: -6px -8px -6px 0;
  padding: 0 8px;
  border: none;
  background: none;
  color: var(--brand-primary);
  font-family: var(--font-ui);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.4px;
  cursor: pointer;
}
.nb-markall:hover {
  color: var(--brand-primary-dim);
}

.nb-list {
  max-height: 320px;
  overflow-y: auto;
}

.nb-row {
  width: 100%;
  min-height: 44px;
  padding: 12px 14px;
  display: flex;
  gap: 11px;
  align-items: flex-start;
  text-align: left;
  border: none;
  border-bottom: 1px solid rgb(255 255 255 / 5%);
  background: none;
  cursor: pointer;
  transition: background 0.12s;
}
.nb-row:last-child {
  border-bottom: none;
}
.nb-row:hover {
  background: rgb(255 255 255 / 5%);
}
.nb-row--unread {
  background: color-mix(in srgb, var(--brand-primary) 5%, transparent);
}
.nb-row--unread:hover {
  background: color-mix(in srgb, var(--brand-primary) 9%, transparent);
}

.nb-ico {
  width: 32px;
  height: 32px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  /* Tinted from the icon's own tone, set inline per notification type. */
  background: color-mix(in srgb, currentcolor 15%, transparent);
}
.nb-ico svg {
  width: 16px;
  height: 16px;
}

.nb-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.nb-row-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.nb-row-title {
  font-family: var(--font-ui);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.2px;
  color: var(--text-primary);
}
.nb-dot {
  width: 7px;
  height: 7px;
  flex: none;
  margin-top: 5px;
  border-radius: 999px;
  background: var(--brand-primary);
}
.nb-text {
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-secondary);
  /* Two lines, then an ellipsis: the full body is the notification's own
     business, the panel only has to identify it. */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.nb-time {
  font-size: 12px;
  color: var(--text-secondary);
}

.nb-state {
  min-height: 120px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.nb-empty {
  color: var(--text-secondary);
  font-size: 13px;
}
.nb-empty svg {
  width: 26px;
  height: 26px;
}
.nb-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--brand-primary);
  border-top-color: transparent;
  border-radius: 999px;
  animation: nb-spin 0.7s linear infinite;
}
@keyframes nb-spin {
  to {
    transform: rotate(360deg);
  }
}

.nb-foot {
  padding: 9px 14px;
  border-top: 1px solid rgb(255 255 255 / 7%);
  text-align: center;
  font-size: 12px;
  color: var(--text-secondary);
}

/* The phone header rows are already at their width budget — arada's carries a
   burger, logo, search, balance chip and Deposit button on a 360px screen — so
   the bell keeps its full 44px tap target and gives back the gutter it would
   otherwise add, rather than pushing the row into a horizontal scroll. */
@media (max-width: 480px) {
  .nb {
    margin: 0 -6px;
  }
}

.nb-pop-enter-active,
.nb-pop-leave-active {
  transition:
    opacity 0.14s ease,
    transform 0.14s ease;
  transform-origin: top right;
}
.nb-pop-enter-from,
.nb-pop-leave-to {
  opacity: 0;
  transform: scale(0.96) translateY(-4px);
}
</style>
