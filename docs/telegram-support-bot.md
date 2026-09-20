# Telegram Support Bot and Self-Serve Account Actions - Design Spec

> **Scope:** a per-brand Telegram bot that (1) carries support conversations for
> players and staff and (2) delivers the notifications the platform already
> generates, plus the self-serve account actions that ride on it.
> **Not in scope:** Telegram as a login method, deposits or withdrawals in chat,
> language switching in the bot, play inside Telegram.
> **Golden rule:** Telegram is a *channel attached to a phone account*, never an
> identity. Nothing in this spec lets a Telegram account sign in, and nothing
> moves money.

---

## 1. Why

Nobody uses the Telegram login widget; every real account is phone + password.
The gaps that send players to a human today are:

- **No push channel.** Notifications are in-app rows only. A player whose deposit is
  approved finds out when they reopen the app, so they message support instead.
- **Forgot password is support-only.** Phone registration has no OTP and there is no
  SMS provider in the API.
- **"Contact support" is a phone number.** When no clerk holds a support socket, the
  widget prints an admin-configured phone and Telegram handle and stops.
- **Staff answer only from the admin inbox.** Clerks are on Telegram all day; the inbox
  is a browser tab they forget.

Telegram's *share my contact* button hands the bot the phone number Telegram itself
verified by SMS. That gives us SMS-verified identity without an SMS provider, which is
what makes password recovery self-serve for phone-only accounts.

## 2. Decisions (locked)

| # | Decision | Consequence |
|---|---|---|
| D1 | Bot is support + notifications only | No `/deposit`, `/withdraw`, no money prompts of any kind |
| D2 | Linking does **not** enable Telegram sign-in | New `telegramChatId` column; the widget's `telegramId` is never written by the bot |
| D3 | No language switching in the bot | Bot copy is English; notification title/body are forwarded as generated |
| D4 | One bot and one staff group per brand | Uses the existing per-deployment `TELEGRAM_BOT_TOKEN`; hub/spoke is not involved |
| D5 | Staff group uses forum topics | One topic per conversation; needs a supergroup with Topics on and the bot as admin |
| D6 | Players see "Support", not the clerk's name | Same as the web widget today |
| D7 | Env-gated, no-op when unset | With no token the API boots and behaves exactly as before |
| D8 | Everything reuses the existing services | `SupportService`, `NotificationService`, `AuthService`; the bot is a second front-end, never a second write path |

Defaults taken where nothing was decided: appeal flow for restricted accounts is in
(Section 6.4); the AI first line is out (Section 10, phase 4, optional).

## 3. Data model

### 3.1 `users`

| Column | Type | Meaning |
|---|---|---|
| `telegramChatId` | `String? @unique` | Telegram user id of the linked account. Equals the private-chat id, so it is both the address for pushes and the value matched against `from.id` in the staff group. Distinct from `telegramId` (login widget). |
| `telegramLinkedAt` | `DateTime?` | When the link was made. |
| `telegramNotifyEnabled` | `Boolean @default(true)` | Player opt-out for notification pushes. Support replies are never gated by this. |
| `telegramBlockedAt` | `DateTime?` | Set when Telegram answers 403 "bot was blocked by the user". Cleared on the next `/start`. |

`@unique` on `telegramChatId` enforces one Telegram per account **and** one account per
Telegram at the database level. Concurrent link attempts fail loudly instead of
producing two accounts on one chat.

### 3.2 `support_conversations`

| Column | Type | Meaning |
|---|---|---|
| `telegramTopicId` | `Int?` | Forum topic id in the staff group. Null until the first staff-side post. |

The partial unique index `support_conversations_one_live_per_user` must be re-added by
hand in the migration that adds this column (see the model comment in `schema.prisma`).

### 3.3 `support_messages`

| Column | Type | Meaning |
|---|---|---|
| `source` | `SupportMessageSource @default(WEB)` | `WEB` or `TELEGRAM`. Where the *sender* typed it. Shown in the admin inbox and the staff topic. |

### 3.4 Redis (no migration)

| Key | Value | TTL | Purpose |
|---|---|---|---|
| `tg:link:<token>` | `{ kind: 'player' \| 'staff', userId, conversationId? }` | 10 min, single use (`GETDEL`) | Deep-link token from the app |
| `tg:pwreset:<token>` | `{ userId }` | 10 min, single use | One-time set-password link |
| `tg:update:<update_id>` | `1` | 24 h | Webhook idempotency |
| `tg:onshift` | sorted set, member = staff userId, score = expiry epoch | - | Telegram staff presence |
| `tg:guest:<telegramUserId>` | counter | 1 min | Rate limit for unlinked chats |

