# Support Chat Phase 1 — Human Chat Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working player-to-clerk support chat — real-time thread, image attachments, claimable agent inbox with player financial context, and a phone/Telegram fallback when no clerk is online.

**Architecture:** Two new Prisma tables (`SupportConversation`, `SupportMessage`) behind a service that owns the status machine, driven over the existing Socket.io server through a new `support.gateway.ts` that copies the JWT-handshake auth of `game.gateway.ts`. The player widget lives in `apps/web`, the agent inbox in `apps/admin`. No AI in this phase — conversations open directly into `OPEN` and a human answers.

**Tech Stack:** Fastify v5, Socket.io v4 with the Redis adapter, Prisma 5 / PostgreSQL, ioredis, Nuxt 3 + Pinia, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-22-support-chat-design.md`

## Global Constraints

- Branch is `feat/support-chat`, already created. The spec is already committed there.
- Every support socket event requires an authenticated socket. Unauthenticated sockets get `support:error` and the event is dropped. This differs from `game.gateway.ts`, which tolerates anonymous spectators.
- A player may only read and write their own conversations. Staff events (`support:claim`, `support:release`, `support:resolve`) require role `CLERK`, `ADMIN`, or `SUPER_ADMIN`.
- Message bodies render as text, never as HTML.
- Message rate limit: **20 messages per user per minute**.
- Unanswered `OPEN` thread reveals real contact info after **5 minutes**.
- Attachments go through the existing `validateFile` / `uploadFile` in `apps/api/src/lib/storage.ts` and inherit its 5MB cap and image MIME allowlist. Do not add a second upload path.
- `SUPPORT_AI_ENABLED` is read in this phase only to decide the initial status of a new conversation. Phase 1 leaves it `false`, so new conversations start `OPEN`.
- Prettier config for this repo: single quotes, no semicolons, trailing commas everywhere. Match surrounding files.
- Tests run with `pnpm --filter @world-bingo/api test`. Vitest config sets `fileParallelism: false`; tests mock `../lib/prisma` rather than hitting a database, following `apps/api/src/services/brand.service.test.ts`.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `apps/api/prisma/migrations/20260822000000_add_support_chat/migration.sql` | Tables, enums, partial unique index |
| `packages/shared-types/src/entities/support.ts` | Wire types shared by API, web, admin |
| `apps/api/src/services/support/support.service.ts` | Conversation lifecycle, status machine, claim |
| `apps/api/src/services/support/support-presence.ts` | Redis agent-online set |
| `apps/api/src/services/support/support-rate-limit.ts` | Redis per-user message counter |
| `apps/api/src/services/support/errors.ts` | Typed service errors |
| `apps/api/src/gateways/support.gateway.ts` | Socket event handlers, rooms, authorization |
| `apps/api/src/routes/support/index.ts` | Attachment upload, public contact config |
| `apps/api/src/test/support.service.test.ts` | Lifecycle and status machine tests |
| `apps/api/src/test/support-claim.test.ts` | Claim concurrency test |
| `apps/api/src/test/support-rate-limit.test.ts` | Rate limiter tests |
| `apps/web/composables/useSupport.ts` | Widget state and socket wiring |
| `apps/web/components/support/SupportLauncher.vue` | Floating button with unread badge |
| `apps/web/components/support/SupportPanel.vue` | Thread, composer, attach, contact footer |
| `apps/admin/pages/support.vue` | Three-column agent inbox |
| `apps/admin/components/SupportPlayerContext.vue` | Right-hand financial context panel |

**Modified:**

| Path | Change |
|---|---|
| `apps/api/prisma/schema.prisma` | Two models, two enums, `SUPPORT_REPLY` notification type, two `User` relations |
| `packages/shared-types/src/entities/index.ts` | Re-export support types |
| `packages/shared-types/src/socket/index.ts` | Support events on both event interfaces |
| `apps/api/src/index.ts` | Register `registerSupportHandlers(io)` and the support routes |
| `apps/api/src/routes/settings/index.ts` | Three `support_*` default keys |
| `apps/admin/composables/useAdminApi.ts` | Support inbox methods |
| `apps/web/layouts/default.vue` | Mount the launcher, fix the dead footer links |

**Deviation from the spec, deliberate:** the spec proposed a server-side interval to detect threads unanswered past 5 minutes. That double-fires under horizontal scaling, and the API already runs multiple instances behind the Redis adapter. This plan reveals the contact fallback **client-side** instead — the widget knows `escalatedAt` from the status payload and reveals contact info on a local timer. Zero server machinery, correct under any instance count.

---

## Task 1: Prisma schema and migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260822000000_add_support_chat/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `SupportConversation` and `SupportMessage`; enums `SupportConversationStatus` (`BOT | OPEN | ASSIGNED | RESOLVED`) and `SupportSenderRole` (`PLAYER | AI | AGENT | SYSTEM`); `NotificationType.SUPPORT_REPLY`.

- [ ] **Step 1: Add the enums and models to the schema**

Append to `apps/api/prisma/schema.prisma`:

```prisma
// ─── Support Chat ────────────────────────────────────────────────────────────

enum SupportConversationStatus {
  BOT
  OPEN
  ASSIGNED
  RESOLVED
}

enum SupportSenderRole {
  PLAYER
  AI
  AGENT
  SYSTEM
}

model SupportConversation {
  id           String                    @id @default(uuid())
  userId       String
  user         User                      @relation("SupportConversations", fields: [userId], references: [id], onDelete: Cascade)
  status       SupportConversationStatus @default(OPEN)
  assignedToId String?
  assignedTo   User?                     @relation("SupportAssignments", fields: [assignedToId], references: [id], onDelete: SetNull)

  /// Detected thread language: "en" | "am" | "am-Latn". Phase 1 always writes "en";
  /// Phase 2's detector owns this column.
  language String @default("en")

  /// Consecutive AI replies since the last human turn. Phase 2 reads it; Phase 1
  /// leaves it at 0 so the column exists before the AI service needs it.
  aiTurnCount         Int @default(0)
  lowConfidenceStreak Int @default(0)

  lastMessageAt DateTime  @default(now())
  escalatedAt   DateTime?
  resolvedAt    DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  messages SupportMessage[]

  @@index([status, lastMessageAt])
  @@index([userId, lastMessageAt])
  @@index([assignedToId, status])
  @@map("support_conversations")
}

model SupportMessage {
  id             String              @id @default(uuid())
  conversationId String
  conversation   SupportConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  senderRole     SupportSenderRole
  /// User id for PLAYER and AGENT. Null for AI and SYSTEM.
  senderId       String?
  body           String              @db.Text
  attachmentUrl  String?
  attachmentMime String?
  readByPlayerAt DateTime?
  readByAgentAt  DateTime?
  createdAt      DateTime            @default(now())

  @@index([conversationId, createdAt])
  @@map("support_messages")
}
```

- [ ] **Step 2: Add the two relations to the User model**

Inside `model User { ... }` in the same file, alongside the existing relation fields:

```prisma
  supportConversations SupportConversation[] @relation("SupportConversations")
  supportAssignments   SupportConversation[] @relation("SupportAssignments")
```

- [ ] **Step 3: Add the notification type**

In `enum NotificationType`, after `PREDICTION_VOIDED`:

```prisma
  SUPPORT_REPLY
```

- [ ] **Step 4: Generate the migration without applying it**

Run from `apps/api/`:

```bash
pnpm prisma migrate dev --create-only --name add_support_chat
```

Rename the generated directory to `20260822000000_add_support_chat` so it sorts after `20260821000002_add_bonus_rule_segment_targeting`.

- [ ] **Step 5: Append the partial unique index to the migration SQL**

Prisma cannot express a partial unique index, so add it by hand at the end of `migration.sql`:

```sql
-- One live conversation per player. Without this a double-tapped widget button
-- creates a second thread and the second one is invisible to its own author.
CREATE UNIQUE INDEX "support_conversations_one_live_per_user"
  ON "support_conversations" ("userId")
  WHERE "status" <> 'RESOLVED';
