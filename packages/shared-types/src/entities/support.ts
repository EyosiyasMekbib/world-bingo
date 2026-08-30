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
    /** Echoed back on the broadcast so the sender can replace its own
     *  optimistic bubble instead of appending a duplicate. Wire-only — it is
     *  not persisted, so it is null on every message read back from the DB. */
    clientMsgId?: string | null
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