## 4. Components and file map

Everything lives in the API and the two Nuxt apps. No fourth app.

```
apps/api/src/
  gateways/telegram/
    bot.ts                 grammY instance, env gate, setWebhook on boot
    client.ts              thin wrapper: sendMessage/sendPhoto/forum topic calls, error mapping
    config.ts              reads TELEGRAM_* env, exports isEnabled()/isStaffBridgeEnabled()
  routes/telegram/
    webhook.ts             POST /v1/telegram/webhook (secret header check, update dedupe)
  services/telegram/
    link.service.ts        deep-link tokens, shared-contact matching, unlink
    phone.ts               Ethiopian phone normaliser + candidate raw forms
    player-handlers.ts     /start, /help, /status, /password, /logout, /notifications, /stop, free text, photos
    staff-handlers.ts      group guard, topic <-> conversation mapping, /assign /release /resolve /note /queue /onshift /offshift
    shift.service.ts       tg:onshift reads/writes
    notify.ts              notification -> Telegram text + deep-link button
  services/support/
    fanout.ts              NEW: post-commit effects shared by socket gateway and bot (room emit, queue broadcast, topic post, player push)
    support.service.ts     addMessage gains `source`; conversation gains topic id
  services/auth.service.ts issuePasswordResetLink(), consumePasswordResetToken(), revokeAllSessions()
  workers/telegram-send.worker.ts   BullMQ queue `telegram-send`
  lib/queue.ts             register the new queue
  test/telegram-*.test.ts

packages/shared-types/src/
  entities/support.ts      SupportMessageSource, `source` on SupportMessage, `telegramLink?` on contact fallback
  api/index.ts             link/unlink/notify DTOs, password-reset-consume DTO

apps/web/
  components/support/SupportPanel.vue   "Continue on Telegram" in the contact fallback
  composables/useSupport.ts             handles telegramLink in support:contact-fallback
  pages/profile.vue                     Connect / Disconnect Telegram row, notifications toggle
  pages/auth/login.vue                  forgot-password box links to the bot
  pages/auth/set-password.vue           NEW: consumes tg:pwreset token

apps/admin/
  pages/support.vue                     source badge on messages; "Link my Telegram" action
  pages/settings/*                      shows whether the staff bridge is configured

docs/telegram-support-bot.md            this file
apps/api/.env.example, .env.example     new TELEGRAM_* vars
```

Route prefixes follow `src/index.ts`: player endpoints under `/support` and `/user`,
staff link under `/admin/support`, webhook under `/v1/telegram` beside the other
external callbacks.

## 5. Player flows

### 5.1 Linking from the app (primary path)

The player is already signed in on the phone that has Telegram. No password, no widget.

1. App calls `POST /support/telegram/link` (authenticated, active-account gate not
   required: a suspended player must still reach support). Optional body
   `{ conversationId }` when called from the support panel.
2. API writes `tg:link:<token>` and returns `https://t.me/<NUXT_PUBLIC_TELEGRAM_BOT_NAME>?start=<token>`.
   Token is 32 random bytes, base64url, which fits Telegram's 64-char start payload.
3. Player taps, Telegram opens the bot, sends `/start <token>`.
4. Bot `GETDEL`s the token. If found and `kind = player`: set `telegramChatId = from.id`,
   `telegramLinkedAt = now`, clear `telegramBlockedAt`. Reply: "Linked. You'll get your
   notifications and support replies here."
5. If the token carried a `conversationId`, the bot posts the last five messages of that
   thread so the player can carry on where they were.

Conflicts (Section 7.2) are checked before the write.

Entry points in the web app:

- **Support panel contact fallback.** `support:contact-fallback` gains `telegramLink`.
  The panel renders "Continue on Telegram" above the phone number. The gateway mints the
  token server-side when it emits the fallback, so the panel never calls the link route
  itself.
- **Profile page.** "Connect Telegram" row showing linked / not linked, with disconnect
  and a notifications toggle (`PATCH /user/telegram { notifyEnabled }`,
  `DELETE /user/telegram`). `GET /auth/me` gains `telegramLinked` and
  `telegramNotifyEnabled`.
