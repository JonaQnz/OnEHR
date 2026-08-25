import { Router } from 'express';
import { requirePermission } from '../middleware/auth';
import { asyncHandler, HttpError } from '../middleware/errorHandler';
import { executeAqlQuery } from '../services/aqlFunctionService';
import { getRemoteWebTemplate } from '../services/ehrbaseService';

/**
 * Direct, unrestricted EHRbase access for design-time/debugging use (the
 * openEHR architect role, IT investigation) - as opposed to the AQL Function
 * system (aqlFunctionService's stored, curated queries) that runtime plugins
 * and forms use. Raw ad-hoc AQL against a real clinical EHRbase is a
 * meaningfully sensitive capability, so this is gated to admins only, unlike
 * the rest of the read-only template/patient endpoints.
 */
const router = Router();
router.use(requirePermission('system.configure'));

router.post('/aql', asyncHandler(async (req, res) => {
  const query = req.body?.query;
  if (typeof query !== 'string' || !query.trim()) throw new HttpError(400, '"query" must be a non-empty AQL string');
  const parameters = req.body?.parameters && typeof req.body.parameters === 'object' && !Array.isArray(req.body.parameters) ? req.body.parameters : {};
  res.json({ rows: await executeAqlQuery(query, parameters) });
}));

router.get('/remote-templates/:templateId', asyncHandler(async (req, res) => {
  const templateId = String(req.params.templateId || '').trim();
  if (!templateId) throw new HttpError(400, 'templateId is required');
  res.json(await getRemoteWebTemplate(templateId));
}));

export default router;
