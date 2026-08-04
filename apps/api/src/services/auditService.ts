import prisma from '../db/prisma';

export async function writeAuditEvent(input: {
  actorUserId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
      action: input.action,
      resourceType: input.resourceType,
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      metadata: (input.metadata || {}) as any,
    },
  });
}