- **Login page, forgot password.** The box links to `https://t.me/<bot>?start=forgot`
  (public payload, no token). The bot then runs the shared-contact flow (5.2).
- **Registration.** No prompt. Linking is offered at the moments a player wants
  something from us, not at signup.

The admin-configured `support_telegram` handle keeps working as a fallback for players
who will not link.

### 5.2 Linking by shared contact (logged-out path)

Used when the player reaches the bot without a token: cold `/start`, or `start=forgot`.

1. Bot replies with a one-button reply keyboard: "Share my phone number"
   (`request_contact: true`). Plain text is answered with the same prompt; nothing is
   written.
2. On a `contact` message the bot requires `contact.user_id === from.id`. A forwarded or
   hand-typed contact belonging to someone else is rejected with "Please share your own
   number".
3. `phone.ts` normalises `contact.phone_number` (Telegram sends E.164 without `+`) and
   builds the raw forms a player may have typed at registration:
   `0912345678`, `912345678`, `251912345678`, `+251912345678`. Query
   `users WHERE role = PLAYER AND phone IN (...)`.
4. Exactly one match: apply the conflict rules, link, and continue with whatever the
   player came for (`forgot` continues into 5.5).
5. No match: "No account uses this number." with a button to the registration page and
   the support phone from `SupportContact`. Nothing is written.
6. More than one match (data quality, not expected): treat as no match and log a warning
   with the two user ids. Staff resolve it in the admin app.

Telegram verified the number by SMS when the account was created, so a shared contact
is the same trust level as an SMS OTP. This is the trust that makes 5.5 acceptable.

### 5.3 Support conversation through the bot

Any non-command text or photo from a **linked** player in the private chat is a support
message.

- `SupportService.ensureConversationFor(userId)` then
  `SupportService.addMessage({ senderRole: PLAYER, senderId, body, source: TELEGRAM })`.
  A resolved thread reopens through the same path the widget uses.
- Photos: the largest `PhotoSize` is fetched through `getFile`, validated with
  `lib/storage.validateFile`, stored with `uploadFile`, and attached as `attachmentUrl`.
  Documents are declined with "Photos only, please".
- Post-commit effects go through the new `services/support/fanout.ts`, which both the
  socket gateway and the bot call: emit to the conversation room, broadcast the queue
  update to clerks, post into the staff topic (Section 6), and, when the *sender* is a
  clerk, push to the player's Telegram.
- Rate limit: `SupportRateLimit` keyed by user id, the same budget as the widget.
- When the thread is OPEN and nobody is available (Section 6.5), the bot answers once
  with the contact fallback text (phone + hours). It does not repeat it on every message.
- `/stop` stops notification pushes (`telegramNotifyEnabled = false`). It does not
  unlink and it does not stop support replies; unlinking is in the profile page.

Staff replies from either the admin inbox or the staff topic reach the player as a
Telegram message from the bot, attributed as "Support", plus the socket emit the widget
already listens to. The `SUPPORT_REPLY` notification is still written as an in-app row
but is **excluded from the Telegram push**, because the bridge already delivered the
reply itself.

### 5.4 Notification pushes

`NotificationService.create` gains one step after the insert: if the user has
`telegramChatId`, `telegramNotifyEnabled`, no `telegramBlockedAt`, and the type is not in
the bridged set, enqueue `{ notificationId }` on `telegram-send`.

The worker renders `<b>title</b>\nbody`, adds one "Open" inline button when the type has
a landing page, and sends it. Landing pages come from a small `type -> WEB_BASE_URL path`
map in `notify.ts` (deposits and withdrawals to the wallet page, wins to the game,
bonuses to promotions, account status to profile, support to the support panel).

Type policy:

| Sent to Telegram | Not sent |
|---|---|
| DEPOSIT_APPROVED, DEPOSIT_REJECTED, WITHDRAWAL_PROCESSED, GAME_WON, BONUS_GRANTED, BONUS_EXPIRING, CASHBACK_AWARDED, REFUND_PROCESSED, GAME_CANCELLED, REFERRAL_BONUS, TOURNAMENT_*, PREDICTION_*, ACCOUNT_STATUS_CHANGED, CAMPAIGN_MESSAGE | SUPPORT_REPLY (bridged directly), GAME_STARTING (fires for every scheduled game; would get the bot muted) |

Worker behaviour: BullMQ retries with backoff; on Telegram 429 it re-schedules with the
`retry_after` Telegram returns; on 403 blocked it stamps `telegramBlockedAt` and drops
the job; on any other 4xx it drops without retry and logs. The queue is `removeOnComplete`
to keep Redis small.

