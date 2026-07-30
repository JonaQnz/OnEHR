import { Router } from 'express';
import { migrateCanonicalFormToV1 } from 'core';
import prisma from '../db/prisma';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errorHandler';
import {
  ScriptConnectorError,
  scriptConnectorRegistry,
} from '../services/scriptConnectorRegistry';

const router = Router();

router.use(requireAuth);

router.get('/', (_req, res) => {
  res.json({ operations: scriptConnectorRegistry.list() });
});

router.post('/forms/:formId/call', asyncHandler(async (req, res) => {
  const formId = typeof req.params.formId === 'string' ? req.params.formId.trim() : '';
  const operation = typeof req.body?.operation === 'string' ? req.body.operation.trim() : '';
  if (!formId) return res.status(400).json({ code: 'SCRIPT_CONNECTOR_INPUT_INVALID', error: 'formId is required.' });
  if (!operation) return res.status(400).json({ code: 'SCRIPT_CONNECTOR_INPUT_INVALID', error: 'operation is required.' });

  const stored = await prisma.form.findUnique({ where: { id: formId } });
  if (!stored) return res.status(404).json({ code: 'SCRIPT_CONNECTOR_FORM_NOT_FOUND', error: 'Form not found.' });
  const form = migrateCanonicalFormToV1({ ...(stored.canonical_json as any), id: stored.id }, stored.id);
  const callContext = req.body?.context && typeof req.body.context === 'object' && !Array.isArray(req.body.context)
    ? req.body.context as Record<string, unknown>
    : {};
  const abortController = new AbortController();
  req.once('aborted', () => abortController.abort());
  res.once('close', () => {
    if (!res.writableEnded) abortController.abort();
  });
  const startedAt = Date.now();

  try {
    const result = await scriptConnectorRegistry.execute(
      operation,
      req.body?.input,
      {
        formId,
        form,
        userId: req.auth?.id || 'anonymous',
        authMode: req.auth?.authMode || 'local',
        patientId: typeof callContext.patientId === 'string' ? callContext.patientId : undefined,
        ehrId: typeof callContext.ehrId === 'string' ? callContext.ehrId : undefined,
        encounterId: typeof callContext.encounterId === 'string' ? callContext.encounterId : undefined,
        sessionId: typeof callContext.sessionId === 'string' ? callContext.sessionId : undefined,
        authorization: req.headers.authorization
          || (req.auth?.accessToken ? `Bearer ${req.auth.accessToken}` : undefined),
      },
      abortController.signal,
      typeof req.body?.timeoutMs === 'number' ? req.body.timeoutMs : undefined,
    );
    return res.json({
      requestId: typeof req.body?.requestId === 'string' ? req.body.requestId : undefined,
      result,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    if (error instanceof ScriptConnectorError) {
      return res.status(error.status).json({
        requestId: typeof req.body?.requestId === 'string' ? req.body.requestId : undefined,
        code: error.code,
        error: error.message,
        durationMs: Date.now() - startedAt,
      });
    }
    return res.status(500).json({
      code: 'SCRIPT_CONNECTOR_FAILED',
      error: 'Script connector request failed.',
      durationMs: Date.now() - startedAt,
    });
  }
}));

export default router;
