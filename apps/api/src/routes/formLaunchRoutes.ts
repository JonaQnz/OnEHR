import { Router } from 'express';
import type { FormLaunchRequest } from 'core';
import { deriveAuthMode, requirePermission } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { launchForm } from '../services/formLaunchService';

const router = Router();
router.use(requirePermission('form.execute'));

router.post('/', asyncHandler(async (req, res) => {
  const actor: { userId: string; authMode: 'local' | 'hip' } = { userId: req.principal?.userId || 'anonymous', authMode: deriveAuthMode(req.principal?.authSource) };
  res.status(201).json(await launchForm((req.body || {}) as FormLaunchRequest, actor));
}));

export default router;