```

- [ ] **Step 6: Apply and verify**

```bash
pnpm db:migrate
```

Then confirm the index exists:

```bash
pnpm prisma db execute --stdin <<< "SELECT indexdef FROM pg_indexes WHERE indexname = 'support_conversations_one_live_per_user';"
```

Expected: one row containing `WHERE (status <> 'RESOLVED'::\"SupportConversationStatus\")`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(support): add SupportConversation and SupportMessage models"
```

---

## Task 2: Shared wire types and socket events

**Files:**
- Create: `packages/shared-types/src/entities/support.ts`
- Modify: `packages/shared-types/src/entities/index.ts`
- Modify: `packages/shared-types/src/socket/index.ts`

**Interfaces:**
- Consumes: Task 1's enum value sets.
- Produces: `SupportConversationStatus`, `SupportSenderRole`, `SupportMessage`, `SupportConversation`, `SupportConversationWithMessages`, `SupportQueueItem`, `SupportContactInfo`; the socket events listed below. Every later task imports these from `@world-bingo/shared-types`.

- [ ] **Step 1: Write the entity types**

Create `packages/shared-types/src/entities/support.ts`:

```ts
export type SupportConversationStatus = 'BOT' | 'OPEN' | 'ASSIGNED' | 'RESOLVED'

export type SupportSenderRole = 'PLAYER' | 'AI' | 'AGENT' | 'SYSTEM'

export interface SupportMessage {
    id: string
    conversationId: string
    senderRole: SupportSenderRole
    /** User id for PLAYER and AGENT. Null for AI and SYSTEM. */
    senderId: string | null
    body: string
    attachmentUrl: string | null
    attachmentMime: string | null
    createdAt: string
}

export interface SupportConversation {
    id: string
    userId: string
    status: SupportConversationStatus
    assignedToId: string | null
    assignedToUsername: string | null
    language: string
    /** ISO timestamp the thread entered OPEN. The widget times the 5-minute
     *  contact reveal off this, so the server needs no sweep job. */
    escalatedAt: string | null
    resolvedAt: string | null
    lastMessageAt: string
    createdAt: string
}

export interface SupportConversationWithMessages {
    conversation: SupportConversation
    messages: SupportMessage[]
}

/** One row in the agent inbox list. */
export interface SupportQueueItem {
    id: string
    userId: string
    username: string
    status: SupportConversationStatus
    assignedToId: string | null
    assignedToUsername: string | null
    lastMessageAt: string
    lastMessagePreview: string
    unreadForAgent: number
}

export interface SupportContactInfo {
    phone: string
    telegram: string
    hours: string
}
```

- [ ] **Step 2: Re-export from the entities barrel**

Add to `packages/shared-types/src/entities/index.ts`:

```ts
export * from './support'
```

- [ ] **Step 3: Add the socket events**

In `packages/shared-types/src/socket/index.ts`, extend the top import:

```ts
import type { Game, Cartela, User, Notification } from '../entities'
import type {
    SupportConversation,
    SupportConversationWithMessages,
    SupportMessage,
    SupportContactInfo,
} from '../entities/support'
```

Add to `ServerToClientEvents`, before the closing brace:

```ts
    // ── Support Chat ─────────────────────────────────────────────────────────
    /** The live thread, sent in reply to support:open */
    'support:thread': (payload: SupportConversationWithMessages) => void
    /** A persisted message on a thread the socket is subscribed to */
    'support:message': (message: SupportMessage) => void
    /** Status or assignment changed */
    'support:status': (conversation: SupportConversation) => void
    /** Queue changed — emitted to the support:agents room only */
    'support:queue-update': (payload: { conversationId: string; unassignedCount: number }) => void
    /** Real phone/Telegram contact, pushed when no agent is online */
    'support:contact-fallback': (payload: { conversationId: string } & SupportContactInfo) => void
    'support:error': (payload: { conversationId?: string; code: string; message: string }) => void
```

Add to `ClientToServerEvents`, before the closing brace:

```ts
    // ── Support Chat ─────────────────────────────────────────────────────────
    /** Fetch or create the caller's live thread */
    'support:open': () => void
    'support:send': (payload: {
        conversationId: string
        body: string
        attachmentUrl?: string
        attachmentMime?: string
    }) => void
    'support:escalate': (payload: { conversationId: string }) => void
    /** Staff only */
    'support:claim': (payload: { conversationId: string }) => void
    'support:release': (payload: { conversationId: string }) => void
    'support:resolve': (payload: { conversationId: string }) => void
    /** Staff subscribes to a specific thread to watch it */
    'support:watch': (payload: { conversationId: string }) => void
    'support:read': (payload: { conversationId: string }) => void
```

Extend `SocketData` so the gateway can authorize staff events without a database round trip per event:

```ts
export interface SocketData {
    userId: string
    username: string
    gameId?: string
    /** Role from the JWT claims. The support gateway authorizes staff events off this. */
    role?: string
}
```

- [ ] **Step 4: Typecheck the package**

```bash
pnpm --filter @world-bingo/shared-types build
```

Expected: exits 0, `dist/` regenerated.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-types/src
git commit -m "feat(support): add support chat wire types and socket events"
```

---

## Task 3: Support service — open a thread and append messages

**Files:**
- Create: `apps/api/src/services/support/errors.ts`
- Create: `apps/api/src/services/support/support.service.ts`
- Create: `apps/api/src/test/support.service.test.ts`

**Interfaces:**
- Consumes: Task 1 Prisma models, Task 2 wire types.
- Produces:
  - `SupportError` subclasses `ConversationNotFoundError`, `ConversationNotOpenError`, `NotParticipantError`, `StaleConversationError`, each with a string `code`.
  - `SupportService.openForUser(userId: string): Promise<SupportConversationWithMessages>`
  - `SupportService.addMessage(input: AddMessageInput): Promise<SupportMessage>` where `AddMessageInput = { conversationId: string; senderRole: SupportSenderRole; senderId: string | null; body: string; attachmentUrl?: string | null; attachmentMime?: string | null }`
  - `SupportService.getById(conversationId: string): Promise<SupportConversation>`
  - `SupportService.assertPlayerOwns(conversationId: string, userId: string): Promise<void>`

- [ ] **Step 1: Write the errors module**

Create `apps/api/src/services/support/errors.ts`:

```ts
/** Base for every support service error. `code` is what reaches the client on
 *  `support:error` — the message text is for logs, not for players. */
export class SupportError extends Error {
    constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message)
        this.name = new.target.name
    }
}

export class ConversationNotFoundError extends SupportError {
    constructor() {
        super('SUPPORT_NOT_FOUND', 'Conversation not found')
    }
}

/** Claim lost the race, or the thread was not in a claimable state. */
export class ConversationNotOpenError extends SupportError {
    constructor() {
        super('SUPPORT_ALREADY_CLAIMED', 'Conversation is not open for claiming')
    }
}

export class NotParticipantError extends SupportError {
    constructor() {
        super('SUPPORT_FORBIDDEN', 'Not a participant in this conversation')
    }
}

/** The client is holding a conversation id that has been resolved while a newer
 *  live thread exists. It must re-open rather than write to the old one. */
export class StaleConversationError extends SupportError {
    constructor() {
        super('SUPPORT_STALE', 'Conversation is resolved and a newer thread exists')
    }
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/api/src/test/support.service.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
    default: {
        supportConversation: {
            findFirst: vi.fn(),
            findUnique: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
            updateMany: vi.fn(),
        },
        supportMessage: {
            create: vi.fn(),
            findMany: vi.fn(),
        },
    },
}))

import prisma from '../lib/prisma'
import { SupportService, LIVE_STATUSES } from '../services/support/support.service'
import { ConversationNotFoundError, StaleConversationError } from '../services/support/errors'

const NOW = new Date('2026-08-22T10:00:00.000Z')

function conversationRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'conv-1',
        userId: 'user-1',
        status: 'OPEN',
        assignedToId: null,
        assignedTo: null,
        language: 'en',
        aiTurnCount: 0,
        lowConfidenceStreak: 0,
        lastMessageAt: NOW,
        escalatedAt: NOW,
        resolvedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
    }
}

describe('SupportService.openForUser', () => {
    beforeEach(() => vi.clearAllMocks())

    it('returns the existing live thread with its history', async () => {
        ;(prisma.supportConversation.findFirst as any).mockResolvedValue(conversationRow())
        ;(prisma.supportMessage.findMany as any).mockResolvedValue([
            {
                id: 'msg-1',
                conversationId: 'conv-1',
                senderRole: 'PLAYER',
                senderId: 'user-1',
                body: 'hello',
                attachmentUrl: null,
                attachmentMime: null,
                createdAt: NOW,
            },
        ])

        const result = await SupportService.openForUser('user-1')

        expect(prisma.supportConversation.create).not.toHaveBeenCalled()
        expect(result.conversation.id).toBe('conv-1')
        expect(result.messages).toHaveLength(1)
        expect(result.messages[0].body).toBe('hello')
    })

    it('creates a thread when none is live, and it starts OPEN', async () => {
        ;(prisma.supportConversation.findFirst as any).mockResolvedValue(null)
        ;(prisma.supportConversation.create as any).mockResolvedValue(conversationRow({ id: 'conv-new' }))
        ;(prisma.supportMessage.findMany as any).mockResolvedValue([])

        const result = await SupportService.openForUser('user-1')

        expect(prisma.supportConversation.create).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ userId: 'user-1', status: 'OPEN' }) }),
        )
        expect(result.conversation.id).toBe('conv-new')
        expect(result.messages).toEqual([])
    })

    it('recovers from the partial-unique race by re-reading instead of throwing', async () => {
        // Two widget taps land together: both see no live thread, both insert,
        // the loser hits the partial unique index.
        ;(prisma.supportConversation.findFirst as any)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(conversationRow({ id: 'conv-winner' }))
        ;(prisma.supportConversation.create as any).mockRejectedValue(
            Object.assign(new Error('unique violation'), { code: 'P2002' }),
        )
        ;(prisma.supportMessage.findMany as any).mockResolvedValue([])

        const result = await SupportService.openForUser('user-1')

        expect(result.conversation.id).toBe('conv-winner')
    })
})

describe('SupportService.addMessage', () => {
    beforeEach(() => vi.clearAllMocks())

    it('persists the message and bumps lastMessageAt', async () => {
        ;(prisma.supportConversation.findUnique as any).mockResolvedValue(conversationRow())
        ;(prisma.supportMessage.create as any).mockResolvedValue({
            id: 'msg-2',
            conversationId: 'conv-1',
            senderRole: 'PLAYER',
            senderId: 'user-1',
            body: 'where is my deposit',
            attachmentUrl: null,
            attachmentMime: null,
            createdAt: NOW,
        })
        ;(prisma.supportConversation.update as any).mockResolvedValue(conversationRow())

        const message = await SupportService.addMessage({
            conversationId: 'conv-1',
            senderRole: 'PLAYER',
            senderId: 'user-1',
            body: 'where is my deposit',
        })

        expect(message.id).toBe('msg-2')
        expect(prisma.supportConversation.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'conv-1' },
                data: expect.objectContaining({ lastMessageAt: expect.any(Date) }),
            }),
        )
    })

    it('reopens a RESOLVED thread to OPEN, never to BOT', async () => {
        ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
            conversationRow({ status: 'RESOLVED', resolvedAt: NOW, assignedToId: 'clerk-1' }),
        )
        ;(prisma.supportConversation.findFirst as any).mockResolvedValue(null)
        ;(prisma.supportMessage.create as any).mockResolvedValue({
            id: 'msg-3',
            conversationId: 'conv-1',
            senderRole: 'PLAYER',
            senderId: 'user-1',
            body: 'still not fixed',
            attachmentUrl: null,
            attachmentMime: null,
            createdAt: NOW,
        })
        ;(prisma.supportConversation.update as any).mockResolvedValue(conversationRow())

        await SupportService.addMessage({
            conversationId: 'conv-1',
            senderRole: 'PLAYER',
            senderId: 'user-1',
            body: 'still not fixed',
        })

        const updateArg = (prisma.supportConversation.update as any).mock.calls[0][0]
        expect(updateArg.data.status).toBe('OPEN')
        expect(updateArg.data.resolvedAt).toBeNull()
        expect(updateArg.data.assignedToId).toBeNull()
    })

    it('refuses to reopen a resolved thread when a newer live thread exists', async () => {
        // Reopening here would insert a second live row and trip the partial
        // unique index. Tell the client to re-open instead.
        ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
            conversationRow({ status: 'RESOLVED', resolvedAt: NOW }),
        )
        ;(prisma.supportConversation.findFirst as any).mockResolvedValue(
            conversationRow({ id: 'conv-newer' }),
        )

        await expect(
            SupportService.addMessage({
                conversationId: 'conv-1',
                senderRole: 'PLAYER',
                senderId: 'user-1',
                body: 'hi',
            }),
        ).rejects.toBeInstanceOf(StaleConversationError)

        expect(prisma.supportMessage.create).not.toHaveBeenCalled()
    })

    it('throws when the conversation does not exist', async () => {
        ;(prisma.supportConversation.findUnique as any).mockResolvedValue(null)

        await expect(
            SupportService.addMessage({
                conversationId: 'nope',
                senderRole: 'PLAYER',
                senderId: 'user-1',
                body: 'hi',
            }),
        ).rejects.toBeInstanceOf(ConversationNotFoundError)
    })

    it('rejects an empty body', async () => {
        await expect(
            SupportService.addMessage({
                conversationId: 'conv-1',
                senderRole: 'PLAYER',
                senderId: 'user-1',
                body: '   ',
            }),
        ).rejects.toThrow()
    })
})

describe('SupportService.assertPlayerOwns', () => {
    beforeEach(() => vi.clearAllMocks())

    it('throws for a conversation belonging to someone else', async () => {
        ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
            conversationRow({ userId: 'someone-else' }),
        )
        await expect(SupportService.assertPlayerOwns('conv-1', 'user-1')).rejects.toThrow()
    })

    it('passes for the owner', async () => {
        ;(prisma.supportConversation.findUnique as any).mockResolvedValue(conversationRow())
        await expect(SupportService.assertPlayerOwns('conv-1', 'user-1')).resolves.toBeUndefined()
    })
})
```

- [ ] **Step 3: Run the tests and confirm they fail**

```bash
pnpm --filter @world-bingo/api test -- src/test/support.service.test.ts
```

Expected: FAIL — `Cannot find module '../services/support/support.service'`.

- [ ] **Step 4: Implement the service**

Create `apps/api/src/services/support/support.service.ts`:

```ts
import prisma from '../../lib/prisma'
import type {
    SupportConversation,
    SupportConversationWithMessages,
    SupportMessage,
    SupportSenderRole,
} from '@world-bingo/shared-types'
import {
    ConversationNotFoundError,
    NotParticipantError,
    StaleConversationError,
} from './errors'

/** How much history the widget and the inbox load on open. */
const HISTORY_LIMIT = 100

/** Statuses that count as "live" — exactly the set the partial unique index
 *  covers, so this constant and the migration must not drift apart. Exported so
 *  tests assert against it rather than against a second copy of the same list. */
export const LIVE_STATUSES = ['BOT', 'OPEN', 'ASSIGNED'] as const

export interface AddMessageInput {
    conversationId: string
    senderRole: SupportSenderRole
    senderId: string | null
    body: string
    attachmentUrl?: string | null
    attachmentMime?: string | null
}

type ConversationRow = {
    id: string
    userId: string
    status: string
    assignedToId: string | null
    assignedTo?: { username: string } | null
    language: string
    escalatedAt: Date | null
    resolvedAt: Date | null
    lastMessageAt: Date
    createdAt: Date
}

type MessageRow = {
    id: string
    conversationId: string
    senderRole: string
    senderId: string | null
    body: string
    attachmentUrl: string | null
    attachmentMime: string | null
    createdAt: Date
}

function toWireConversation(row: ConversationRow): SupportConversation {
    return {
        id: row.id,
        userId: row.userId,
        status: row.status as SupportConversation['status'],
        assignedToId: row.assignedToId,
        assignedToUsername: row.assignedTo?.username ?? null,
        language: row.language,
        escalatedAt: row.escalatedAt?.toISOString() ?? null,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        lastMessageAt: row.lastMessageAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
    }
}

function toWireMessage(row: MessageRow): SupportMessage {
    return {
        id: row.id,
        conversationId: row.conversationId,
        senderRole: row.senderRole as SupportSenderRole,
        senderId: row.senderId,
        body: row.body,
        attachmentUrl: row.attachmentUrl,
        attachmentMime: row.attachmentMime,
        createdAt: row.createdAt.toISOString(),
    }
}

export class SupportService {
    /**
     * Fetch the caller's live thread, creating one if they have none.
     *
     * New threads start OPEN while SUPPORT_AI_ENABLED is false. Phase 2 flips the
     * initial status to BOT so the AI answers first.
     */
    static async openForUser(userId: string): Promise<SupportConversationWithMessages> {
        const existing = await prisma.supportConversation.findFirst({
            where: { userId, status: { in: LIVE_STATUSES as unknown as string[] } },
            include: { assignedTo: { select: { username: true } } },
            orderBy: { lastMessageAt: 'desc' },
        })

        if (existing) return this.withHistory(existing as ConversationRow)

        const initialStatus = process.env.SUPPORT_AI_ENABLED === 'true' ? 'BOT' : 'OPEN'

        try {
            const created = await prisma.supportConversation.create({
                data: {
                    userId,
                    status: initialStatus as never,
                    escalatedAt: initialStatus === 'OPEN' ? new Date() : null,
                    lastMessageAt: new Date(),
                },
                include: { assignedTo: { select: { username: true } } },
            })
            return this.withHistory(created as ConversationRow)
        } catch (err) {
            // Two taps raced and this one lost the partial unique index. The other
            // insert already made a thread — read it rather than failing the click.
            if ((err as { code?: string })?.code !== 'P2002') throw err

            const winner = await prisma.supportConversation.findFirst({
                where: { userId, status: { in: LIVE_STATUSES as unknown as string[] } },
                include: { assignedTo: { select: { username: true } } },
                orderBy: { lastMessageAt: 'desc' },
            })
            if (!winner) throw err
            return this.withHistory(winner as ConversationRow)
        }
    }

    private static async withHistory(row: ConversationRow): Promise<SupportConversationWithMessages> {
        // Newest-first in the query, reversed for display. Ordering ascending
        // and taking 100 would return the OLDEST 100 messages — on a long or
        // repeatedly-reopened thread that silently hides everything recent,
        // which is the only part anyone needs.
        const messages = await prisma.supportMessage.findMany({
            where: { conversationId: row.id },
            orderBy: { createdAt: 'desc' },
            take: HISTORY_LIMIT,
        })
        return {
            conversation: toWireConversation(row),
            messages: (messages as MessageRow[]).reverse().map(toWireMessage),
        }
    }

    static async getById(conversationId: string): Promise<SupportConversation> {
        const row = await prisma.supportConversation.findUnique({
            where: { id: conversationId },
            include: { assignedTo: { select: { username: true } } },
        })
        if (!row) throw new ConversationNotFoundError()
        return toWireConversation(row as ConversationRow)
    }

    static async assertPlayerOwns(conversationId: string, userId: string): Promise<void> {
        const row = await prisma.supportConversation.findUnique({
            where: { id: conversationId },
            select: { userId: true },
        })
        if (!row) throw new ConversationNotFoundError()
        if (row.userId !== userId) throw new NotParticipantError()
    }

    /**
     * Append a message. A player writing into a RESOLVED thread reopens it to
     * OPEN — never back to BOT, because once a human has answered, routing the
     * follow-up to a bot reads as being brushed off.
     */
    static async addMessage(input: AddMessageInput): Promise<SupportMessage> {
        const body = input.body?.trim() ?? ''
        if (!body && !input.attachmentUrl) {
            throw new Error('Message body is empty')
        }

        const conversation = await prisma.supportConversation.findUnique({
            where: { id: input.conversationId },
        })
        if (!conversation) throw new ConversationNotFoundError()

        const reopening = conversation.status === 'RESOLVED' && input.senderRole === 'PLAYER'

        if (reopening) {
            // Reopening while a newer live thread exists would insert a second
            // live row and trip the partial unique index.
            const newer = await prisma.supportConversation.findFirst({
                where: {
                    userId: conversation.userId,
                    status: { in: LIVE_STATUSES as unknown as string[] },
                },
                select: { id: true },
            })
            if (newer) throw new StaleConversationError()
        }

        const message = await prisma.supportMessage.create({
            data: {
                conversationId: input.conversationId,
                senderRole: input.senderRole as never,
                senderId: input.senderId,
                body,
                attachmentUrl: input.attachmentUrl ?? null,
                attachmentMime: input.attachmentMime ?? null,
            },
        })

        await prisma.supportConversation.update({
            where: { id: input.conversationId },
            data: reopening
                ? {
                      lastMessageAt: new Date(),
                      status: 'OPEN' as never,
                      resolvedAt: null,
                      assignedToId: null,
                      escalatedAt: new Date(),
                  }
                : { lastMessageAt: new Date() },
        })

        return toWireMessage(message as MessageRow)
    }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
pnpm --filter @world-bingo/api test -- src/test/support.service.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/support apps/api/src/test/support.service.test.ts
git commit -m "feat(support): conversation open and message append with reopen semantics"
```

---

## Task 4: Support service — claim, release, resolve

**Files:**
- Modify: `apps/api/src/services/support/support.service.ts`
- Create: `apps/api/src/test/support-claim.test.ts`

**Interfaces:**
- Consumes: `SupportService`, `ConversationNotOpenError` from Task 3.
- Produces:
  - `SupportService.claim(conversationId: string, agentId: string): Promise<SupportConversation>`
  - `SupportService.release(conversationId: string, agentId: string, isAdmin: boolean): Promise<SupportConversation>`
  - `SupportService.resolve(conversationId: string, agentId: string, isAdmin: boolean): Promise<SupportConversation>`
  - `SupportService.escalate(conversationId: string): Promise<SupportConversation>`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/test/support-claim.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
    default: {
        supportConversation: {
            findUnique: vi.fn(),
            updateMany: vi.fn(),
        },
        supportMessage: { findMany: vi.fn() },
    },
}))

