import { Router } from 'express';
import { deriveAuthMode, requirePermission } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { attachCompositionChild, getCompositionSession, getCompositionSessionsForPatient, removeCompositionInstance, startCompositionSession, validateCompositionSession } from '../services/compositionSessionService';
import { commitClinicalTransaction, getClinicalTransaction, prepareClinicalTransaction } from '../services/clinicalTransactionService';

const router = Router();
router.use(requirePermission('form.execute'));
const actor = (req: Express.Request) => ({ userId: req.principal?.userId || 'anonymous', authMode: deriveAuthMode(req.principal?.authSource) });

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
// Runtime-repeatable (manualAdd) blocks: POST adds one more instance
// alongside any that already exist for this block (never overwrites, unlike
// PUT .../blocks/:blockId above); DELETE detaches a not-yet-submitted one.
router.post('/:id/blocks/:blockId/instances', asyncHandler(async (req, res) => res.status(201).json(await attachCompositionChild(String(req.params.id), String(req.params.blockId), String(req.body?.childSessionId || ''), actor(req), { asNewInstance: true }))));
router.delete('/:id/blocks/:blockId/instances/:childSessionId', asyncHandler(async (req, res) => res.json(await removeCompositionInstance(String(req.params.id), String(req.params.blockId), String(req.params.childSessionId), actor(req)))));
router.post('/:id/validate', asyncHandler(async (req, res) => res.json(await validateCompositionSession(String(req.params.id), actor(req)))));

// Epic 4 - openEHR CONTRIBUTION support: one grouped save across all of a
// composition session's child forms, as a real openEHR Contribution.
// prepare validates every child and stages the transaction; commit actually
// saves it. Split into two calls (rather than one "just save everything")
// so a caller can show per-form validity before committing, exactly like
// validate_composition_session already does for the read-only check.
router.post('/:id/transaction', asyncHandler(async (req, res) => res.status(201).json(await prepareClinicalTransaction(String(req.params.id), actor(req), {
  clientRequestId: typeof req.body?.clientRequestId === 'string' ? req.body.clientRequestId : undefined,
  description: typeof req.body?.description === 'string' ? req.body.description : undefined,
}))));
router.get('/transaction/:transactionId', asyncHandler(async (req, res) => res.json(await getClinicalTransaction(String(req.params.transactionId), actor(req)))));
router.post('/transaction/:transactionId/commit', asyncHandler(async (req, res) => res.json(await commitClinicalTransaction(String(req.params.transactionId), actor(req)))));

export default router;
