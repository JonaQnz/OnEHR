import { Router, type Request, type Response } from 'express';
import { isTerminologyManageError, type TerminologyConcept } from 'core';
import { requirePermission } from '../middleware/auth';
import { asyncHandler, HttpError } from '../middleware/errorHandler';
import { terminologyProviderRegistry } from '../services/terminologyProviderRegistry';
import { writeAuditEvent } from '../services/auditService';

const router = Router();

/**
 * Thin, provider-agnostic dispatcher - this file must never import or know
 * about a concrete backend (HAPI/FHIR or otherwise). It only resolves a
 * `provider` query param through `terminologyProviderRegistry` and calls the
 * neutral `TerminologyProvider` methods (packages/core/terminology). See the
 * "Terminologie-Server-Integration" plan, section E.
 */
function resolveProvider(req: Request, capability: 'search' | 'lookup' | 'validate' | 'discover' | 'manage') {
  const id = typeof req.query.provider === 'string' ? req.query.provider : '';
  if (!id) throw new HttpError(400, 'Query parameter "provider" is required');
  const provider = terminologyProviderRegistry.get(id);
  if (!provider) throw new HttpError(404, `Unknown or unavailable terminology provider: ${id}`, { code: 'unknown-provider' });
  if (!provider.capabilities.includes(capability)) throw new HttpError(404, `Terminology provider ${id} does not support "${capability}"`, { code: 'capability-not-supported' });
  return provider;
}

/**
 * Every `provider.manage!.*` call goes through this - mirrors
 * `formSessionService.ts`'s own `mapProviderError`/`isFormDataProviderError`
 * pattern for `FormDataProvider`. Found live (2026-09-05): without it, a
 * `manage.*` error (e.g. a genuine, well-messaged optimistic-locking
 * conflict between two concurrent admin sessions, confirmed live) fell
 * through as an unrecognized exception - `errorHandler.ts`'s deliberate
 * "only an HttpError's message is client-facing" safety net then flattened
 * it into a useless "Unexpected server error" (500), discarding a message
 * that was already good enough to show the admin directly.
 */
async function callManage<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (isTerminologyManageError(error)) {
      const status = typeof error.status === 'number' && error.status >= 400 && error.status < 600 ? error.status : 502;
      throw new HttpError(status, error.message, { code: error.code });
    }
    throw error;
  }
}

function stringParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === 'string' && value ? value : undefined;
}