import prisma from '../lib/prisma'
import { SupportService } from '../services/support/support.service'
import { ConversationNotOpenError } from '../services/support/errors'

const NOW = new Date('2026-08-22T10:00:00.000Z')

function conversationRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'conv-1',
        userId: 'user-1',
        status: 'ASSIGNED',
        assignedToId: 'clerk-1',
        assignedTo: { username: 'clerk1' },
        language: 'en',
        escalatedAt: NOW,
        resolvedAt: null,
        lastMessageAt: NOW,
        createdAt: NOW,
        ...overrides,
    }
}

describe('SupportService.claim', () => {
    beforeEach(() => vi.clearAllMocks())

    it('claims an OPEN conversation with a status-guarded update', async () => {
        ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
        ;(prisma.supportConversation.findUnique as any).mockResolvedValue(conversationRow())

        const result = await SupportService.claim('conv-1', 'clerk-1')

        expect(prisma.supportConversation.updateMany).toHaveBeenCalledWith({
            where: { id: 'conv-1', status: 'OPEN' },
            data: { status: 'ASSIGNED', assignedToId: 'clerk-1' },
        })
        expect(result.assignedToId).toBe('clerk-1')
        expect(result.status).toBe('ASSIGNED')
    })

    it('throws when the conditional update matches nothing', async () => {
        ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 0 })

        await expect(SupportService.claim('conv-1', 'clerk-2')).rejects.toBeInstanceOf(
            ConversationNotOpenError,
        )
    })

    it('lets exactly one of two concurrent claims win', async () => {
        // The DB serialises the two UPDATEs: the first matches status='OPEN',
        // the second finds the row already ASSIGNED and matches zero rows.
        let firstCall = true
        ;(prisma.supportConversation.updateMany as any).mockImplementation(async () => {
            if (firstCall) {
                firstCall = false
                return { count: 1 }
            }
            return { count: 0 }
        })
        ;(prisma.supportConversation.findUnique as any).mockResolvedValue(conversationRow())

        const results = await Promise.allSettled([
            SupportService.claim('conv-1', 'clerk-1'),
            SupportService.claim('conv-1', 'clerk-2'),
        ])

        const fulfilled = results.filter((r) => r.status === 'fulfilled')
        const rejected = results.filter((r) => r.status === 'rejected')
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
    })
})

describe('SupportService.release', () => {
    beforeEach(() => vi.clearAllMocks())

    it('returns an owned thread to OPEN', async () => {
        ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
        ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
            conversationRow({ status: 'OPEN', assignedToId: null, assignedTo: null }),
        )

        const result = await SupportService.release('conv-1', 'clerk-1', false)

        expect(prisma.supportConversation.updateMany).toHaveBeenCalledWith({
            where: { id: 'conv-1', status: 'ASSIGNED', assignedToId: 'clerk-1' },
            data: { status: 'OPEN', assignedToId: null },
        })
        expect(result.assignedToId).toBeNull()
    })

    it('lets an admin release a thread assigned to someone else', async () => {
        ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
        ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
            conversationRow({ status: 'OPEN', assignedToId: null, assignedTo: null }),
        )

        await SupportService.release('conv-1', 'admin-9', true)

        expect(prisma.supportConversation.updateMany).toHaveBeenCalledWith({
            where: { id: 'conv-1', status: 'ASSIGNED' },
            data: { status: 'OPEN', assignedToId: null },
        })
    })

    it('rejects a clerk releasing a thread they do not hold', async () => {
        ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 0 })

        await expect(SupportService.release('conv-1', 'clerk-2', false)).rejects.toBeInstanceOf(
            ConversationNotOpenError,
        )
    })
})

describe('SupportService.resolve', () => {
    beforeEach(() => vi.clearAllMocks())

    it('resolves an assigned thread held by the caller', async () => {
        ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
        ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
            conversationRow({ status: 'RESOLVED', resolvedAt: NOW }),
        )

        const result = await SupportService.resolve('conv-1', 'clerk-1', false)

        const call = (prisma.supportConversation.updateMany as any).mock.calls[0][0]
        expect(call.where.status).toEqual({ in: ['OPEN', 'ASSIGNED'] })
        expect(call.where.assignedToId).toEqual({ in: ['clerk-1', null] })
        expect(result.status).toBe('RESOLVED')
    })

    it('lets an admin resolve regardless of assignee', async () => {
        ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
        ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
            conversationRow({ status: 'RESOLVED', resolvedAt: NOW }),
        )

        await SupportService.resolve('conv-1', 'admin-9', true)

        const call = (prisma.supportConversation.updateMany as any).mock.calls[0][0]
        expect(call.where.assignedToId).toBeUndefined()
    })
})

describe('SupportService.escalate', () => {
    beforeEach(() => vi.clearAllMocks())

    it('moves a BOT thread to OPEN and stamps escalatedAt', async () => {
        ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 1 })
        ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
            conversationRow({ status: 'OPEN', assignedToId: null, assignedTo: null }),
        )

        const result = await SupportService.escalate('conv-1')

        const call = (prisma.supportConversation.updateMany as any).mock.calls[0][0]
        expect(call.where).toEqual({ id: 'conv-1', status: 'BOT' })
        expect(call.data.status).toBe('OPEN')
        expect(call.data.escalatedAt).toBeInstanceOf(Date)
        expect(result.status).toBe('OPEN')
    })

    it('is idempotent on a thread that is already OPEN', async () => {
        // Phase 1 threads start OPEN, so "Talk to a person" is a no-op here.
        // It must return the thread, not throw.
        ;(prisma.supportConversation.updateMany as any).mockResolvedValue({ count: 0 })
        ;(prisma.supportConversation.findUnique as any).mockResolvedValue(
            conversationRow({ status: 'OPEN', assignedToId: null, assignedTo: null }),
        )

        const result = await SupportService.escalate('conv-1')

        expect(result.status).toBe('OPEN')
    })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
pnpm --filter @world-bingo/api test -- src/test/support-claim.test.ts
```

Expected: FAIL — `SupportService.claim is not a function`.

- [ ] **Step 3: Implement the four methods**

Add to `apps/api/src/services/support/support.service.ts`, inside the `SupportService` class, and add `ConversationNotOpenError` to the import from `./errors`:

```ts
    /**
     * Claim an unassigned thread.
     *
     * The guard lives in the WHERE clause, not in a read-then-write: Postgres
     * serialises the two UPDATEs, so of two clerks pressing Claim at the same
     * instant, exactly one matches a row and the other matches none. Same
     * discipline as the cartela HSETNX reservation and the wallet
     * SELECT FOR UPDATE — no new locking primitive.
     */
    static async claim(conversationId: string, agentId: string): Promise<SupportConversation> {
        const { count } = await prisma.supportConversation.updateMany({
            where: { id: conversationId, status: 'OPEN' as never },
            data: { status: 'ASSIGNED' as never, assignedToId: agentId },
        })
        if (count === 0) throw new ConversationNotOpenError()
        return this.getById(conversationId)
    }

    /** Hand an assigned thread back to the queue. Admins may release any thread. */
    static async release(
        conversationId: string,
        agentId: string,
        isAdmin: boolean,
    ): Promise<SupportConversation> {
        const where = isAdmin
            ? { id: conversationId, status: 'ASSIGNED' as never }
            : { id: conversationId, status: 'ASSIGNED' as never, assignedToId: agentId }

        const { count } = await prisma.supportConversation.updateMany({
            where,
            data: { status: 'OPEN' as never, assignedToId: null },
        })
        if (count === 0) throw new ConversationNotOpenError()
        return this.getById(conversationId)
    }

    /**
     * Close a thread. A clerk may resolve one they hold or one nobody holds;
     * an admin may resolve any.
     */
    static async resolve(
        conversationId: string,
        agentId: string,
        isAdmin: boolean,
    ): Promise<SupportConversation> {
        const where: Record<string, unknown> = {
            id: conversationId,
            status: { in: ['OPEN', 'ASSIGNED'] },
        }
        if (!isAdmin) where.assignedToId = { in: [agentId, null] }

        const { count } = await prisma.supportConversation.updateMany({
            where: where as never,
            data: { status: 'RESOLVED' as never, resolvedAt: new Date() },
        })
        if (count === 0) throw new ConversationNotOpenError()
        return this.getById(conversationId)
    }

    /**
     * Move a BOT thread into the human queue. Idempotent: a thread already in
     * OPEN or ASSIGNED is returned unchanged rather than erroring, because in
     * Phase 1 every thread starts OPEN and the player's "Talk to a person"
     * button is still visible.
     */
    static async escalate(conversationId: string): Promise<SupportConversation> {
        await prisma.supportConversation.updateMany({
            where: { id: conversationId, status: 'BOT' as never },
            data: { status: 'OPEN' as never, escalatedAt: new Date() },
        })
        return this.getById(conversationId)
    }
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
pnpm --filter @world-bingo/api test -- src/test/support-claim.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/support/support.service.ts apps/api/src/test/support-claim.test.ts
git commit -m "feat(support): atomic claim, release, resolve and escalate"
```

---

## Task 5: Support service — agent queue and read receipts

**Files:**
- Modify: `apps/api/src/services/support/support.service.ts`
- Modify: `apps/api/src/test/support.service.test.ts`

**Interfaces:**
- Consumes: Task 3 and Task 4 methods.
- Produces:
  - `SupportService.listQueue(filter: 'unassigned' | 'mine' | 'all' | 'resolved', agentId: string): Promise<SupportQueueItem[]>`
  - `SupportService.getForAgent(conversationId: string): Promise<SupportConversationWithMessages>`
  - `SupportService.markReadByAgent(conversationId: string): Promise<void>`
  - `SupportService.markReadByPlayer(conversationId: string): Promise<void>`
  - `SupportService.unassignedCount(): Promise<number>`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/test/support.service.test.ts`. Extend the `vi.mock` factory at the top of that file first — `listQueue` calls `findMany` and `unassignedCount` calls `count`, and neither is in Task 3's factory, so the tests fail at the mock before they reach the assertion. The `supportConversation` block must end up as:

