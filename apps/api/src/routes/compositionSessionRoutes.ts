import { Router } from 'express';
import { requirePermission } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { attachCompositionChild, getCompositionSession, getCompositionSessionsForPatient, startCompositionSession, validateCompositionSession } from '../services/compositionSessionService';

const router = Router();
router.use(requirePermission('form.execute'));
const actor = (req: Express.Request) => ({ userId: req.principal?.userId || 'anonymous', authMode: req.principal?.authSource === 'oidc' ? 'hip' as const : 'local' as const });

router.get('/', asyncHandler(async (req, res) => {
  const patientId = req.query.patientId as string;
  if (!patientId) {
    return res.status(400).json({ error: 'patientId query parameter is required' });
  }
  res.json(await getCompositionSessionsForPatient(patientId, actor(req)));
}));

router.post('/', asyncHandler(async (req, res) => res.status(201).json(await startCompositionSession(req.body || {}, actor(req)))));
router.get('/:id', asyncHandler(async (req, res) => res.json(await getCompositionSession(String(req.params.id), actor(req)))));
router.put('/:id/blocks/:blockId', asyncHandler(async (req, res) => res.json(await attachCompositionChild(String(req.params.id), String(req.params.blockId), String(req.body?.childSessionId || ''), actor(req)))));
router.post('/:id/validate', asyncHandler(async (req, res) => res.json(await validateCompositionSession(String(req.params.id), actor(req)))));
export default router;
