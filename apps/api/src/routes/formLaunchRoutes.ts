import { Router } from 'express';
import type { FormLaunchRequest } from 'core';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { launchForm } from '../services/formLaunchService';

const router = Router();
router.use(requireAuth);

router.post('/', asyncHandler(async (req, res) => {
  const actor = { userId: req.auth?.id || 'anonymous', authMode: req.auth?.authMode || 'local' as const };
  res.status(201).json(await launchForm((req.body || {}) as FormLaunchRequest, actor));
}));

export default router;