```ts
        supportConversation: {
            findFirst: vi.fn(),
            findUnique: vi.fn(),
            findMany: vi.fn(),
            count: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
            updateMany: vi.fn(),
        },
        supportMessage: {
            create: vi.fn(),
            findMany: vi.fn(),
            updateMany: vi.fn(),
        },
```

Then append:

```ts
describe('SupportService.listQueue', () => {
    beforeEach(() => vi.clearAllMocks())

    it('unassigned filter asks only for OPEN threads with no assignee', async () => {
        ;(prisma.supportConversation.findMany as any).mockResolvedValue([])
        await SupportService.listQueue('unassigned', 'clerk-1')

        const call = (prisma.supportConversation.findMany as any).mock.calls[0][0]
        expect(call.where).toEqual({ status: 'OPEN', assignedToId: null })
        expect(call.orderBy).toEqual({ lastMessageAt: 'desc' })
    })

    it('mine filter scopes to the calling agent', async () => {
        ;(prisma.supportConversation.findMany as any).mockResolvedValue([])
        await SupportService.listQueue('mine', 'clerk-1')

        const call = (prisma.supportConversation.findMany as any).mock.calls[0][0]
        expect(call.where).toEqual({ status: 'ASSIGNED', assignedToId: 'clerk-1' })
    })

    it('all filter covers exactly the live statuses, sourced from LIVE_STATUSES', async () => {
        ;(prisma.supportConversation.findMany as any).mockResolvedValue([])
        await SupportService.listQueue('all', 'clerk-1')

        const call = (prisma.supportConversation.findMany as any).mock.calls[0][0]
        // Asserted against the constant, not a copy of it. The DB's partial unique
        // index is `WHERE status <> 'RESOLVED'`; if this filter kept its own literal
        // list, adding a status would silently drop it from the "all" queue.
        expect(call.where).toEqual({ status: { in: LIVE_STATUSES } })
        expect(LIVE_STATUSES).not.toContain('RESOLVED')
    })

    it('maps a row into a queue item with a preview and unread count', async () => {
        ;(prisma.supportConversation.findMany as any).mockResolvedValue([
            {
                ...conversationRow(),
                user: { username: 'abebe' },
                assignedTo: null,
                messages: [
                    {
                        id: 'm1',
                        conversationId: 'conv-1',
                        senderRole: 'PLAYER',
                        senderId: 'user-1',
                        body: 'my deposit is missing and I want it back today please',
                        attachmentUrl: null,
                        attachmentMime: null,
                        createdAt: NOW,
                    },
                ],
                _count: { messages: 3 },
            },
        ])

        const [item] = await SupportService.listQueue('unassigned', 'clerk-1')

        expect(item.username).toBe('abebe')
        expect(item.lastMessagePreview.length).toBeLessThanOrEqual(80)
        expect(item.unreadForAgent).toBe(3)
    })
})

describe('SupportService.markReadByAgent', () => {
    beforeEach(() => vi.clearAllMocks())

    it('stamps only unread PLAYER messages', async () => {
        ;(prisma.supportMessage.updateMany as any).mockResolvedValue({ count: 2 })

        await SupportService.markReadByAgent('conv-1')

        expect(prisma.supportMessage.updateMany).toHaveBeenCalledWith({
            where: { conversationId: 'conv-1', senderRole: 'PLAYER', readByAgentAt: null },
            data: { readByAgentAt: expect.any(Date) },
        })
    })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
pnpm --filter @world-bingo/api test -- src/test/support.service.test.ts
```

Expected: FAIL — `SupportService.listQueue is not a function`.

- [ ] **Step 3: Implement**

Add `SupportQueueItem` to the type import at the top of `support.service.ts`, then add these methods to the class:

```ts
    /** Longest preview the inbox list renders before truncating. */
    private static readonly PREVIEW_CHARS = 80

    static async listQueue(
        filter: 'unassigned' | 'mine' | 'all' | 'resolved',
        agentId: string,
    ): Promise<SupportQueueItem[]> {
        const where =
            filter === 'unassigned'
                ? { status: 'OPEN', assignedToId: null }
                : filter === 'mine'
                  ? { status: 'ASSIGNED', assignedToId: agentId }
                  : filter === 'resolved'
                    ? { status: 'RESOLVED' }
                    : { status: { in: LIVE_STATUSES } }

        const rows = await prisma.supportConversation.findMany({
            where: where as never,
            orderBy: { lastMessageAt: 'desc' },
            take: 100,
            include: {
                user: { select: { username: true } },
                assignedTo: { select: { username: true } },
                messages: { orderBy: { createdAt: 'desc' }, take: 1 },
                _count: {
                    select: {
                        messages: { where: { senderRole: 'PLAYER', readByAgentAt: null } },
                    },
                },
            },
        })

        return (rows as never[]).map((row: never) => {
            const r = row as unknown as ConversationRow & {
                user: { username: string }
                messages: MessageRow[]
                _count: { messages: number }
            }
            const last = r.messages[0]
            const preview = last
                ? last.body.slice(0, this.PREVIEW_CHARS)
                : ''
            return {
                id: r.id,
                userId: r.userId,
                username: r.user.username,
                status: r.status as SupportQueueItem['status'],
                assignedToId: r.assignedToId,
                assignedToUsername: r.assignedTo?.username ?? null,
                lastMessageAt: r.lastMessageAt.toISOString(),
                lastMessagePreview: preview,
                unreadForAgent: r._count.messages,
            }
        })
    }

    static async getForAgent(conversationId: string): Promise<SupportConversationWithMessages> {
        const row = await prisma.supportConversation.findUnique({
            where: { id: conversationId },
            include: { assignedTo: { select: { username: true } } },
        })
        if (!row) throw new ConversationNotFoundError()
        return this.withHistory(row as ConversationRow)
    }

    /** Called when an agent opens a thread. Only player messages can be unread
     *  for an agent, so the filter keeps the write narrow. */
    static async markReadByAgent(conversationId: string): Promise<void> {
        await prisma.supportMessage.updateMany({
            where: { conversationId, senderRole: 'PLAYER' as never, readByAgentAt: null },
            data: { readByAgentAt: new Date() },
        })
    }

    static async markReadByPlayer(conversationId: string): Promise<void> {
        await prisma.supportMessage.updateMany({
            where: {
                conversationId,
                senderRole: { in: ['AGENT', 'AI', 'SYSTEM'] as never },
                readByPlayerAt: null,
            },
            data: { readByPlayerAt: new Date() },
        })
    }

    /** Badge count for the agent inbox. */
    static async unassignedCount(): Promise<number> {
        return prisma.supportConversation.count({
            where: { status: 'OPEN' as never, assignedToId: null },
        })
    }
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
pnpm --filter @world-bingo/api test -- src/test/support.service.test.ts
```

Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/support/support.service.ts apps/api/src/test/support.service.test.ts
git commit -m "feat(support): agent queue listing and read receipts"
```

---

## Task 6: Redis agent presence and message rate limiting

**Files:**
- Create: `apps/api/src/services/support/support-presence.ts`
- Create: `apps/api/src/services/support/support-rate-limit.ts`
- Create: `apps/api/src/test/support-rate-limit.test.ts`

**Interfaces:**
- Consumes: the default export of `apps/api/src/lib/redis.ts` (an ioredis client).
- Produces:
  - `SupportPresence.markOnline(agentId: string): Promise<void>`
  - `SupportPresence.markOffline(agentId: string): Promise<void>`
  - `SupportPresence.anyOnline(): Promise<boolean>`
  - `SupportRateLimit.checkMessage(userId: string): Promise<boolean>` — `true` means allowed
  - `MESSAGES_PER_MINUTE` constant, value `20`

- [ ] **Step 1: Write the presence module**

Create `apps/api/src/services/support/support-presence.ts`:

```ts
import redis from '../../lib/redis'

/** Set of staff user ids with a live support socket, across all API instances. */
const KEY = 'support:agents:online'

export class SupportPresence {
    static async markOnline(agentId: string): Promise<void> {
        await redis.sadd(KEY, agentId)
    }

    static async markOffline(agentId: string): Promise<void> {
        await redis.srem(KEY, agentId)
    }

    /**
     * Whether anyone is on shift. Drives the contact fallback: escalating with
     * nobody online must hand the player a phone number, not silence.
     */
    static async anyOnline(): Promise<boolean> {
        return (await redis.scard(KEY)) > 0
    }
}
```

- [ ] **Step 2: Write the failing rate-limit tests**

Create `apps/api/src/test/support-rate-limit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/redis', () => ({
    default: {
        incr: vi.fn(),
        expire: vi.fn(),
    },
}))

import redis from '../lib/redis'
import { SupportRateLimit, MESSAGES_PER_MINUTE } from '../services/support/support-rate-limit'

describe('SupportRateLimit.checkMessage', () => {
    beforeEach(() => vi.clearAllMocks())

    it('allows the first message and sets a TTL on the fresh counter', async () => {
        ;(redis.incr as any).mockResolvedValue(1)

        const allowed = await SupportRateLimit.checkMessage('user-1')

        expect(allowed).toBe(true)
        expect(redis.expire).toHaveBeenCalledWith(expect.stringContaining('support:msg:user-1:'), 60)
    })

    it('does not reset the TTL on subsequent messages', async () => {
        ;(redis.incr as any).mockResolvedValue(5)

        await SupportRateLimit.checkMessage('user-1')

        expect(redis.expire).not.toHaveBeenCalled()
    })

    it('allows exactly up to the limit', async () => {
        ;(redis.incr as any).mockResolvedValue(MESSAGES_PER_MINUTE)
        expect(await SupportRateLimit.checkMessage('user-1')).toBe(true)
    })

    it('blocks one past the limit', async () => {
        ;(redis.incr as any).mockResolvedValue(MESSAGES_PER_MINUTE + 1)
        expect(await SupportRateLimit.checkMessage('user-1')).toBe(false)
    })

    it('fails open when Redis is unreachable', async () => {
        // A support widget that goes silent because Redis blipped is worse than
        // a missing rate limit for one minute.
        ;(redis.incr as any).mockRejectedValue(new Error('ECONNREFUSED'))
        expect(await SupportRateLimit.checkMessage('user-1')).toBe(true)
    })
})
```

- [ ] **Step 3: Run and confirm failure**

```bash
pnpm --filter @world-bingo/api test -- src/test/support-rate-limit.test.ts
```

Expected: FAIL — cannot resolve `../services/support/support-rate-limit`.

- [ ] **Step 4: Implement the rate limiter**

Create `apps/api/src/services/support/support-rate-limit.ts`:

```ts
import redis from '../../lib/redis'

/** The Fastify rate-limit plugin is per-route and does not see socket traffic,
 *  so support messages need their own counter. */
export const MESSAGES_PER_MINUTE = 20