### 5.5 Self-serve account actions

All three produce a **one-time link into the web app** rather than doing the sensitive
part in chat, so nothing secret is ever typed into a Telegram history.

**Password reset (forgot password).** `/start forgot`, or `/password` from a linked
account:

1. Identity is the linked `telegramChatId`, or a freshly matched shared contact (5.2).
2. `AuthService.issuePasswordResetLink(userId)` writes `tg:pwreset:<token>` and returns
   `WEB_BASE_URL/auth/set-password?token=<token>`. Rate limit: three per user per hour.
3. The new page posts `POST /auth/password-reset/consume { token, newPassword }`. The
   API `GETDEL`s the token, hashes outside the transaction, then in one transaction sets
   `passwordHash`, `passwordResetAt = now`, `mustChangePassword = false`, and deletes
   every refresh token for the user (the same revocation `changePassword` does).
4. `passwordResetAt` is stamped, so `WalletService.requestWithdrawal`'s existing hold
   applies unchanged: a reset through Telegram cannot be followed by an immediate
   cash-out.
5. Players only. Staff accounts get "Ask an admin" and nothing is written, mirroring
   `adminResetPassword`.

**Change password (signed in).** `/password` from a linked account issues the same link.
The page shows "Set a new password" either way.

**Log out everywhere.** `/logout` asks for an inline confirmation, then
`AuthService.revokeAllSessions(userId)` deletes every refresh token. Reply: "Signed out on
all devices. Sign in again with your phone and password."

**Status (read-only).** `/status` shows real balance, bonus balance, the last three
deposits and withdrawals with their status, and the account status line. This answers
the most common support question before a human is involved. It never offers an action.

**Restricted or suspended account.** Where the app and the bot currently say "contact
support", show the coarse `AccountStatusChange.category` mapped to plain wording and,
when `expiresAt` is set, the date the account restores itself. One button, "Appeal",
opens a support thread with a system message "Appeal: account restricted (CATEGORY)" so
clerks see it in the queue like any other thread. No new table.

**Deposit rejection reasons.** `DepositRejectionReason` is mapped to plain guidance in
the notification body and the wallet page: duplicate receipt, amount mismatch, payer
mismatch, unreadable, not found, other. Each includes what to do next. This is copy in
`shared-types`, used by the API when it writes the notification.

## 6. Staff flows

### 6.1 Group setup (one-time, per brand)

1. Create a private supergroup, enable Topics.
2. Add the brand's bot as an admin with "Manage topics" and "Delete messages".
3. Put the group's chat id in `TELEGRAM_SUPPORT_GROUP_ID`. The bot logs the group title on
   boot and refuses to bridge anything from any other chat.
4. Bot privacy mode does not matter: an admin bot receives all group messages.

### 6.2 Staff linking

A clerk or admin clicks "Link my Telegram" in the admin app. `POST /admin/support/telegram/link`
(roles CLERK, ADMIN, SUPER_ADMIN) mints a `kind = staff` token; `/start <token>` in the
bot sets `telegramChatId` on the staff user. The same column as players; the role on the
user row is what makes it a staff link.

In the group, only messages whose `from.id` matches a user with a staff role and a
`telegramChatId` are bridged. Anyone else is answered once with "Link your account from
the admin app first" and nothing is written. Group membership alone grants nothing.

### 6.3 Topic lifecycle

| Event | Bot action |
|---|---|
| Thread becomes OPEN (first player message, reopen, or escalation) and has no topic | `createForumTopic` named `#<first 6 of id> <username>`; post a header (username, masked phone, account status, link to the admin inbox) and the last ten messages; store `telegramTopicId` |
| Player message on a thread with a topic | Post into the topic (`message_thread_id`) with the source badge (web / Telegram) and any photo |
| Staff message in a topic | Look up the conversation by topic id; `addMessage({ senderRole: AGENT, senderId, source: TELEGRAM })`; if the thread is unassigned, `SupportService.claim` for that staff user first; fan out to the player |
| Thread resolved (either side) | `closeForumTopic`; a later reopen calls `reopenForumTopic` |
| Topic deleted by a human | Bot clears `telegramTopicId`; the next player message creates a new one |

Edited and deleted Telegram messages are ignored. The database transcript is the record.

### 6.4 Commands in the group