function numberParam(req: Request, key: string): number | undefined {
  const value = stringParam(req, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolParam(req: Request, key: string): boolean | undefined {
  const value = stringParam(req, key);
  if (value === undefined) return undefined;
  return value !== 'false';
}

router.get('/providers', requirePermission('terminology.read'), (_req: Request, res: Response) => {
  res.json(terminologyProviderRegistry.list());
});

router.get('/search', requirePermission('terminology.read'), asyncHandler(async (req, res) => {
  const provider = resolveProvider(req, 'search');
  const query = stringParam(req, 'query');
  if (!query) throw new HttpError(400, 'Query parameter "query" is required');
  const concepts = await provider.search({
    bindingId: stringParam(req, 'bindingId'),
    bindingVersion: stringParam(req, 'bindingVersion'),
    namespace: stringParam(req, 'namespace'),
    namespaceVersion: stringParam(req, 'namespaceVersion'),
    query,
    limit: numberParam(req, 'limit'),
    activeOnly: boolParam(req, 'activeOnly'),
  });
  res.json(concepts);
}));

router.get('/lookup', requirePermission('terminology.read'), asyncHandler(async (req, res) => {
  const provider = resolveProvider(req, 'lookup');
  const namespace = stringParam(req, 'namespace');
  const code = stringParam(req, 'code');
  if (!namespace || !code) throw new HttpError(400, 'Query parameters "namespace" and "code" are required');
  const concept = await provider.lookup({ namespace, namespaceVersion: stringParam(req, 'namespaceVersion'), code });
  res.json(concept || null);
}));

router.get('/validate', requirePermission('terminology.read'), asyncHandler(async (req, res) => {
  const provider = resolveProvider(req, 'validate');
  const code = stringParam(req, 'code');
  if (!code) throw new HttpError(400, 'Query parameter "code" is required');
  // Passed through structurally, never reduced to a boolean - see
  // TerminologyValidationOutcome's own doc comment for why "invalid" and
  // "unreachable" must stay distinguishable all the way to the runtime.
  const outcome = await provider.validate({
    namespace: stringParam(req, 'namespace'),
    namespaceVersion: stringParam(req, 'namespaceVersion'),
    bindingId: stringParam(req, 'bindingId'),
    bindingVersion: stringParam(req, 'bindingVersion'),
    code,
  });
  res.json(outcome);
}));

router.get('/bindings', requirePermission('terminology.read'), asyncHandler(async (req, res) => {
  const provider = resolveProvider(req, 'discover');
  const query = stringParam(req, 'query') || '';
  const bindings = await provider.discover!.searchBindings(query);
  res.json(bindings);
}));

router.get('/bindings/:bindingId', requirePermission('terminology.read'), asyncHandler(async (req, res) => {
  const provider = resolveProvider(req, 'discover');
  const binding = await provider.discover!.getBinding(req.params.bindingId, stringParam(req, 'bindingVersion'));
  res.json(binding || null);
}));

router.get('/manage/terminologies', requirePermission('terminology.manage'), asyncHandler(async (req, res) => {
  const provider = resolveProvider(req, 'manage');
  res.json(await callManage(provider.manage!.listTerminologies()));
}));

router.post('/manage/terminologies', requirePermission('terminology.manage'), asyncHandler(async (req, res) => {
  const provider = resolveProvider(req, 'manage');
  const { id, label } = req.body || {};
  if (typeof id !== 'string' || !id || typeof label !== 'string' || !label) throw new HttpError(400, 'Body must include "id" and "label"');
  const summary = await callManage(provider.manage!.createTerminology({ id, label }));
  await writeAuditEvent({ actorUserId: req.principal?.userId, action: 'terminology.created', resourceType: 'terminology', resourceId: summary.bindingId, metadata: { provider: provider.id, label } });
  res.status(201).json(summary);
}));

router.get('/manage/terminologies/:id/concepts', requirePermission('terminology.manage'), asyncHandler(async (req, res) => {
  const provider = resolveProvider(req, 'manage');
  res.json(await callManage(provider.manage!.listConcepts(req.params.id)));
}));

router.put('/manage/terminologies/:id/concepts', requirePermission('terminology.manage'), asyncHandler(async (req, res) => {
  const provider = resolveProvider(req, 'manage');
  const { concept, expectedRevision } = (req.body || {}) as { concept?: TerminologyConcept; expectedRevision?: string };
  if (!concept || typeof concept.code !== 'string' || !concept.code) throw new HttpError(400, 'Body must include a "concept" with a "code"');
  if (typeof expectedRevision !== 'string' || !expectedRevision) throw new HttpError(400, 'Body must include "expectedRevision" (optimistic locking)');
  const result = await callManage(provider.manage!.upsertConcept(req.params.id, concept, expectedRevision));
  await writeAuditEvent({ actorUserId: req.principal?.userId, action: 'terminology.concept.upsert', resourceType: 'terminology', resourceId: req.params.id, metadata: { provider: provider.id, code: concept.code } });
  res.json(result);
}));

router.delete('/manage/terminologies/:id/concepts/:code', requirePermission('terminology.manage'), asyncHandler(async (req, res) => {
  const provider = resolveProvider(req, 'manage');
  const expectedRevision = stringParam(req, 'expectedRevision');
  if (!expectedRevision) throw new HttpError(400, 'Query parameter "expectedRevision" is required (optimistic locking)');
  const result = await callManage(provider.manage!.removeConcept(req.params.id, req.params.code, expectedRevision));
  await writeAuditEvent({ actorUserId: req.principal?.userId, action: 'terminology.concept.remove', resourceType: 'terminology', resourceId: req.params.id, metadata: { provider: provider.id, code: req.params.code } });
  res.json(result);
}));

router.post('/manage/terminologies/:id/publish', requirePermission('terminology.publish'), asyncHandler(async (req, res) => {
  const provider = resolveProvider(req, 'manage');
  const summary = await callManage(provider.manage!.publishVersion(req.params.id));
  await writeAuditEvent({ actorUserId: req.principal?.userId, action: 'terminology.version.published', resourceType: 'terminology', resourceId: req.params.id, metadata: { provider: provider.id, version: summary.bindingVersion } });
  res.json(summary);
}));

router.post('/manage/terminologies/:id/retire', requirePermission('terminology.publish'), asyncHandler(async (req, res) => {
  const provider = resolveProvider(req, 'manage');
  const { version } = (req.body || {}) as { version?: string };
  if (typeof version !== 'string' || !version) throw new HttpError(400, 'Body must include "version"');
  const summary = await callManage(provider.manage!.retireVersion(req.params.id, version));
  await writeAuditEvent({ actorUserId: req.principal?.userId, action: 'terminology.version.retired', resourceType: 'terminology', resourceId: req.params.id, metadata: { provider: provider.id, version } });
  res.json(summary);
}));

export default router;