export class SupportRateLimit {
    /** Returns true when the message is allowed. */
    static async checkMessage(userId: string): Promise<boolean> {
        const minute = Math.floor(Date.now() / 60_000)
        const key = `support:msg:${userId}:${minute}`

        try {
            const count = await redis.incr(key)
            // Only the first increment needs a TTL — re-setting it on every
            // message would slide the window forward and never expire the key.
            if (count === 1) await redis.expire(key, 60)
            return count <= MESSAGES_PER_MINUTE
        } catch {
            // Fail open. A widget that goes silent because Redis blipped is a
            // worse outcome than an unenforced limit for one minute.
            return true
        }
    }
}
```

- [ ] **Step 5: Run and confirm passing**

```bash
pnpm --filter @world-bingo/api test -- src/test/support-rate-limit.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/support apps/api/src/test/support-rate-limit.test.ts
git commit -m "feat(support): agent presence set and per-user message rate limit"
```

---

## Task 7: Contact fallback configuration

**Files:**
- Modify: `apps/api/src/routes/settings/index.ts`
- Create: `apps/api/src/services/support/support-contact.ts`

**Interfaces:**
- Consumes: `SupportContactInfo` from Task 2.
- Produces:
  - `SupportContact.get(): Promise<SupportContactInfo>`
  - `GET /settings/support` — public, returns `SupportContactInfo`
  - `PUT /settings/support` — admin, accepts `{ support_phone?, support_telegram?, support_hours? }`

- [ ] **Step 1: Add the default keys**

In `apps/api/src/routes/settings/index.ts`, add to the `DEFAULTS` map:

```ts
    support_phone: '',
    support_telegram: '',
    support_hours: '',
```

- [ ] **Step 2: Write the contact reader**

Create `apps/api/src/services/support/support-contact.ts`:

```ts
import prisma from '../../lib/prisma'
import type { SupportContactInfo } from '@world-bingo/shared-types'

const KEYS = ['support_phone', 'support_telegram', 'support_hours'] as const

export class SupportContact {
    /**
     * Real-world contact details, shown whenever chat cannot help: no agent
     * online, or a thread left waiting. Empty strings are valid — the widget
     * hides a channel that has not been configured.
     */
    static async get(): Promise<SupportContactInfo> {
        const rows = await prisma.siteSetting.findMany({ where: { key: { in: [...KEYS] } } })
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]))
        return {
            phone: map.support_phone ?? '',
            telegram: map.support_telegram ?? '',
            hours: map.support_hours ?? '',
        }
    }
}
```

- [ ] **Step 3: Add the two routes**

In `apps/api/src/routes/settings/index.ts`, import the service at the top:

```ts
import { SupportContact } from '../../services/support/support-contact'
```

and add both routes inside `settingsRoutes`:

```ts
    // ── Public: GET /settings/support ───────────────────────────────────────
    // No auth — the widget renders these in its footer for signed-out visitors too.
    fastify.get('/support', async (_req, reply) => {
        await ensureDefaults()
        reply.header('Cache-Control', 'public, max-age=60')
        return SupportContact.get()
    })

    // ── Admin: PUT /settings/support ────────────────────────────────────────
    fastify.put('/support', { preValidation: [fastify.requireAdmin] }, async (req) => {
        const body = (req.body ?? {}) as {
            support_phone?: string
            support_telegram?: string
            support_hours?: string
        }
        const updates: Record<string, string> = {}
        if (body.support_phone !== undefined) updates.support_phone = String(body.support_phone).trim()
        if (body.support_telegram !== undefined) updates.support_telegram = String(body.support_telegram).trim()
        if (body.support_hours !== undefined) updates.support_hours = String(body.support_hours).trim()

        for (const [key, value] of Object.entries(updates)) {
            await prisma.siteSetting.upsert({ where: { key }, update: { value }, create: { key, value } })
        }
        return SupportContact.get()
    })
```

- [ ] **Step 4: Verify by hand**

Start the API and check the public route responds with three empty strings:

```bash
curl -s http://localhost:8080/settings/support
```

Expected: `{"phone":"","telegram":"","hours":""}`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/settings/index.ts apps/api/src/services/support/support-contact.ts
git commit -m "feat(support): configurable phone and telegram contact fallback"
```

---

## Task 8: Support socket gateway

**Files:**
- Create: `apps/api/src/gateways/support.gateway.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Consumes: `SupportService` (Tasks 3–5), `SupportPresence` and `SupportRateLimit` (Task 6), `SupportContact` (Task 7), `NotificationService.create` from `apps/api/src/services/notification.service.ts`, the socket events from Task 2.
- Produces: `registerSupportHandlers(io: Server): void`, exported from `apps/api/src/gateways/support.gateway.ts`.

- [ ] **Step 1: Write the gateway**

Create `apps/api/src/gateways/support.gateway.ts`:

```ts
import { Socket } from 'socket.io'
import jwt from 'jsonwebtoken'
import {
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData,
} from '@world-bingo/shared-types'
import { jwtPublicKey } from '../lib/jwt-keys.js'
import { SupportService } from '../services/support/support.service.js'
import { SupportPresence } from '../services/support/support-presence.js'
import { SupportRateLimit } from '../services/support/support-rate-limit.js'
import { SupportContact } from '../services/support/support-contact.js'
import { SupportError } from '../services/support/errors.js'
import { NotificationService } from '../services/notification.service.js'

type SupportSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>

const AGENTS_ROOM = 'support:agents'
const STAFF_ROLES = new Set(['CLERK', 'ADMIN', 'SUPER_ADMIN'])
const ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN'])

const convRoom = (conversationId: string) => `support:conv:${conversationId}`

export function registerSupportHandlers(io: any) {
    /** Every support event needs a real identity — unlike the game gateway,
     *  which tolerates anonymous spectators. */
    function actor(socket: SupportSocket): { userId: string; role: string } | null {
        const userId = socket.data?.userId
        if (!userId) {
            socket.emit('support:error', {
                code: 'SUPPORT_UNAUTHENTICATED',
                message: 'Sign in to use support chat',
            })
            return null
        }
        return { userId, role: socket.data.role ?? 'PLAYER' }
    }

    function staffActor(socket: SupportSocket): { userId: string; role: string } | null {
        const who = actor(socket)
        if (!who) return null
        if (!STAFF_ROLES.has(who.role)) {
            socket.emit('support:error', {
                code: 'SUPPORT_FORBIDDEN',
                message: 'Staff only',
            })
            return null
        }
        return who
    }

    /** Service errors carry a client-safe code; anything else is a bug and
     *  becomes a generic message so internals never reach a player. */
    function fail(socket: SupportSocket, conversationId: string | undefined, err: unknown) {
        if (err instanceof SupportError) {
            socket.emit('support:error', { conversationId, code: err.code, message: err.message })
            return
        }
        console.error('[support.gateway]', err)
        socket.emit('support:error', {
            conversationId,
            code: 'SUPPORT_ERROR',
            message: 'Something went wrong',
        })
    }

    async function broadcastQueue(conversationId: string) {
        const unassignedCount = await SupportService.unassignedCount()
        io.to(AGENTS_ROOM).emit('support:queue-update', { conversationId, unassignedCount })
    }

    io.on('connection', async (socket: SupportSocket) => {
        // The game gateway already decodes this token, but gateway registration
        // order is not guaranteed, so decode independently rather than depending
        // on another handler having run first.
        const token = socket.handshake.auth?.token
        if (token) {
            try {
                // The access token carries only { id, role } — see
                // controllers/auth.controller.ts. There is no username claim, so
                // anything needing a display name resolves it from the database.
                const user = jwt.verify(token, jwtPublicKey, { algorithms: ['RS256'] }) as {
                    id: string
                    role: string
                }
                socket.data.userId = user.id
                socket.data.role = user.role
            } catch {
                // Leave socket.data empty; every support handler rejects it.
            }
        }

        const isStaff = STAFF_ROLES.has(socket.data?.role ?? '')
        if (isStaff && socket.data.userId) {
            socket.join(AGENTS_ROOM)
            await SupportPresence.markOnline(socket.data.userId)
        }

        // ── Player: open or create the live thread ───────────────────────────
        socket.on('support:open', async () => {
            const who = actor(socket)
            if (!who) return
            try {
                const thread = await SupportService.openForUser(who.userId)
                socket.join(convRoom(thread.conversation.id))
                await SupportService.markReadByPlayer(thread.conversation.id)
                socket.emit('support:thread', thread)
            } catch (err) {
                fail(socket, undefined, err)
            }
        })

        // ── Staff: watch a thread from the inbox ─────────────────────────────
        socket.on('support:watch', async ({ conversationId }) => {
            const who = staffActor(socket)
            if (!who) return
            try {
                const thread = await SupportService.getForAgent(conversationId)
                socket.join(convRoom(conversationId))
                await SupportService.markReadByAgent(conversationId)
                socket.emit('support:thread', thread)
            } catch (err) {
                fail(socket, conversationId, err)
            }
        })

        // ── Either side: send a message ──────────────────────────────────────
        socket.on('support:send', async ({ conversationId, body, attachmentUrl, attachmentMime }) => {
            const who = actor(socket)
            if (!who) return

            try {
                const allowed = await SupportRateLimit.checkMessage(who.userId)
                if (!allowed) {
                    socket.emit('support:error', {
                        conversationId,
                        code: 'SUPPORT_RATE_LIMITED',
                        message: 'Too many messages. Wait a moment.',
                    })
                    return
                }

                const staff = STAFF_ROLES.has(who.role)
                if (!staff) await SupportService.assertPlayerOwns(conversationId, who.userId)

                const message = await SupportService.addMessage({
                    conversationId,
                    senderRole: staff ? 'AGENT' : 'PLAYER',
                    senderId: who.userId,
                    body,
                    attachmentUrl,
                    attachmentMime,
                })

                io.to(convRoom(conversationId)).emit('support:message', message)

                const conversation = await SupportService.getById(conversationId)
                io.to(convRoom(conversationId)).emit('support:status', conversation)
                await broadcastQueue(conversationId)

                if (staff) {
                    // A reply nobody is connected to read is a reply that
                    // disappears. Push it into the existing notification rail.
                    const listeners = await io.in(`user:${conversation.userId}`).fetchSockets()
                    if (listeners.length === 0) {
                        await NotificationService.create(
                            conversation.userId,
                            'SUPPORT_REPLY' as never,
                            'Support replied',
                            message.body.slice(0, 140),
                            { conversationId },
                        )
                    }
                }
            } catch (err) {
                fail(socket, conversationId, err)
            }
        })

        // ── Player: ask for a human ──────────────────────────────────────────
        socket.on('support:escalate', async ({ conversationId }) => {
            const who = actor(socket)
            if (!who) return
            try {
                await SupportService.assertPlayerOwns(conversationId, who.userId)
                const conversation = await SupportService.escalate(conversationId)
                io.to(convRoom(conversationId)).emit('support:status', conversation)
                await broadcastQueue(conversationId)

                // Escalating into an empty room must hand over a phone number,
                // not silence.
                if (!(await SupportPresence.anyOnline())) {
                    const contact = await SupportContact.get()
                    socket.emit('support:contact-fallback', { conversationId, ...contact })
                }
            } catch (err) {
                fail(socket, conversationId, err)
            }
        })

        // ── Staff: claim, release, resolve ───────────────────────────────────
        socket.on('support:claim', async ({ conversationId }) => {
            const who = staffActor(socket)
            if (!who) return
            try {
                const conversation = await SupportService.claim(conversationId, who.userId)
                socket.join(convRoom(conversationId))
                io.to(convRoom(conversationId)).emit('support:status', conversation)
                await broadcastQueue(conversationId)
            } catch (err) {
                fail(socket, conversationId, err)
            }
        })

        socket.on('support:release', async ({ conversationId }) => {
            const who = staffActor(socket)
            if (!who) return
            try {
                const conversation = await SupportService.release(
                    conversationId,
                    who.userId,
                    ADMIN_ROLES.has(who.role),
                )
                io.to(convRoom(conversationId)).emit('support:status', conversation)
                await broadcastQueue(conversationId)
            } catch (err) {
                fail(socket, conversationId, err)
            }
        })

        socket.on('support:resolve', async ({ conversationId }) => {
            const who = staffActor(socket)
            if (!who) return
            try {
                const conversation = await SupportService.resolve(
                    conversationId,
                    who.userId,
                    ADMIN_ROLES.has(who.role),
                )
                io.to(convRoom(conversationId)).emit('support:status', conversation)
                await broadcastQueue(conversationId)
            } catch (err) {
                fail(socket, conversationId, err)
            }
        })

        socket.on('support:read', async ({ conversationId }) => {
            const who = actor(socket)
            if (!who) return
            try {
                if (STAFF_ROLES.has(who.role)) {
                    await SupportService.markReadByAgent(conversationId)
                } else {
                    await SupportService.assertPlayerOwns(conversationId, who.userId)
                    await SupportService.markReadByPlayer(conversationId)
                }
            } catch (err) {
                fail(socket, conversationId, err)
            }
        })

        socket.on('disconnect', async () => {
            if (!isStaff || !socket.data.userId) return
            // A clerk with two tabs open is still on shift. Only clear presence
            // when this was their last socket.
            const remaining = await io.in(AGENTS_ROOM).fetchSockets()
            const stillConnected = remaining.some(
                (s: { id: string; data?: { userId?: string } }) =>
                    s.data?.userId === socket.data.userId && s.id !== socket.id,
            )
            if (!stillConnected) await SupportPresence.markOffline(socket.data.userId)
        })
    })
}
```

- [ ] **Step 2: Register the gateway**

In `apps/api/src/index.ts`, add the import beside the existing gateway imports near line 48:

```ts
import { registerSupportHandlers } from './gateways/support.gateway.js'
```

and the registration call after `registerPredictionHandlers(io)` near line 369:

```ts
registerSupportHandlers(io)
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @world-bingo/api typecheck
```

Expected: exits 0. If `socket.data.role` errors, Task 2 Step 3's `SocketData` change was not applied.

- [ ] **Step 4: Smoke test the gateway by hand**

Start infra and the API, then from a browser console on the running web app:

```js
const s = io('http://localhost:8080', { auth: { token: '<a player access token>' } })
s.on('support:thread', (t) => console.log('thread', t))
s.on('support:error', (e) => console.log('error', e))
s.emit('support:open')
```

Expected: a `support:thread` payload with `conversation.status === 'OPEN'` and `messages: []`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/gateways/support.gateway.ts apps/api/src/index.ts
git commit -m "feat(support): socket gateway for player and agent chat events"
```

