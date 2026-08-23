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