| Command | Where | Effect |
|---|---|---|
| `/assign` | topic | `SupportService.claim` for the sender |
| `/release` | topic | `SupportService.release` |
| `/resolve` | topic | `SupportService.resolve`, closes the topic |
| `/note <text>` | topic | Audit-only note (`writeSupportAudit`), never sent to the player |
| `/player` | topic | Re-posts the header with a link to the player in the admin app |
| `/queue` | anywhere in group | Unassigned count and the oldest five threads, each with a link to its topic |
| `/onshift` `/offshift` | anywhere in group | Section 6.5 |

Every one of these goes through `writeSupportAudit` with `detail.channel = 'telegram'`,
so the audit log reads the same whichever inbox the clerk used.

### 6.5 Presence

Today "someone is available" means a clerk holds a socket in `support:agents`. Staff on
Telegram never hold that socket, so without a change the widget would keep telling
players nobody is available.

- `/onshift` adds the staff user to `tg:onshift` with an expiry of `TELEGRAM_SHIFT_HOURS`
  (default 8). Any message or command from that user in the group refreshes it.
  `/offshift` removes it.
- `anyAgentOnline()` in the support gateway becomes: socket room non-empty **or**
  `tg:onshift` has an unexpired member. The existing two-second deadline still answers
  `false` on any Redis trouble, for the reason documented in the gateway.
- When a thread becomes OPEN, the topic header mentions every on-shift staff user
  (`tg://user?id=`) so their phones buzz.

### 6.6 Ops alerts (pinned topic)

A single pinned "Ops" topic receives, with a link into the admin page and no action
buttons: manual deposits waiting longer than a configurable threshold, ZareCash
withdrawal risk holds, the existing float-low admin alert, and games stuck in
WAITING/LOCKING/STARTING past their expected time. This reuses the alert points that
already exist in `zarecash.service.ts` and the startup recovery pass; it adds a sink,
not new detection.

## 7. Security and abuse

### 7.1 Webhook

- `POST /v1/telegram/webhook`. Telegram is registered with `secret_token`; the route
  rejects any request whose `X-Telegram-Bot-Api-Secret-Token` header does not equal
  `TELEGRAM_WEBHOOK_SECRET`. No secret in the path.
- `update_id` is `SETNX`ed in Redis before processing; a redelivered update is
  acknowledged and dropped.
- The handler answers 200 within Telegram's timeout; anything slow (photo fetch, topic
  creation) runs after the ack. A failure is logged with the update id and does not
  bubble into a 5xx that would make Telegram retry forever.
- Body size is capped at 1 MB; photos are fetched by file id, never from the body.

### 7.2 Link conflicts

| Situation | Rule |
|---|---|
| Telegram already linked to user A, token or contact resolves to user B | Refuse. Reply "This Telegram is already connected to another account. Contact support." Write an audit row: it is a multi-account signal. |
| User B already linked to a different Telegram | Allow re-link after an inline confirmation. The old chat receives "This account was connected to a different Telegram." Audit row with both chat ids. |
| Staff token used by a chat already linked to a player account | Refuse. Staff and player links never share a Telegram. |
| Token expired or already used | "Link expired. Open the app and try again." |

### 7.3 What never goes over Telegram

- Passwords, temporary or otherwise. Resets are links.
- The full phone number in the staff group; the header shows the last four digits.
- Anything to a Telegram account that is not linked, except the share-contact prompt,
  the no-account reply, and the contact fallback.

### 7.4 Rate limits

| Traffic | Bucket |
|---|---|
| Linked player messages | `SupportRateLimit` by user id, same as the widget |
| Unlinked chats | `tg:guest:<id>`, five messages per minute, then silence for the minute |
| Password reset links | three per user per hour |
| Link tokens | ten per user per hour |
| Outbound | the queue paces to Telegram's limits and honours `retry_after` |

### 7.5 Account status

A SUSPENDED or RESTRICTED player can still link, chat with support, and appeal. `/status`
shows the status line. Nothing else changes, because the bot performs no restricted action.

## 8. Configuration