---

## Task 9: Attachment upload route

**Files:**
- Create: `apps/api/src/routes/support/index.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Consumes: `uploadFile` from `apps/api/src/lib/storage.ts`, `fastify.authenticate` decorator registered at `apps/api/src/index.ts:227`.
- Produces: `POST /support/attachments` returning `{ url: string; mimetype: string }`.

- [ ] **Step 1: Write the route**

Create `apps/api/src/routes/support/index.ts`:

```ts
import { FastifyPluginAsync } from 'fastify'
import { uploadFile } from '../../lib/storage'

const supportRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preValidation', fastify.authenticate)

    // ── POST /support/attachments ───────────────────────────────────────────
    // Deposit receipt screenshots are the highest-value attachment on this
    // platform. Validation, the 5MB cap and the local/GCS/MinIO switch all come
    // from lib/storage — this route adds no second upload path.
    fastify.post('/attachments', async (req, reply) => {
        const part = await (req as any).file()
        if (!part) return reply.status(400).send({ error: 'No file uploaded' })
        try {
            const buffer = await part.toBuffer()
            const result = await uploadFile(buffer, part.filename, part.mimetype)
            return { url: result.url, mimetype: result.mimetype }
        } catch (err: any) {
            return reply.status(400).send({ error: err?.message ?? 'Upload failed' })
        }
    })
}

export default supportRoutes
```

- [ ] **Step 2: Register it**

In `apps/api/src/index.ts`, import beside the other route imports:

```ts
import supportRoutes from './routes/support'
```

and register it beside the others near line 292:

```ts
await server.register(supportRoutes, { prefix: '/support' })
```

- [ ] **Step 3: Verify the auth guard and the size cap**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/support/attachments
```

Expected: `401`.

Then with a valid token and a real image:

```bash
curl -s -X POST http://localhost:8080/support/attachments -H "Authorization: Bearer <token>" -F "file=@logonew.png"
```

Expected: a JSON body with a `url`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/support apps/api/src/index.ts
git commit -m "feat(support): authenticated attachment upload route"
```

---

## Task 10: Web support composable

**Files:**
- Create: `apps/web/composables/useSupport.ts`

**Interfaces:**
- Consumes: `useSocket()` from `apps/web/composables/useSocket.ts`, `useAuth()`, the socket events from Task 2, `GET /settings/support` from Task 7, `POST /support/attachments` from Task 9.
- Produces: `useSupport()` returning `{ isOpen, conversation, messages, contact, showContact, unread, error, sending, toggle, openChat, closeChat, send, escalate, uploadAttachment }`.

- [ ] **Step 1: Write the composable**

Create `apps/web/composables/useSupport.ts`:

```ts
import type {
    SupportConversation,
    SupportConversationWithMessages,
    SupportContactInfo,
    SupportMessage,
} from '@world-bingo/shared-types'

/** How long a thread may sit unanswered before the widget reveals a phone
 *  number. Client-side on purpose: a server sweep would double-fire across
 *  API instances, and the widget already knows escalatedAt. */
const CONTACT_REVEAL_MS = 5 * 60 * 1000

export const useSupport = () => {
    const { socket, connect } = useSocket()
    const auth = useAuth()
    const config = useRuntimeConfig()

    const isOpen = useState('support_is_open', () => false)
    const conversation = useState<SupportConversation | null>('support_conversation', () => null)
    const messages = useState<SupportMessage[]>('support_messages', () => [])
    const contact = useState<SupportContactInfo | null>('support_contact', () => null)
    const showContact = useState('support_show_contact', () => false)
    const unread = useState('support_unread', () => 0)
    const error = useState<string | null>('support_error', () => null)
    const sending = useState('support_sending', () => false)
    const bound = useState('support_bound', () => false)

    let revealTimer: ReturnType<typeof setTimeout> | null = null

    /** Reveal contact details once the thread has waited long enough. Re-armed
     *  on every status change so a claim cancels a pending reveal. */
    const armContactReveal = () => {
        if (revealTimer) clearTimeout(revealTimer)
        revealTimer = null

        const c = conversation.value
        if (!c || c.status !== 'OPEN' || !c.escalatedAt) return

        const waited = Date.now() - new Date(c.escalatedAt).getTime()
        if (waited >= CONTACT_REVEAL_MS) {
            showContact.value = true
            return
        }
        revealTimer = setTimeout(() => {
            showContact.value = true
        }, CONTACT_REVEAL_MS - waited)
    }

    const loadContact = async () => {
        if (contact.value) return
        try {
            contact.value = await $fetch<SupportContactInfo>(`${config.public.apiBase}/settings/support`)
        } catch {
            contact.value = { phone: '', telegram: '', hours: '' }
        }
    }

    const bind = () => {
        if (bound.value || !socket.value) return
        bound.value = true

        socket.value.on('support:thread', (payload: SupportConversationWithMessages) => {
            conversation.value = payload.conversation
            messages.value = payload.messages
            unread.value = 0
            armContactReveal()
        })

        socket.value.on('support:message', (message: SupportMessage) => {
            if (message.conversationId !== conversation.value?.id) return
            messages.value = [...messages.value, message]
            if (!isOpen.value && message.senderRole !== 'PLAYER') unread.value += 1
        })

        socket.value.on('support:status', (updated: SupportConversation) => {
            if (updated.id !== conversation.value?.id) return
            conversation.value = updated
            // A claimed thread is being handled — stop counting down to the
            // phone number.
            if (updated.status === 'ASSIGNED') showContact.value = false
            armContactReveal()
        })

        socket.value.on('support:contact-fallback', (payload) => {
            contact.value = { phone: payload.phone, telegram: payload.telegram, hours: payload.hours }
            showContact.value = true
        })

        socket.value.on('support:error', (payload: { code: string; message: string }) => {
            error.value = payload.message
        })
    }

    const openChat = async () => {
        if (!auth.token) {
            error.value = 'Sign in to chat with support'
            isOpen.value = true
            await loadContact()
            return
        }
        connect()
        bind()
        await loadContact()
        isOpen.value = true
        unread.value = 0
        socket.value?.emit('support:open')
    }

    const closeChat = () => {
        isOpen.value = false
    }

    const toggle = () => (isOpen.value ? closeChat() : openChat())

    const send = (body: string, attachmentUrl?: string, attachmentMime?: string) => {
        const trimmed = body.trim()
        if ((!trimmed && !attachmentUrl) || !conversation.value) return
        error.value = null
        socket.value?.emit('support:send', {
            conversationId: conversation.value.id,
            body: trimmed,
            attachmentUrl,
            attachmentMime,
        })
    }

    const escalate = () => {
        if (!conversation.value) return
        socket.value?.emit('support:escalate', { conversationId: conversation.value.id })
    }

    const uploadAttachment = async (file: File): Promise<{ url: string; mimetype: string } | null> => {
        sending.value = true
        error.value = null
        try {
            const form = new FormData()
            form.append('file', file)
            return await $fetch<{ url: string; mimetype: string }>(
                `${config.public.apiBase}/support/attachments`,
                { method: 'POST', body: form, headers: { Authorization: `Bearer ${auth.token}` } },
            )
        } catch (e: any) {
            error.value = e?.data?.error ?? 'Upload failed'
            return null
        } finally {
            sending.value = false
        }
    }

    return {
        isOpen,
        conversation,
        messages,
        contact,
        showContact,
        unread,
        error,
        sending,
        toggle,
        openChat,
        closeChat,
        send,
        escalate,
        uploadAttachment,
    }
}
```

- [ ] **Step 2: Typecheck the web app**

```bash
pnpm --filter @world-bingo/web typecheck
```

Expected: exits 0. Note the memory entry that admin typecheck is red by default — that applies to `@world-bingo/admin`, not `@world-bingo/web`. If web reports pre-existing unrelated errors, confirm they also appear on `main` before treating them as yours.

- [ ] **Step 3: Commit**

```bash
git add apps/web/composables/useSupport.ts
git commit -m "feat(support): web support composable with client-side contact reveal"
```

---

## Task 11: Web support widget

**Files:**
- Create: `apps/web/components/support/SupportLauncher.vue`
- Create: `apps/web/components/support/SupportPanel.vue`
- Modify: `apps/web/layouts/default.vue`

**Interfaces:**
- Consumes: `useSupport()` from Task 10.
- Produces: the mounted widget. No exported API.

- [ ] **Step 1: Write the launcher**

Create `apps/web/components/support/SupportLauncher.vue`:

```vue
<script setup lang="ts">
const { isOpen, unread, toggle } = useSupport()
</script>

<template>
  <div>
    <button class="sc-launcher" :aria-expanded="isOpen" aria-label="Support chat" @click="toggle">
      <span aria-hidden="true">{{ isOpen ? '✕' : '💬' }}</span>
      <span v-if="unread > 0 && !isOpen" class="sc-badge">{{ unread }}</span>
    </button>
    <SupportPanel v-if="isOpen" />
  </div>
</template>

<style scoped>
.sc-launcher {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 60;
  width: 3.25rem;
  height: 3.25rem;
  border: none;
  border-radius: 50%;
  background: #f59e0b;
  color: #111;
  font-size: 1.35rem;
  cursor: pointer;
  box-shadow: 0 6px 20px rgb(0 0 0 / 35%);
}
.sc-badge {
  position: absolute;
  top: -0.25rem;
  right: -0.25rem;
  min-width: 1.25rem;
  padding: 0 0.3rem;
  border-radius: 999px;
  background: #dc2626;
  color: #fff;
  font-size: 0.72rem;
  line-height: 1.25rem;
}
</style>
```

- [ ] **Step 2: Write the panel**

Create `apps/web/components/support/SupportPanel.vue`:

```vue
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

        <!-- Bodies are interpolated as text, never v-html. -->
        <p v-if="message.body">{{ message.body }}</p>
        <img v-if="message.attachmentUrl" :src="message.attachmentUrl" alt="Attachment" />
      </article>
    </div>

    <div v-if="showContact && contact" class="sc-contact">
      <strong>Need us faster?</strong>
      <a v-if="contact.phone" :href="`tel:${contact.phone}`">{{ contact.phone }}</a>
      <a v-if="contact.telegram" :href="`https://t.me/${contact.telegram.replace('@', '')}`" target="_blank" rel="noopener">
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
        <button type="button" :disabled="sending || !conversation" aria-label="Attach image" @click="pickFile">📎</button>
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
```

- [ ] **Step 3: Mount the widget and fix the dead footer links**

In `apps/web/layouts/default.vue`, add the launcher beside the existing modals near the end of the template:

```vue
    <SupportLauncher />
```

Then replace the two placeholder anchors in the Support footer column (around line 262) so they open the widget instead of navigating nowhere. Add to that file's `<script setup>`:

```ts
const { openChat } = useSupport()
```

and change the markup:

```vue
            <div class="ab-footer-col">
              <h4>Support</h4>
              <a href="#" @click.prevent="openChat">Help Center</a>
              <a href="#" @click.prevent="openChat">Contact Us</a>
              <a href="#">Terms</a>
              <a href="#">Privacy Policy</a>
            </div>
```

- [ ] **Step 4: Verify in the browser**

Start infra, the API, and the web app. Sign in as a player, then:

1. Click the floating button. Expected: the panel opens and shows the empty-state line.
2. Send "test". Expected: the message appears right-aligned and survives a page reload.
3. Attach an image. Expected: it renders inline in the thread.
4. Click "Contact Us" in the footer. Expected: the panel opens.

Check the browser console for errors and the API logs for `[support.gateway]` lines.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/support apps/web/layouts/default.vue
git commit -m "feat(support): player chat widget and live footer contact links"
```

---

## Task 12: Admin inbox socket client

