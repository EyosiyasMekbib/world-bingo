/**
 * Thin wrapper over the Telegram Bot API. Knows the HTTP contract and
 * nothing about support conversations or notifications — same split as
 * gateways/payment/zarecash/client.ts.
 *
 * No SDK: the Bot API is plain JSON-over-HTTPS and the surface this bot
 * needs is small (message send, forum topics, getFile, webhook
 * registration). A hand-rolled client keeps the dependency footprint the
 * same as everything else in gateways/, and keeps every call's error
 * handling in one place.
 */

import { botToken } from './config.js'

const API_ROOT = 'https://api.telegram.org'
const REQUEST_TIMEOUT_MS = 10_000

export class TelegramApiError extends Error {
  readonly code: string
  readonly status: number
  /** Telegram's own error_code, e.g. 403 forbidden (blocked), 429 too many
   *  requests, 400 bad request (e.g. chat not found). */
  readonly errorCode: number | null
  /** Present on a 429; seconds to wait before retrying. */
  readonly retryAfterSecs: number | null
  /** True when Telegram reported the user blocked the bot — the caller
   *  should stamp telegramBlockedAt and stop sending, not retry. */
  readonly blocked: boolean

  constructor(input: {
    code: string
    message: string
    status: number
    errorCode: number | null
    retryAfterSecs: number | null
    blocked: boolean
  }) {
    super(input.message)
    this.name = 'TelegramApiError'
    this.code = input.code
    this.status = input.status
    this.errorCode = input.errorCode
    this.retryAfterSecs = input.retryAfterSecs
    this.blocked = input.blocked
  }
}

interface TelegramResponse<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
  parameters?: { retry_after?: number; migrate_to_chat_id?: number }
}

export interface InlineUrlButton {
  text: string
  url: string
}

export interface SendMessageInput {
  chatId: string | number
  text: string
  /** Forum topic to post into — omit for a private chat or a group's
   *  General topic. */
  messageThreadId?: number
  /** One row of URL buttons. Deliberately no callback_data buttons anywhere
   *  in this bot — see docs/telegram-support-bot.md §4: every action is a
   *  text command or a URL, so the webhook only ever has to handle
   *  `message` updates, never `callback_query`. */
  buttons?: InlineUrlButton[]
  /** A one-button reply keyboard asking the player to share their phone.
   *  Mutually exclusive with `buttons` in practice — Telegram allows only
   *  one keyboard type per message. */
  requestContact?: boolean
  parseMode?: 'HTML'
}

export interface TelegramFile {
  file_id: string
  file_path?: string
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
}

/** The subset of Telegram's Update object this bot reads. Anything else on
 *  the wire is ignored, which is also how new update types stay harmless. */
export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    message_thread_id?: number
    is_topic_message?: boolean
    date: number
    chat: TelegramChat
    from?: { id: number; is_bot: boolean; username?: string; first_name?: string }
    text?: string
    contact?: { phone_number: string; first_name?: string; user_id?: number }
    photo?: Array<{ file_id: string; width: number; height: number }>
    document?: { file_id: string; mime_type?: string }
  }
}

function classify(status: number, body: TelegramResponse<unknown> | null): {
  code: string
  blocked: boolean
  retryAfterSecs: number | null
} {
  const description = (body?.description ?? '').toLowerCase()
  const blocked =
    status === 403 &&
    (description.includes('blocked') || description.includes('deactivated') || description.includes('kicked'))
  const retryAfterSecs = body?.parameters?.retry_after ?? null
  const code = blocked ? 'blocked' : status === 429 ? 'rate_limited' : `http_${status}`
  return { code, blocked, retryAfterSecs }
}

export class TelegramClient {
  private readonly token: string

  constructor(token?: string) {
    this.token = token ?? botToken()
  }

  private async call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    let res: Response
    try {
      res = await fetch(`${API_ROOT}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      })
    } catch (err) {
      throw new TelegramApiError({
        code: 'network_error',
        message: (err as Error)?.message ?? 'request failed',
        status: 0,
        errorCode: null,
        retryAfterSecs: null,
        blocked: false,
      })
    } finally {
      clearTimeout(timer)
    }

    let parsed: TelegramResponse<T> | null = null
    try {
      parsed = (await res.json()) as TelegramResponse<T>
    } catch {
      /* Telegram always returns JSON; an unparsable body falls through to
       * the !ok branch below with parsed === null. */
    }

    if (!res.ok || !parsed?.ok) {
      const { code, blocked, retryAfterSecs } = classify(res.status, parsed)
      throw new TelegramApiError({
        code,
        message: parsed?.description ?? `Telegram ${method} failed with ${res.status}`,
        status: res.status,
        errorCode: parsed?.error_code ?? res.status,
        retryAfterSecs,
        blocked,
      })
    }

    return parsed.result as T
  }

  async getMe(): Promise<{ id: number; username: string }> {
    return this.call('getMe')
  }

  /** Idempotent — safe to call on every boot. `secretToken` is verified on
   *  every inbound update by routes/telegram/webhook.ts. */
  async setWebhook(url: string, secretToken: string): Promise<void> {
    await this.call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message'],
      // callback_query is deliberately not in allowed_updates — see
      // SendMessageInput.buttons above.
      drop_pending_updates: false,
    })
  }

  async sendMessage(input: SendMessageInput): Promise<{ message_id: number }> {
    const reply_markup = input.requestContact
      ? {
          keyboard: [[{ text: '📱 Share my phone number', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        }
      : input.buttons?.length
        ? { inline_keyboard: [input.buttons.map((b) => ({ text: b.text, url: b.url }))] }
        : undefined

    return this.call('sendMessage', {
      chat_id: input.chatId,
      text: input.text,
      message_thread_id: input.messageThreadId,
      parse_mode: input.parseMode ?? 'HTML',
      reply_markup,
      link_preview_options: { is_disabled: true },
    })
  }

  /** Removes the reply keyboard the share-contact prompt put up — called
   *  right after a contact is received, so a player who declines is not
   *  left staring at a stale button forever. */
  async sendMessagePlain(chatId: string | number, text: string, messageThreadId?: number): Promise<void> {
    await this.call('sendMessage', {
      chat_id: chatId,
      text,
      message_thread_id: messageThreadId,
      parse_mode: 'HTML',
      reply_markup: { remove_keyboard: true },
      link_preview_options: { is_disabled: true },
    })
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return this.call('getFile', { file_id: fileId })
  }

  /** Direct file download URL for a file_path from getFile. Not an API
   *  method call — the file is served from a different host path. */
  fileUrl(filePath: string): string {
    return `${API_ROOT}/file/bot${this.token}/${filePath}`
  }

  async createForumTopic(chatId: string | number, name: string): Promise<{ message_thread_id: number }> {
    return this.call('createForumTopic', { chat_id: chatId, name: name.slice(0, 128) })
  }

  async closeForumTopic(chatId: string | number, messageThreadId: number): Promise<void> {
    await this.call('closeForumTopic', { chat_id: chatId, message_thread_id: messageThreadId })
  }

  async reopenForumTopic(chatId: string | number, messageThreadId: number): Promise<void> {
    await this.call('reopenForumTopic', { chat_id: chatId, message_thread_id: messageThreadId })
  }
}

let shared: TelegramClient | null = null

/** Module-level singleton, mirroring getIo()/redis default-export style
 *  elsewhere in lib/ — one client, reused across requests. */
export function telegramClient(): TelegramClient {
  if (!shared) shared = new TelegramClient()
  return shared
}
