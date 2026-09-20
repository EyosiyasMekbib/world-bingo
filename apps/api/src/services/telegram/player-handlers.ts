/**
 * Handles a Telegram `message` update from a PRIVATE chat — a player, or a
 * clerk/admin completing a staff link (see handleStart). The staff GROUP's
 * messages go through staff-handlers.ts instead; routes/telegram/webhook.ts
 * is what tells the two apart, by chat type.
 */

import prisma from '../../lib/prisma.js'
import redis from '../../lib/redis.js'
import { telegramClient } from '../../gateways/telegram/client.js'
import type { TelegramUpdate } from '../../gateways/telegram/client.js'
import {
  consumeLinkToken,
  linkChatToUser,
  matchPhoneToPlayer,
  mintPasswordResetToken,
  passwordResetLinkFor,
  setNotifyEnabled,
} from './link.service.js'
import { AuthService } from '../auth.service.js'
import { AccountStatusService } from '../account-status.service.js'
import { SupportService } from '../support/support.service.js'
import { SupportRateLimit } from '../support/support-rate-limit.js'
import { SupportContact } from '../support/support-contact.js'
import { afterSupportMessage } from '../support/fanout.js'
import { anyAgentOnline } from '../support/presence.js'
import { openAppeal, AlreadyActiveError } from '../support/appeal.js'
import { getIo } from '../../lib/socket.js'
import { uploadFile, validateFile } from '../../lib/storage.js'
import { SupportMessageSource, STATUS_CATEGORY_LABELS } from '@world-bingo/shared-types'

type PlayerMessage = NonNullable<TelegramUpdate['message']>

const client = () => telegramClient()

const HELP_TEXT_LINKED =
  'Here is what I can do:\n' +
  '/status — balance, account status, recent deposits and withdrawals\n' +
  '/password — get a one-time link to set a new password\n' +
  '/logout — sign out of every device\n' +
  '/appeal — ask us to review a restricted or suspended account\n' +
  '/stop — turn off notifications (support replies still arrive here)\n\n' +
  'Anything else you type here goes straight to support.'

const HELP_TEXT_UNLINKED =
  'Open World Bingo, go to your profile, and tap "Connect Telegram" to link this chat. ' +
  'Or share your phone number below and I can find your account.'

const GUEST_LIMIT_PER_MIN = 5

async function withinGuestLimit(chatId: string): Promise<boolean> {
  const key = `tg:guest:${chatId}:${Math.floor(Date.now() / 60_000)}`
  const count = await redis.incr(key)
  if (count === 1) await redis.expire(key, 60)
  return count <= GUEST_LIMIT_PER_MIN
}

/** How often the bot repeats "nobody is online right now" into the SAME
 *  thread — see docs/telegram-support-bot.md §5.3: once, not on every
 *  message while a thread sits unanswered. */
const CONTACT_FALLBACK_COOLDOWN_SECS = 3600