**Files:**
- Modify: `apps/admin/package.json`
- Create: `apps/admin/composables/useSupportInbox.ts`

**Interfaces:**
- Consumes: `useAdminAuth()` for the access token and API base, the socket events from Task 2.
- Produces: `useSupportInbox()` returning `{ queue, filter, active, messages, unassignedCount, error, connectInbox, setFilter, watch: watchThread, claim, release, resolve, reply, refreshQueue }`.

`apps/admin` has no socket client today — the admin app has only ever used REST. This task adds one.

- [ ] **Step 1: Add the dependency**

Add to `apps/admin/package.json` under `dependencies`, matching the version `apps/web` already pins:

```json
        "socket.io-client": "^4.8.0",
```

Then install:

```bash
pnpm install
```

- [ ] **Step 2: Add the REST queue methods**

The queue list loads over REST on page mount and is kept fresh by socket events. Add to the returned object in `apps/admin/composables/useAdminApi.ts`, beside the other grouped sections:

```ts
        // ── Support ───────────────────────────────────────────────────────
        getSupportQueue: (filter: 'unassigned' | 'mine' | 'all' | 'resolved') =>
            apiFetch<import('@world-bingo/shared-types').SupportQueueItem[]>(
                `/admin/support/queue?filter=${filter}`,
            ),
        getSupportContext: (userId: string) =>
            apiFetch<{
                id: string
                serial: number
                username: string
                phone: string
                isActive: boolean
                createdAt: string
                wallet: { realBalance: string; bonusBalance: string } | null
                deposits: Array<{ id: string; amount: string; status: string; createdAt: string }>
                withdrawals: Array<{ id: string; amount: string; status: string; createdAt: string }>
            }>(`/admin/support/context/${userId}`),
        getSupportContact: () =>
            apiFetch<import('@world-bingo/shared-types').SupportContactInfo>('/settings/support'),
        updateSupportContact: (body: {
            support_phone?: string
            support_telegram?: string
            support_hours?: string
        }) => apiFetch('/settings/support', { method: 'PUT', body }),
```

- [ ] **Step 3: Add the queue and context REST routes on the API**

`apps/api/src/routes/admin/index.ts` has **two** plugin scopes, and the difference decides whether support works at all for the people who staff it:

- line 137 — `f.addHook('preValidation', f.requireAdminOrClerk)` — transactions, withdrawals, stats
- line 218 — `f.addHook('preValidation', f.requireAdmin)` — everything else, including `/players/:id` at line 391

`requireAdmin` rejects `CLERK`. Clerks are the primary support agents, so **both** new routes go in the **line 137 `requireAdminOrClerk` scope**, not beside `/players/:id`.

The gateway pushes updates, but the inbox needs an initial list, and the context panel needs the player's financial picture. Add both inside the line-137 scope:

```ts
        f.get('/support/queue', async (req: any) => {
            const filter = (req.query?.filter ?? 'unassigned') as
                | 'unassigned'
                | 'mine'
                | 'all'
                | 'resolved'
            return SupportService.listQueue(filter, req.user.id)
        })

        // A support-scoped projection rather than reusing /admin/players/:id:
        // that route lives in the requireAdmin scope and 403s for the clerks who
        // actually answer support. Widening it would hand clerks the full player
        // record; this returns only what the context panel renders.
        f.get('/support/context/:userId', async (req: any, reply: any) => {
            const userId = req.params.userId
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    serial: true,
                    username: true,
                    phone: true,
                    isActive: true,
                    createdAt: true,
                    wallet: { select: { realBalance: true, bonusBalance: true } },
                },
            })
            if (!user) return reply.status(404).send({ error: 'Player not found' })

            const [deposits, withdrawals] = await Promise.all([
                prisma.transaction.findMany({
                    where: { userId, type: 'DEPOSIT' },
                    orderBy: { createdAt: 'desc' },
                    take: 5,
                    select: { id: true, amount: true, status: true, createdAt: true },
                }),
                prisma.transaction.findMany({
                    where: { userId, type: 'WITHDRAWAL' },
                    orderBy: { createdAt: 'desc' },
                    take: 5,
                    select: { id: true, amount: true, status: true, createdAt: true },
                }),
            ])

            return { ...user, deposits, withdrawals }
        })
```

and import the service at the top of that file (`prisma` is already imported there):

```ts
import { SupportService } from '../../services/support/support.service'
```

- [ ] **Step 4: Write the inbox composable**

Create `apps/admin/composables/useSupportInbox.ts`:

```ts
import { io, type Socket } from 'socket.io-client'
import type {
    SupportConversation,
    SupportConversationWithMessages,
    SupportMessage,
    SupportQueueItem,
} from '@world-bingo/shared-types'

export const useSupportInbox = () => {
    const { accessToken } = useAdminAuth()
    const api = useAdminApi()
    const config = useRuntimeConfig()

    const socket = useState<Socket | null>('support_admin_socket', () => null)
    const queue = useState<SupportQueueItem[]>('support_queue', () => [])
    const filter = useState<'unassigned' | 'mine' | 'all' | 'resolved'>(
        'support_filter',
        () => 'unassigned',
    )
    const active = useState<SupportConversation | null>('support_active', () => null)
    const messages = useState<SupportMessage[]>('support_active_messages', () => [])
    const unassignedCount = useState('support_unassigned_count', () => 0)
    const error = useState<string | null>('support_admin_error', () => null)

    const refreshQueue = async () => {
        try {
            queue.value = await api.getSupportQueue(filter.value)
        } catch (e: any) {
            error.value = e?.data?.error ?? 'Could not load the queue'
        }
    }

    const connectInbox = async () => {
        await refreshQueue()
        if (socket.value?.connected) return

        socket.value = io(config.public.wsUrl as string, {
            auth: { token: accessToken.value },
            transports: ['polling', 'websocket'],
        })

        socket.value.on('support:thread', (payload: SupportConversationWithMessages) => {
            active.value = payload.conversation
            messages.value = payload.messages
        })

        socket.value.on('support:message', (message: SupportMessage) => {
            if (message.conversationId === active.value?.id) {
                messages.value = [...messages.value, message]
            }
            // A message on any thread reorders the list and changes previews.
            refreshQueue()
        })

        socket.value.on('support:status', (conversation: SupportConversation) => {
            if (conversation.id === active.value?.id) active.value = conversation
            refreshQueue()
        })

        socket.value.on('support:queue-update', (payload: { unassignedCount: number }) => {
            unassignedCount.value = payload.unassignedCount
            refreshQueue()
        })

        socket.value.on('support:error', (payload: { message: string }) => {
            error.value = payload.message
        })
    }

    const setFilter = async (next: typeof filter.value) => {
        filter.value = next
        await refreshQueue()
    }

    const watchThread = (conversationId: string) => {
        error.value = null
        socket.value?.emit('support:watch', { conversationId })
    }

    const claim = (conversationId: string) => socket.value?.emit('support:claim', { conversationId })
    const release = (conversationId: string) => socket.value?.emit('support:release', { conversationId })
    const resolve = (conversationId: string) => socket.value?.emit('support:resolve', { conversationId })

    const reply = (body: string) => {
        const trimmed = body.trim()
        if (!trimmed || !active.value) return
        socket.value?.emit('support:send', { conversationId: active.value.id, body: trimmed })
    }

    return {
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
        refreshQueue,
    }
}
```

- [ ] **Step 5: Confirm `wsUrl` exists in the admin runtime config**

```bash
grep -n "wsUrl" apps/admin/nuxt.config.ts apps/web/nuxt.config.ts
```

If `apps/admin/nuxt.config.ts` has no `wsUrl` under `runtimeConfig.public`, add one mirroring the web app's value so the socket has somewhere to connect.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/package.json apps/admin/composables/useSupportInbox.ts apps/admin/composables/useAdminApi.ts apps/api/src/routes/admin/index.ts pnpm-lock.yaml
git commit -m "feat(support): admin inbox socket client and queue endpoint"
```

---

## Task 13: Admin inbox page with player context

**Files:**
- Create: `apps/admin/components/SupportPlayerContext.vue`
- Create: `apps/admin/pages/support.vue`

**Interfaces:**
- Consumes: `useSupportInbox()` from Task 12, and `useAdminApi().getSupportContext(userId)` — the clerk-accessible `GET /admin/support/context/:userId` added in Task 12 Step 3. It does **not** use `getPlayer(id)`: that route sits in the `requireAdmin` scope and 403s for clerks, who are the people staffing support.
- Produces: the `/support` admin page. No exported API.

- [ ] **Step 1: Write the context panel**

Create `apps/admin/components/SupportPlayerContext.vue`:

```vue
<script setup lang="ts">
const props = defineProps<{ userId: string | null }>()
const api = useAdminApi()

const player = ref<any>(null)
const loading = ref(false)

const load = async () => {
  if (!props.userId) {
    player.value = null
    return
  }
  loading.value = true
  try {
    // Clerk-accessible endpoint. getPlayer() would 403 for a CLERK.
    player.value = await api.getSupportContext(props.userId)
  } catch {
    player.value = null
  } finally {
    loading.value = false
  }
}

watch(() => props.userId, load, { immediate: true })

// Deposits and withdrawals are the two questions a support thread is almost
// always actually about, so the endpoint returns them as separate lists.
const deposits = computed(() => player.value?.deposits ?? [])
const withdrawals = computed(() => player.value?.withdrawals ?? [])
</script>

<template>
  <aside class="ctx">
    <p v-if="!userId" class="ctx-empty">Select a conversation.</p>
    <p v-else-if="loading" class="ctx-empty">Loading player…</p>

    <template v-else-if="player">
      <header>
        <strong>{{ player.username }}</strong>
        <small>#{{ player.serial }} · {{ player.phone }}</small>
      </header>

      <section>
        <h4>Balance</h4>
        <p>Real: {{ Number(player.wallet?.realBalance ?? 0).toFixed(2) }} ETB</p>
        <p>Bonus: {{ Number(player.wallet?.bonusBalance ?? 0).toFixed(2) }} ETB</p>
      </section>

      <section>
        <h4>Recent deposits</h4>
        <p v-if="!deposits.length" class="ctx-muted">None</p>
        <p v-for="t in deposits" :key="t.id">
          {{ Number(t.amount).toFixed(2) }} · <span :class="`st-${t.status.toLowerCase()}`">{{ t.status }}</span>
          <small>{{ new Date(t.createdAt).toLocaleString() }}</small>
        </p>
      </section>

      <section>
        <h4>Recent withdrawals</h4>
        <p v-if="!withdrawals.length" class="ctx-muted">None</p>
        <p v-for="t in withdrawals" :key="t.id">
          {{ Number(t.amount).toFixed(2) }} · <span :class="`st-${t.status.toLowerCase()}`">{{ t.status }}</span>
          <small>{{ new Date(t.createdAt).toLocaleString() }}</small>
        </p>
      </section>

      <section>
        <h4>Account</h4>
        <p>Joined {{ new Date(player.createdAt).toLocaleDateString() }}</p>
        <p>{{ player.isActive ? 'Active' : 'Disabled' }}</p>
      </section>
    </template>
  </aside>
</template>

