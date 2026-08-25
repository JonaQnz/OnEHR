import { Router } from 'express';
import { requirePermission } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import { createDataWidget, deleteDataWidget, executeDataWidget, listDataWidgets, updateDataWidget } from '../services/dataWidgetService';
import { resolvePatientReference } from '../services/patientService';
import { getConfig } from '../services/configService';

const router = Router();
router.get('/', requirePermission('form.design'), asyncHandler(async (_req, res) => res.json({ widgets: await listDataWidgets() })));
// A single, safe field out of the full config (which sits behind
// system.configure) - the widget preview needs to know the operator's
// configured "always test against this patient" EHR-ID, but a widget
// designer doesn't need (and shouldn't get) the rest of AppConfig.
router.get('/preview-defaults', requirePermission('form.design'), asyncHandler(async (_req, res) => res.json({ defaultEhrId: getConfig().defaultEhrId || '' })));
router.post('/', requirePermission('form.design'), asyncHandler(async (req, res) => res.status(201).json(await createDataWidget(req.body))));
router.put('/:id', requirePermission('form.design'), asyncHandler(async (req, res) => res.json(await updateDataWidget(String(req.params.id), req.body))));
router.delete('/:id', requirePermission('form.design'), asyncHandler(async (req, res) => { await deleteDataWidget(String(req.params.id)); res.status(204).end(); }));
// Resolve ehrId server-side from the patient record instead of trusting the
// client-supplied value directly - see formRoutes.ts composition-data for why.
router.post('/:id/query', requirePermission('form.execute'), asyncHandler(async (req, res) => {
  const patientId = String(req.body?.patientId || '');
  const requestedNamespace = typeof req.body?.patientNamespace === 'string' && req.body.patientNamespace.trim() ? req.body.patientNamespace.trim() : undefined;
  const patient = patientId ? await resolvePatientReference(patientId, requestedNamespace) : null;
  const ehrId = patient?.ehrId || (typeof req.body?.ehrId === 'string' ? req.body.ehrId : undefined);
  res.json(await executeDataWidget(String(req.params.id), {
    patientId,
    ...(patient?.patientNamespace || requestedNamespace ? { patientNamespace: patient?.patientNamespace || requestedNamespace } : {}),
    ...(ehrId ? { ehrId } : {}),
  }));
}));
export default router;