async function shouldShowContactFallback(conversationId: string): Promise<boolean> {
  const key = `tg:contactshown:${conversationId}`
  const isFirst = (await redis.incr(key)) === 1
  if (isFirst) await redis.expire(key, CONTACT_FALLBACK_COOLDOWN_SECS)
  return isFirst
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export async function handlePlayerMessage(message: PlayerMessage): Promise<void> {
  const chatId = String(message.chat.id)
  const text = (message.text ?? '').trim()

  if (text.startsWith('/start')) {
    await handleStart(chatId, text)
    return
  }

  const user = await prisma.user.findUnique({
    where: { telegramChatId: chatId },
    select: { id: true, firstName: true, username: true },
  })

  if (text === '/help') {
    await client().sendMessagePlain(chatId, user ? HELP_TEXT_LINKED : HELP_TEXT_UNLINKED)
    return
  }

  if (!user) {
    if (message.contact) {
      await handleSharedContact(chatId, message.contact)
      return
    }
    if (!(await withinGuestLimit(chatId))) return
    await client().sendMessage({
      chatId,
      text: "I don't recognise this chat yet. Share your phone number and I'll look for your account.",
      requestContact: true,
    })
    return
  }

  // From here on, every branch is for a LINKED player.
  if (message.contact) {
    // Re-sharing while already linked re-verifies the same account; a
    // mismatch (someone else's forwarded contact) is still rejected inside
    // handleSharedContact.
    await handleSharedContact(chatId, message.contact)
    return
  }

  switch (text) {
    case '/status':
      await sendStatus(chatId, user.id)
      return
    case '/password':
      await sendPasswordLink(chatId, user.id)
      return
    case '/logout':
      await client().sendMessagePlain(chatId, 'This signs you out on every device. Send "/logout confirm" to proceed.')
      return
    case '/logout confirm':
      await AuthService.revokeAllSessions(user.id)
      await client().sendMessagePlain(chatId, 'Signed out on all devices. Sign in again with your phone and password.')
      return
    case '/stop':
      await setNotifyEnabled(user.id, false)
      await client().sendMessagePlain(
        chatId,
        "Notifications off. I'll still reply here for support — turn them back on from your profile.",
      )
      return
    case '/appeal':
      await handleAppeal(chatId, user.id)
      return
  }

  await handleSupportMessage(chatId, user.id, message)
}

async function handleStart(chatId: string, text: string): Promise<void> {
  const payload = text.split(' ')[1]?.trim()

  if (!payload) {
    const user = await prisma.user.findUnique({ where: { telegramChatId: chatId }, select: { firstName: true } })
    await client().sendMessagePlain(
      chatId,
      user
        ? `Welcome back${user.firstName ? `, ${user.firstName}` : ''}. Send /help to see what I can do.`
        : 'Welcome to World Bingo Support. Tap the button below to share your phone number and I can link your account.',
    )
    if (!user) {
      await client().sendMessage({ chatId, text: 'Share your phone number:', requestContact: true })
    }
    return
  }

  if (payload === 'forgot') {
    await client().sendMessage({
      chatId,
      text: "Let's find your account. Tap the button below to share your phone number — used only to verify it's you.",
      requestContact: true,
    })
    return
  }

  const tokenPayload = await consumeLinkToken(payload)
  if (!tokenPayload) {
    await client().sendMessagePlain(chatId, 'This link has expired. Open the app and try again from your profile.')
    return
  }

  const outcome = await linkChatToUser(tokenPayload.userId, chatId)
  if (!outcome.ok) {
    await client().sendMessagePlain(chatId, 'This Telegram is already connected to another account. Contact support.')
    return
  }
  if (outcome.relinked && outcome.previousChatId) {
    await client()
      .sendMessagePlain(outcome.previousChatId, 'This account was connected to a different Telegram.')
      .catch(() => {})
  }

  if (tokenPayload.kind === 'staff') {
    await client().sendMessagePlain(chatId, "Linked. You'll be bridged into the staff support group once you're in it.")
    return
  }

  await client().sendMessagePlain(
    chatId,
    "You're linked! You'll get notifications and support replies here. Send /help to see what I can do.",
  )

  if (tokenPayload.conversationId) {
    await postRecentHistory(chatId, tokenPayload.conversationId)
  }
}

async function postRecentHistory(chatId: string, conversationId: string): Promise<void> {
  try {
    const conversation = await SupportService.getById(conversationId)
    const { messages } = await SupportService.withHistory(conversation as never)
    const recent = messages.slice(-5)
    if (recent.length === 0) return
    const lines = recent.map((m) => `${m.senderRole}: ${m.body}`).join('\n')
    await client().sendMessagePlain(chatId, `Picking up where you left off:\n\n${lines}`)
  } catch (err) {
    console.error('[TelegramPlayer] posting recent history failed:', (err as Error)?.message)
  }
}

async function handleSharedContact(
  chatId: string,
  contact: NonNullable<PlayerMessage['contact']>,
): Promise<void> {
  if (!contact.user_id || String(contact.user_id) !== chatId) {
    await client().sendMessagePlain(chatId, 'Please share your own phone number using the button.')
    return
  }

  const match = await matchPhoneToPlayer(contact.phone_number)
  if (match.kind !== 'MATCH') {
    await client().sendMessagePlain(
      chatId,
      'No account uses this number. Register in the app, or contact support if this seems wrong.',
    )
    return
  }

  const outcome = await linkChatToUser(match.userId, chatId)
  if (!outcome.ok) {
    await client().sendMessagePlain(chatId, 'This Telegram is already connected to another account. Contact support.')
    return
  }
  if (outcome.relinked && outcome.previousChatId) {
    await client()
      .sendMessagePlain(outcome.previousChatId, 'This account was connected to a different Telegram.')
      .catch(() => {})
  }

  // A shared contact is how a LOGGED-OUT player reaches the bot at all, so
  // the natural next step is always the password reset link — see
  // docs/telegram-support-bot.md §5.2.
  await sendPasswordLink(chatId, match.userId)
}

async function sendPasswordLink(chatId: string, userId: string): Promise<void> {
  const token = await mintPasswordResetToken(userId)
  if (!token) {
    await client().sendMessagePlain(
      chatId,
      "You've asked for this too many times recently. Try again shortly, or contact support.",
    )
    return
  }
  await client().sendMessage({
    chatId,
    text: 'Tap below to set a new password. This link works once and expires in 10 minutes.',
    buttons: [{ text: 'Set new password', url: passwordResetLinkFor(token) }],
  })
}

async function sendStatus(chatId: string, userId: string): Promise<void> {
  const [wallet, statusInfo, deposits, withdrawals] = await Promise.all([
    prisma.wallet.findUnique({ where: { userId }, select: { realBalance: true, bonusBalance: true } }),
    AccountStatusService.playerView(userId),
    prisma.transaction.findMany({
      where: { userId, type: 'DEPOSIT' as never },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { amount: true, status: true, createdAt: true },
    }),
    prisma.transaction.findMany({
      where: { userId, type: 'WITHDRAWAL' as never },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { amount: true, status: true, createdAt: true },
    }),
  ])

  const lines = [
    `<b>Balance</b>: ${Number(wallet?.realBalance ?? 0).toFixed(2)} ETB (+${Number(wallet?.bonusBalance ?? 0).toFixed(2)} bonus)`,
    `<b>Account</b>: ${statusInfo.status}${
      statusInfo.category ? ` — ${STATUS_CATEGORY_LABELS[statusInfo.category] ?? statusInfo.category}` : ''
    }`,
  ]
  if (deposits.length > 0) {
    lines.push('', '<b>Recent deposits</b>')
    for (const d of deposits) lines.push(`${fmtDate(d.createdAt)} — ${Number(d.amount).toFixed(2)} ETB — ${d.status}`)
  }
  if (withdrawals.length > 0) {
    lines.push('', '<b>Recent withdrawals</b>')
    for (const w of withdrawals) lines.push(`${fmtDate(w.createdAt)} — ${Number(w.amount).toFixed(2)} ETB — ${w.status}`)
  }

  await client().sendMessage({ chatId, text: lines.join('\n') })
}

async function handleAppeal(chatId: string, userId: string): Promise<void> {
  try {
    const opened = await openAppeal(userId, SupportMessageSource.TELEGRAM)
    await client().sendMessagePlain(
      chatId,
      opened
        ? "We've flagged this for review. A team member will follow up here."
        : 'You already have an appeal in progress — no need to send another.',
    )
  } catch (err) {
    if (err instanceof AlreadyActiveError) {
      await client().sendMessagePlain(chatId, 'Your account is already active — nothing to appeal.')
      return
    }
    throw err
  }
}

async function handleSupportMessage(chatId: string, userId: string, message: PlayerMessage): Promise<void> {
  let body = (message.text ?? '').trim()
  let attachmentUrl: string | undefined
  let attachmentMime: string | undefined

  if (message.photo?.length) {
    try {
      // Largest size is last — Telegram lists photo sizes smallest-first.
      const largest = message.photo[message.photo.length - 1]
      const file = await client().getFile(largest.file_id)
      if (!file.file_path) throw new Error('getFile returned no file_path')
      const res = await fetch(client().fileUrl(file.file_path))
      if (!res.ok) throw new Error(`file download failed with ${res.status}`)
      const buffer = Buffer.from(await res.arrayBuffer())
      // Telegram re-encodes every photo sent through the "photo" field
      // (as opposed to "document") to JPEG, so this is not a guess.
      const mimetype = 'image/jpeg'
      validateFile(mimetype, buffer.byteLength)
      const uploaded = await uploadFile(buffer, `telegram-${largest.file_id}.jpg`, mimetype)
      attachmentUrl = uploaded.url
      attachmentMime = uploaded.mimetype
      if (!body) body = '📎 Photo'
    } catch (err) {
      console.error('[TelegramPlayer] photo upload failed:', (err as Error)?.message)
      await client().sendMessagePlain(chatId, "Couldn't save that photo — please try again or type your message instead.")
      return
    }
  } else if (message.document) {
    await client().sendMessagePlain(chatId, 'Photos only, please.')
    return
  }

  if (!body && !attachmentUrl) return // e.g. a sticker or an unsupported update — nothing to forward

  const allowed = await SupportRateLimit.checkMessage(userId)
  if (!allowed) {
    await client().sendMessagePlain(chatId, 'Too many messages. Wait a moment.')
    return
  }

  const conversation = await SupportService.ensureConversationFor(userId)
  const result = await SupportService.addMessage({
    conversationId: conversation.id,
    senderRole: 'PLAYER',
    senderId: userId,
    body,
    attachmentUrl,
    attachmentMime,
    source: SupportMessageSource.TELEGRAM,
  })

  await afterSupportMessage({ conversationId: conversation.id, message: result.message, ownerId: result.ownerId })

  if (!(await anyAgentOnline(getIo())) && (await shouldShowContactFallback(conversation.id))) {
    const contact = await SupportContact.get()
    if (contact.phone || contact.telegram) {
      const parts = [
        'Nobody is online right now.',
        contact.phone ? `Call ${contact.phone}.` : null,
        contact.hours || null,
      ].filter(Boolean)
      await client().sendMessagePlain(chatId, parts.join(' '))
    }
  }
}