<style scoped>
.ctx {
  padding: 0.9rem;
  border-left: 1px solid var(--color-gray-200, #e5e7eb);
  overflow-y: auto;
  font-size: 0.85rem;
}
.ctx header {
  margin-bottom: 0.75rem;
}
.ctx header small {
  display: block;
  opacity: 0.6;
}
.ctx section {
  margin-bottom: 0.9rem;
}
.ctx h4 {
  margin: 0 0 0.3rem;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.6;
}
.ctx p {
  margin: 0 0 0.2rem;
}
.ctx p small {
  display: block;
  opacity: 0.55;
  font-size: 0.72rem;
}
.ctx-empty,
.ctx-muted {
  opacity: 0.6;
}
.st-pending {
  color: #d97706;
}
.st-approved {
  color: #16a34a;
}
.st-declined {
  color: #dc2626;
}
</style>
```

- [ ] **Step 2: Write the inbox page**

Create `apps/admin/pages/support.vue`:

```vue
<script setup lang="ts">
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
</script>

<template>
  <div class="inbox">
    <!-- Queue -->
    <div class="col queue">
      <div class="filters">
        <button
          v-for="f in FILTERS"
          :key="f"
          :class="{ on: filter === f }"
          @click="setFilter(f)"
        >
          {{ f }}
          <span v-if="f === 'unassigned' && unassignedCount">({{ unassignedCount }})</span>
        </button>
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
          <span>{{ active.status }}</span>
          <span class="actions">
            <button :disabled="active.status !== 'OPEN'" @click="claim(active.id)">Claim</button>
            <button :disabled="active.status !== 'ASSIGNED'" @click="release(active.id)">Release</button>
            <button :disabled="active.status === 'RESOLVED'" @click="resolve(active.id)">Resolve</button>
          </span>
        </header>

        <div ref="listEl" class="msgs">
          <article
            v-for="message in messages"
            :key="message.id"
            :class="`msg ${message.senderRole.toLowerCase()}`"
          >
            <span class="who">{{ message.senderRole }}</span>
            <p v-if="message.body">{{ message.body }}</p>
            <a v-if="message.attachmentUrl" :href="message.attachmentUrl" target="_blank" rel="noopener">
              <img :src="message.attachmentUrl" alt="Attachment" />
            </a>
          </article>
        </div>

        <form class="compose" @submit.prevent="send">
          <input v-model="draft" placeholder="Reply…" />
          <button type="submit">Send</button>
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
  height: calc(100vh - 4rem);
}
.col {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.queue {
  border-right: 1px solid var(--color-gray-200, #e5e7eb);
  overflow-y: auto;
}
.filters {
  display: flex;
  gap: 0.25rem;
  padding: 0.5rem;
}
.filters button {
  flex: 1;
  padding: 0.25rem;
  border: 1px solid transparent;
  border-radius: 0.35rem;
  background: none;
  font-size: 0.72rem;
  text-transform: capitalize;
  cursor: pointer;
}
.filters button.on {
  border-color: #f59e0b;
  color: #b45309;
}
.row {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  width: 100%;
  padding: 0.6rem 0.7rem;
  border: none;
  border-bottom: 1px solid var(--color-gray-100, #f3f4f6);
  background: none;
  text-align: left;
  cursor: pointer;
}
.row.on {
  background: #fffbeb;
}
.row-top {
  display: flex;
  justify-content: space-between;
}
.row-top em {
  font-style: normal;
  background: #dc2626;
  color: #fff;
  border-radius: 999px;
  padding: 0 0.35rem;
  font-size: 0.68rem;
}
.preview,
.meta {
  font-size: 0.75rem;
  opacity: 0.65;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.thread-head {
  display: flex;
  justify-content: space-between;
  padding: 0.6rem 0.8rem;
  border-bottom: 1px solid var(--color-gray-200, #e5e7eb);
  font-size: 0.8rem;
}
.actions button {
  margin-left: 0.35rem;
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--color-gray-300, #d1d5db);
  border-radius: 0.35rem;
  background: none;
  font-size: 0.75rem;
  cursor: pointer;
}
.actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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
  background: var(--color-gray-100, #f3f4f6);
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
.msg.agent {
  align-self: flex-end;
  background: #fef3c7;
}
.msg .who {
  display: block;
  font-size: 0.65rem;
  text-transform: uppercase;
  opacity: 0.55;
}
.msg img {
  max-width: 100%;
  border-radius: 0.35rem;
}
.compose {
  display: flex;
  gap: 0.4rem;
  padding: 0.6rem 0.8rem;
  border-top: 1px solid var(--color-gray-200, #e5e7eb);
}
.compose input {
  flex: 1;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--color-gray-300, #d1d5db);
  border-radius: 0.4rem;
}
.compose button {
  padding: 0.45rem 0.9rem;
  border: none;
  border-radius: 0.4rem;
  background: #f59e0b;
  color: #111;
  cursor: pointer;
}
.empty {
  margin: auto;
  opacity: 0.55;
  font-size: 0.85rem;
}
.err {
  margin: 0;
  padding: 0.4rem 0.8rem;
  background: #fef2f2;
  color: #b91c1c;
  font-size: 0.8rem;
}
</style>
```

- [ ] **Step 3: Add the nav entry**

Find how the admin sidebar lists its pages:

```bash
grep -rn "withdrawals\|money-flow" apps/admin/layouts/ apps/admin/components/ --include="*.vue" | grep -i "nav\|link\|to=" | head
```

Add a `/support` entry alongside the others, following whatever shape that file uses.

- [ ] **Step 4: End-to-end verification**

With infra, API, web and admin all running:

1. As a player in the web app, open the widget and send "my deposit is missing".
2. In the admin app at `/support`, the Unassigned filter shows the thread with the preview and an unread badge.
3. Click it. The right panel shows that player's balance and recent deposits. Repeat this step signed in as a `CLERK`, not just an admin — the context panel and the queue both have to work for clerks, and an access-scope regression shows up nowhere else.
4. Click Claim. Status becomes `ASSIGNED`; the player's widget header updates to "Talking to …".
5. Reply from admin. The message appears in the player's widget without a reload.
6. Open a second admin session and confirm Claim on an already-claimed thread surfaces `SUPPORT_ALREADY_CLAIMED` rather than stealing it.
7. Close the player's browser tab, reply from admin, reopen the player app: the reply is waiting in the notification bell.
8. Click Resolve. The thread moves to the Resolved filter.

- [ ] **Step 5: Run the full check**

```bash
pnpm --filter @world-bingo/api test
```

Expected: PASS, including the pre-existing suites.

```bash
pnpm --filter @world-bingo/api typecheck && pnpm --filter @world-bingo/web typecheck
```

Expected: both exit 0. `@world-bingo/admin` typecheck is red on `main` for unrelated reasons — compare against `main` before attributing failures to this branch, and grep the output for `pages/support.vue`, `SupportPlayerContext.vue`, and `useSupportInbox.ts` specifically.

- [ ] **Step 6: Commit**

```bash
git add apps/admin/pages/support.vue apps/admin/components/SupportPlayerContext.vue apps/admin/layouts
git commit -m "feat(support): agent inbox with claimable queue and player context panel"
```

---

## Task 14: Audit trail for staff conversation actions

**Files:**
- Create: `apps/api/src/services/support/support-audit.ts`
- Modify: `apps/api/src/gateways/support.gateway.ts`
- Create: `apps/api/src/test/support-audit.test.ts`

**Interfaces:**
- Consumes: the `AuditLog` model at `apps/api/prisma/schema.prisma:997`, and the `SocketData` fields `userId` / `username` set in Task 8.
- Produces: `writeSupportAudit(actorId: string, action: string, conversationId: string, detail?: unknown): Promise<void>`.

The existing `writeAudit` helper at `apps/api/src/routes/admin/crm.ts:58` takes a Fastify request. Support actions arrive on a socket, so they need a request-free variant that writes the same table in the same shape.

It takes only an actor id, not a name. The access token carries `{ id, role }` and no username, so — exactly as `actorName()` at `apps/api/src/routes/admin/crm.ts:49` does — the helper resolves the display name from the database. Without that, every actor id in the audit trail is an unresolvable UUID at precisely the moment someone is auditing who did what.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/test/support-audit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/prisma', () => ({
    default: {
        auditLog: { create: vi.fn() },
        user: { findUnique: vi.fn() },
    },
}))

import prisma from '../lib/prisma'
import { writeSupportAudit } from '../services/support/support-audit'

describe('writeSupportAudit', () => {
    beforeEach(() => vi.clearAllMocks())

    it('writes the action, actor and target in the shape the CRM helper uses', async () => {
        ;(prisma.user.findUnique as any).mockResolvedValue({ username: 'clerk1' })
        ;(prisma.auditLog.create as any).mockResolvedValue({})

        await writeSupportAudit('clerk-1', 'support.claim', 'conv-1')

        expect(prisma.auditLog.create).toHaveBeenCalledWith({
            data: {
                action: 'support.claim',
                actorId: 'clerk-1',
                actorName: 'clerk1',
                target: 'conversation:conv-1',
                detail: {},
            },
        })
    })

    it('still records the action when the actor name cannot be resolved', async () => {
        ;(prisma.user.findUnique as any).mockRejectedValue(new Error('db blip'))
        ;(prisma.auditLog.create as any).mockResolvedValue({})

        await writeSupportAudit('clerk-1', 'support.claim', 'conv-1')

        expect((prisma.auditLog.create as any).mock.calls[0][0].data.actorName).toBeNull()
    })

    it('never lets an audit failure reject the action it records', async () => {
        ;(prisma.user.findUnique as any).mockResolvedValue({ username: 'clerk1' })
        ;(prisma.auditLog.create as any).mockRejectedValue(new Error('db down'))

        await expect(writeSupportAudit('clerk-1', 'support.resolve', 'conv-1')).resolves.toBeUndefined()
    })
})
```

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm --filter @world-bingo/api test -- src/test/support-audit.test.ts
```

Expected: FAIL — cannot resolve `../services/support/support-audit`.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/support/support-audit.ts`:

```ts
import prisma from '../../lib/prisma'

/**
 * Append-only trace of privileged support actions.
 *
 * Mirrors writeAudit in routes/admin/crm.ts, minus the Fastify request — these
 * actions arrive on a socket. Auditing must never block the action it records,
 * so every failure is swallowed.
 */
export async function writeSupportAudit(
    actorId: string,
    action: string,
    conversationId: string,
    detail?: unknown,
): Promise<void> {
    // The JWT carries only { id, role }, so the display name comes from the
    // database — same reason actorName() exists in routes/admin/crm.ts. Without
    // it the trail records WHAT happened but not WHO, which is most of the point.
    const actorName = await prisma.user
        .findUnique({ where: { id: actorId }, select: { username: true } })
        .then((u) => u?.username ?? null)
        .catch(() => null)

    await prisma.auditLog
        .create({
            data: {
                action,
                actorId,
                actorName,
                target: `conversation:${conversationId}`,
                detail: (detail ?? {}) as never,
            },
        })
        .catch(() => {
            /* auditing must never block the action it records */
        })
}
```

- [ ] **Step 4: Run and confirm passing**

```bash
pnpm --filter @world-bingo/api test -- src/test/support-audit.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Call it from the three staff handlers**

In `apps/api/src/gateways/support.gateway.ts`, add the import:

```ts
import { writeSupportAudit } from '../services/support/support-audit.js'
```

Then add one call in each staff handler, immediately after the successful service call and before the emits.

In `support:claim`, after `const conversation = await SupportService.claim(...)`:

```ts
                await writeSupportAudit(who.userId, 'support.claim', conversationId)
```

In `support:release`, after `const conversation = await SupportService.release(...)`:

```ts
                await writeSupportAudit(who.userId, 'support.release', conversationId, { forced: ADMIN_ROLES.has(who.role) })
```

In `support:resolve`, after `const conversation = await SupportService.resolve(...)`:

```ts
                await writeSupportAudit(who.userId, 'support.resolve', conversationId)
```

- [ ] **Step 6: Verify a real row lands**

With the stack running, claim a conversation from the admin inbox, then:

```bash
pnpm --filter @world-bingo/api prisma db execute --stdin <<< "SELECT action, \"actorName\", target FROM audit_logs WHERE action LIKE 'support.%' ORDER BY \"createdAt\" DESC LIMIT 5;"
```

Expected: a `support.claim` row naming the clerk and `conversation:<id>`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/support/support-audit.ts apps/api/src/gateways/support.gateway.ts apps/api/src/test/support-audit.test.ts
git commit -m "feat(support): audit trail for claim, release and resolve"
```

---

## Phase 2 — separate plan

The AI layer is deliberately not in this plan. It ships against the interfaces this phase produces — `SupportService.addMessage`, the `BOT` status, and the `language` / `aiTurnCount` / `lowConfidenceStreak` columns created in Task 1 — and gets its own plan once Phase 1 is merged, so its task code can reference what actually got built rather than what was predicted.

Phase 2 scope, from the spec: the `ollama` compose service, `llm.provider.ts`, `language.ts` three-way detection including romanized Amharic, `knowledge.ts` with `romanized_aliases`, `context.ts` server-built player snapshot, `strings.ts` canned per-language messages, `support-ai.service.ts` with the forced-escalation pre-flight and the 0.35 confidence gate, the `support:ai-chunk` streaming path, and the per-hour AI call limit.

## Self-review

Checked against `docs/superpowers/specs/2026-08-22-support-chat-design.md`:

| Spec section | Covered by |
|---|---|
| Data model, partial unique index | Task 1 |
| Status machine, reopen to OPEN | Tasks 3, 4 |
| Atomic claim | Task 4 |
| Transport, rooms, events | Tasks 2, 8 |
| Agent presence | Tasks 6, 8 |
| Real-contact fallback | Tasks 7, 8, 10, 11 |
| Attachments | Task 9 |
| Offline reply notification | Task 8 |
| Rate limits (message counter) | Task 6 |
| Web widget | Tasks 10, 11 |
| Admin inbox + context panel | Tasks 12, 13 |
| Security: per-user authorization, text-only rendering, audit trail | Tasks 8, 11, 13, 14 |
| Testing | Tasks 3, 4, 5, 6, 14 |
| Rollout with `SUPPORT_AI_ENABLED=false` | Task 3 Step 4 |
| AI layer, language handling, KB, AI rate limit | **Phase 2 plan** |

Two spec items are intentionally not implemented here and are recorded rather than dropped:

1. **Server-side 5-minute sweep** — replaced by the client-side reveal in Task 10, because a server interval double-fires across API instances behind the Redis adapter.
2. **`AuditLog` entries for staff conversation actions** — found missing during self-review and added as Task 14 rather than deferred.