| Variable | Where | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | api | Exists. Bot token; also still used by the widget's hash check |
| `TELEGRAM_WEBHOOK_SECRET` | api | Random string; the bot is enabled only when both token and secret are set |
| `API_BASE_URL` | api | Exists. `setWebhook` registers `<API_BASE_URL>/v1/telegram/webhook` on boot |
| `WEB_BASE_URL` | api | Exists. Deep links into the player app |
| `TELEGRAM_SUPPORT_GROUP_ID` | api | Staff group chat id; the staff bridge is enabled only when set |
| `TELEGRAM_SHIFT_HOURS` | api | Default 8 |
| `TELEGRAM_OPS_TOPIC_ID` | api | Optional; ops alerts are off without it |
| `NUXT_PUBLIC_TELEGRAM_BOT_NAME` | web | Exists. Used to build `t.me` links |

Boot sequence: if enabled, call `getMe` and `setWebhook` once, log the bot username and
the group title, and register the queue worker. If Telegram is unreachable at boot the
API still starts; the bot retries `setWebhook` every minute until it succeeds. On
`SIGTERM` nothing is unregistered: the webhook belongs to the deployment, not the
process, and a rolling restart must not drop updates.

## 9. Failure modes

| Failure | Behaviour |
|---|---|
| Telegram API down | Pushes queue up with backoff; support messages from the web still flow; the widget's presence check falls back to the socket room only |
| Redis down | Link tokens and dedupe fail closed (link refused, update processed once at most by Telegram's own retry); presence answers "nobody", so the contact fallback shows |
| Player blocked the bot | `telegramBlockedAt` set; pushes stop; support replies still land in the widget; `/start` clears it |
| Group id wrong or bot removed from group | Staff bridge disabled with a boot-time and hourly log line; the admin inbox is unaffected |
| Topic creation fails (rate limit, permissions) | Message is still in the database and the admin inbox; the topic is created on the next player message |
| Duplicate update delivery | Dropped by the `tg:update` key |
| Two clerks reply in the same second from inbox and topic | Both messages are written; `claim` is first-writer-wins as today |

## 10. Phases and acceptance

### Phase 1 - runtime, linking, pushes, player-side bridge

Touches: API, schema, shared-types, web.

Done when:

- With `TELEGRAM_*` unset, the full test suite and a boot are unchanged.
- A signed-in player taps "Connect Telegram" on the profile page, lands in the bot, and
  is linked with no further input.
- A deposit approval reaches the player's Telegram within a few seconds, with a working
  "Open" button.
- A message typed into the bot appears in the admin inbox with a Telegram badge; a clerk
  reply from the inbox reaches the bot and the widget.
- Blocking the bot stops pushes without an error in the logs beyond one info line.
- Unit tests: phone normaliser and candidate forms; token mint/consume/single-use; link
  conflict matrix; notification fan-out type policy; webhook secret and dedupe.

### Phase 2 - staff on Telegram

Touches: API, admin.

Done when:

- A clerk links from the admin app; an unlinked group member cannot post into a thread.
- A new thread creates a topic with the header and transcript; a reply in the topic
  reaches the player and shows in the admin inbox attributed to that clerk.
- `/resolve` closes the topic and the thread; a player reopen reopens both.
- `/onshift` makes the widget stop showing the contact fallback; `/offshift` or expiry
  brings it back.
- Every group action has an audit row with `channel = telegram`.

### Phase 3 - self-serve account actions

Touches: API, web.

Done when:

- A logged-out player with a phone-only account resets their password through
  `start=forgot` and a shared contact, and the withdrawal hold is in force afterwards.
- `/password` and `/logout` work for linked players and refuse for staff.
- `/status` shows balances and the last three deposits and withdrawals.
- A restricted player sees the category and restore date in the app and the bot, and
  "Appeal" opens a thread that clerks see in the queue.
- Rejected deposits carry a plain-language reason and a next step.

### Phase 4 - AI first line (optional, not planned)

The schema already carries `SupportConversationStatus.BOT`, `SupportSenderRole.AI`,
`aiTurnCount` and `lowConfidenceStreak`, gated by `SUPPORT_AI_ENABLED`. If wanted later,
the bot and the widget both benefit without further channel work, because the AI writes
through the same `addMessage` and `fanout` path.

## 11. Out of scope, deliberately

- Telegram sign-in through the bot. Linking writes `telegramChatId`, never `telegramId`.
- Any money action in chat, including deposit codes and withdrawal requests.
- Guest support for people with no account. It needs conversations without a user and a
  rework of the one-live-thread index; revisit if the no-account reply in 5.2 turns out
  to be a real volume.
- Phone number change and account deletion. Both need verification we do not have.
- A Telegram Mini App. The PWA works in Telegram's in-app browser through the deep links
  already.
