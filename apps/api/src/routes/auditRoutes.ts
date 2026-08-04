import { Router } from 'express';
import prisma from '../db/prisma';
import { requirePermission } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';

const router = Router();

router.use(requirePermission('audit.read'));

router.get('/', asyncHandler(async (_req, res) => {
  const events = await prisma.auditEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true,
      action: true,
      resourceType: true,
      resourceId: true,
      actorUserId: true,
      metadata: true,
      createdAt: true,
    },
  });
  res.json({ events });
}));

export default router;
