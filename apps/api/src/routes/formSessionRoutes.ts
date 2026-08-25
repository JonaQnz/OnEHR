import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { requirePermission } from '../middleware/auth';
import { autosaveFormSessionDraft, createFormSession, getFormSession, listFormSessions, loadFormSessionFromProvider, patchFormSession, submitFormSession, submitFormSessionToProvider, validateFormSession, withdrawFormSessionFromProvider } from '../services/formSessionService';

const router = Router();
router.use(requirePermission('form.execute'));

function actor(req: Express.Request): { userId: string; authMode: 'local' | 'hip' } {
  return { userId: req.principal?.userId || 'anonymous', authMode: req.principal?.authSource === 'oidc' ? 'hip' : 'local' };
}

router.get('/', asyncHandler(async (req, res) => {
  const patientId = typeof req.query.patientId === 'string' ? req.query.patientId : undefined;
  const formId = typeof req.query.formId === 'string' ? req.query.formId : undefined;
  res.json(await listFormSessions(actor(req), patientId, formId));
}));

router.post('/', asyncHandler(async (req, res) => {
  const session = await createFormSession(req.body || {}, actor(req));
  res.status(201).json(session);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await getFormSession(String(req.params.id), actor(req)));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  res.json(await patchFormSession(String(req.params.id), req.body || {}, actor(req)));
}));

router.post('/:id/provider/draft', asyncHandler(async (req, res) => {
  const providerId = typeof req.body?.providerId === 'string' ? req.body.providerId : 'ehrbase';
  res.json(await autosaveFormSessionDraft(String(req.params.id), providerId, actor(req), req.body?.values || {}));
}));

router.post('/:id/provider/load', asyncHandler(async (req, res) => {
  const providerId = typeof req.body?.providerId === 'string' ? req.body.providerId : 'ehrbase';
  res.json(await loadFormSessionFromProvider(String(req.params.id), providerId, actor(req)));
}));

router.post('/:id/provider/submit', asyncHandler(async (req, res) => {
  const providerId = typeof req.body?.providerId === 'string' ? req.body.providerId : 'ehrbase';
  res.json(await submitFormSessionToProvider(String(req.params.id), providerId, actor(req), {
    validatedRevision: typeof req.body?.validatedRevision === 'number' ? req.body.validatedRevision : undefined,
    changeType: typeof req.body?.changeType === 'string' ? req.body.changeType : undefined,
    changeDescription: typeof req.body?.changeDescription === 'string' ? req.body.changeDescription : undefined,
  }));
}));

router.post('/:id/provider/withdraw', asyncHandler(async (req, res) => {
  const providerId = typeof req.body?.providerId === 'string' ? req.body.providerId : 'ehrbase';
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
  res.json(await withdrawFormSessionFromProvider(String(req.params.id), providerId, actor(req), reason));
}));

router.post('/:id/validate', asyncHandler(async (req, res) => {
  res.json(await validateFormSession(String(req.params.id), actor(req)));
}));

router.post('/:id/submit', asyncHandler(async (req, res) => {
  res.json(await submitFormSession(String(req.params.id), actor(req)));
}));

export default router;
