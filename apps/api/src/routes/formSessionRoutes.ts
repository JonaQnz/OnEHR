import { Router } from 'express';
import { asyncHandler, HttpError } from '../middleware/errorHandler';
import { requirePermission } from '../middleware/auth';
import { autosaveFormSessionDraft, createFormSession, getFormSession, listFormSessions, loadFormSessionFromProvider, patchFormSession, submitFormSession, submitFormSessionToProvider, validateFormSession, withdrawFormSessionFromProvider } from '../services/formSessionService';
import { getCompositionHistory, getCompositionVersionDetail, getCompositionVersionsForCompare } from '../services/compositionHistoryService';

const router = Router();
router.use(requirePermission('form.execute'));

function actor(req: Express.Request): { userId: string; authMode: 'local' | 'hip' } {
  return { userId: req.principal?.userId || 'anonymous', authMode: req.principal?.authSource === 'oidc' ? 'hip' : 'local' };
}

router.get('/', asyncHandler(async (req, res) => {
  const patientId = typeof req.query.patientId === 'string' ? req.query.patientId : undefined;
  const formId = typeof req.query.formId === 'string' ? req.query.formId : undefined;
  const parentFormId = typeof req.query.parentFormId === 'string' ? req.query.parentFormId : undefined;
  res.json(await listFormSessions(actor(req), patientId, formId, parentFormId));
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

// Epic 3 - Version History, Audit & Semantic Diff. GET, not POST: these are
// read-only, and (unlike the /provider/* actions above) deliberately work
// even on an already-submitted or withdrawn session - viewing what
// happened is never itself an edit.
router.get('/:id/provider/history', asyncHandler(async (req, res) => {
  res.json(await getCompositionHistory(String(req.params.id), actor(req)));
}));

router.get('/:id/provider/history/:versionUid', asyncHandler(async (req, res) => {
  res.json(await getCompositionVersionDetail(String(req.params.id), String(req.params.versionUid), actor(req)));
}));

router.post('/:id/provider/history/compare', asyncHandler(async (req, res) => {
  const fromVersionUid = typeof req.body?.fromVersionUid === 'string' ? req.body.fromVersionUid : '';
  const toVersionUid = typeof req.body?.toVersionUid === 'string' ? req.body.toVersionUid : '';
  if (!fromVersionUid || !toVersionUid) throw new HttpError(400, 'fromVersionUid and toVersionUid are required');
  res.json(await getCompositionVersionsForCompare(String(req.params.id), fromVersionUid, toVersionUid, actor(req)));
}));

router.post('/:id/validate', asyncHandler(async (req, res) => {
  res.json(await validateFormSession(String(req.params.id), actor(req)));
}));

router.post('/:id/submit', asyncHandler(async (req, res) => {
  res.json(await submitFormSession(String(req.params.id), actor(req)));
}));

export default router;
