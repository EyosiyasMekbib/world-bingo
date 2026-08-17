import prisma from '../lib/prisma.js'

export const ALLOWED_EVENTS = [
    'lobby_view',
    'game_view',
    'join_click',
    'deposit_modal_opened',
    'deposit_method_selected',
    'deposit_amount_entered',
    'deposit_submitted',
    'identify',
    'provider_game_view',
    'provider_game_launched',
    'provider_session_ended',
    // Which lobby surface sends players into the fight markets — the hero slide
    // or the lobby card. Worth separating: it is the only way to tell whether
    // the banner is doing the work or the tab is.
    'hero_predictions_click',
    'lobby_predictions_click',
] as const

export type AllowedEventName = (typeof ALLOWED_EVENTS)[number]

export interface RawEvent {
    name: string
    anonId?: string | null
    sessionId?: string | null
    props?: Record<string, unknown> | null
}

export class EventService {
    static async record(events: RawEvent[], ctx: { userId?: string }): Promise<void> {
        const allowed = events.filter(e =>
            (ALLOWED_EVENTS as readonly string[]).includes(e.name),
        )
        if (!allowed.length) return
        await prisma.analyticsEvent.createMany({
            data: allowed.map(e => ({
                name: e.name,
                anonId: e.anonId ?? null,
                sessionId: e.sessionId ?? null,
                props: (e.props ?? null) as any,
                userId: ctx.userId ?? null,
            })),
            skipDuplicates: true,
        })
    }
}
