import { Router } from 'express';
import { requirePermission } from '../middleware/auth';
import { asyncHandler, HttpError } from '../middleware/errorHandler';
import { executeAqlQuery } from '../services/aqlFunctionService';
import { getRemoteTemplateOpt, getRemoteWebTemplate } from '../services/ehrbaseService';
import { createFhirResource, getFhirCdrMetadata, getFhirResource, searchFhirResource } from '../services/fhirCdrService';
import { deleteIntegrationCallLog, getIntegrationCallLog, listIntegrationCallLogs, listIntegrationCallLogsForExport, type IntegrationProtocol } from '../services/integrationCallLogService';
import { streamBrunoExport } from '../services/brunoExportService';

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

router.get('/remote-templates/:templateId/opt', asyncHandler(async (req, res) => {
  const templateId = String(req.params.templateId || '').trim();
  if (!templateId) throw new HttpError(400, 'templateId is required');
  // JSON-wrapped, not a raw application/xml response: every other endpoint on
  // this router (and the MCP/API client that calls it) uniformly expects a
  // JSON body.
  res.json({ templateId, opt: await getRemoteTemplateOpt(templateId) });
}));

// FHIR CDR - separate connector alongside EHRbase. Patient/Encounter live
// here as native FHIR (see fhirCdrService.ts for why). Same admin-only gate
// as the rest of this router: raw FHIR writes against a real CDR are just as
// sensitive as raw AQL against EHRbase.
router.get('/fhir-cdr/metadata', asyncHandler(async (_req, res) => {
  res.json(await getFhirCdrMetadata());
}));

router.post('/fhir-cdr/:resourceType', asyncHandler(async (req, res) => {
  const resourceType = String(req.params.resourceType || '').trim();
  if (!resourceType) throw new HttpError(400, 'resourceType is required');
  if (!req.body || typeof req.body !== 'object') throw new HttpError(400, 'A FHIR resource body is required');
  res.json(await createFhirResource(resourceType, req.body));
}));

router.get('/fhir-cdr/:resourceType/:id', asyncHandler(async (req, res) => {
  const resourceType = String(req.params.resourceType || '').trim();
  const id = String(req.params.id || '').trim();
  if (!resourceType || !id) throw new HttpError(400, 'resourceType and id are required');
  res.json(await getFhirResource(resourceType, id));
}));

router.get('/fhir-cdr/:resourceType', asyncHandler(async (req, res) => {
  const resourceType = String(req.params.resourceType || '').trim();
  if (!resourceType) throw new HttpError(400, 'resourceType is required');
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') query[key] = value;
  }
  res.json(await searchFhirResource(resourceType, query));
}));

// Debug log of every outbound FHIR/openEHR write Forms has made (see
// integrationCallLogService.ts) - lets you list them, inspect one in full,
// or download just its request body as a standalone .json file to build a
// Bruno request from. Same admin-only gate as the rest of this router.
router.get('/call-logs', asyncHandler(async (req, res) => {
  const protocol = typeof req.query.protocol === 'string' ? req.query.protocol as IntegrationProtocol : undefined;
  const resourceType = typeof req.query.resourceType === 'string' ? req.query.resourceType : undefined;
  const success = req.query.success === 'true' ? true : req.query.success === 'false' ? false : undefined;
  const ehrId = typeof req.query.ehrId === 'string' ? req.query.ehrId : undefined;
  const patientId = typeof req.query.patientId === 'string' ? req.query.patientId : undefined;
  const formId = typeof req.query.formId === 'string' ? req.query.formId : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const offset = req.query.offset ? Number(req.query.offset) : undefined;
  res.json({ logs: await listIntegrationCallLogs({ protocol, resourceType, success, ehrId, patientId, formId, limit, offset }) });
}));

// Batch export: every call log matching the given filters, zipped as a
// Bruno request folder (one .bru per call, oldest first) ready to drop
// into an existing Bruno collection. Omit every filter to export
// everything captured so far.
router.get('/call-logs/export/bruno', asyncHandler(async (req, res) => {
  const protocol = typeof req.query.protocol === 'string' ? req.query.protocol as IntegrationProtocol : undefined;
  const resourceType = typeof req.query.resourceType === 'string' ? req.query.resourceType : undefined;
  const success = req.query.success === 'true' ? true : req.query.success === 'false' ? false : undefined;
  const ehrId = typeof req.query.ehrId === 'string' ? req.query.ehrId : undefined;
  const patientId = typeof req.query.patientId === 'string' ? req.query.patientId : undefined;
  const folderName = typeof req.query.folderName === 'string' && req.query.folderName.trim()
    ? req.query.folderName.trim()
    : 'integration-call-logs';
  const logs = await listIntegrationCallLogsForExport({ protocol, resourceType, success, ehrId, patientId });
  if (logs.length === 0) throw new HttpError(404, 'No call logs match the given filters');
  streamBrunoExport(res, logs, folderName);
}));

router.get('/call-logs/:id', asyncHandler(async (req, res) => {
  const log = await getIntegrationCallLog(req.params.id);
  if (!log) throw new HttpError(404, 'Call log not found');
  res.json(log);
}));

// part=request (default) downloads just the request body - the actual
// "single file" you'd paste as a Bruno request body. part=response or
// part=full download the response body / the whole log record instead.
router.get('/call-logs/:id/download', asyncHandler(async (req, res) => {
  const log = await getIntegrationCallLog(req.params.id);
  if (!log) throw new HttpError(404, 'Call log not found');
  const part = typeof req.query.part === 'string' ? req.query.part : 'request';
  const body = part === 'response' ? log.responseBody : part === 'full' ? log : log.requestBody;
  if (body === null || body === undefined) throw new HttpError(404, `This call log has no ${part} body`);
  const stamp = log.createdAt.toISOString().replace(/[:.]/g, '-');
  const filename = `${log.protocol}-${log.resourceType}-${log.operation}-${part}-${stamp}.json`.replace(/[^a-zA-Z0-9._-]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body, null, 2));
}));

router.delete('/call-logs/:id', asyncHandler(async (req, res) => {
  await deleteIntegrationCallLog(req.params.id);
  res.status(204).end();
}));

export default router;
