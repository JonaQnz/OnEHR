import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { requireAuth } from '../middleware/auth';
import { createFormSession, getFormSession, listFormSessions, loadFormSessionFromProvider, patchFormSession, submitFormSession, submitFormSessionToProvider, validateFormSession } from '../services/formSessionService';

const router = Router();
router.use(requireAuth);

function actor(req: Express.Request) {
  return { userId: req.auth?.id || 'anonymous', authMode: req.auth?.authMode || 'local' as const };
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

router.post('/:id/provider/load', asyncHandler(async (req, res) => {
  const providerId = typeof req.body?.providerId === 'string' ? req.body.providerId : 'ehrbase';
  res.json(await loadFormSessionFromProvider(String(req.params.id), providerId, actor(req)));
}));

router.post('/:id/provider/submit', asyncHandler(async (req, res) => {
  const providerId = typeof req.body?.providerId === 'string' ? req.body.providerId : 'ehrbase';
  res.json(await submitFormSessionToProvider(String(req.params.id), providerId, actor(req), { validatedRevision: typeof req.body?.validatedRevision === 'number' ? req.body.validatedRevision : undefined }));
}));

router.post('/:id/validate', asyncHandler(async (req, res) => {
  res.json(await validateFormSession(String(req.params.id), actor(req)));
}));

router.post('/:id/submit', asyncHandler(async (req, res) => {
  res.json(await submitFormSession(String(req.params.id), actor(req)));
}));

export default router;
