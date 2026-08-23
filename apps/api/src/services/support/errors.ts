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
