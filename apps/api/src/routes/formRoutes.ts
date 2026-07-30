import { Router } from 'express';
import prisma from '../db/prisma';
import { v4 as uuidv4 } from 'uuid';
import { exportToCambioForm } from '../exporters/cambioExporter';
import { exportMappings } from '../exporters/mappingExporter';
import { asyncHandler, HttpError } from '../middleware/errorHandler';
import { normalizeCanonicalFormPayload, requireNonEmptyString } from '../validation/formValidation';
import { FORM_DEFINITION_SCHEMA_VERSION, migrateCanonicalFormToV1 } from 'core';
import { pluginRegistry } from '../plugins/pluginRegistry';
import {
  FormScriptCompileResult,
  compileFormDefinitionScript,
  compileFormScript,
} from '../scripting/formScriptCompiler';
import {
  hydrateFormScriptConnectors,
  ScriptConnectorError,
} from '../services/scriptConnectorRegistry';
import { requireAuth } from '../middleware/auth';
import {
  FormScriptAiError,
  formScriptAiRateLimiter,
  generateFormScriptCandidate,
} from '../scripting/formScriptAiService';

const router = Router();

function assertScriptCompiles(result: FormScriptCompileResult): void {
  if (result.valid) return;
  throw new HttpError(422, 'Das Form Script enthält TypeScript- oder Sicherheitsfehler.', {
    code: 'FORM_SCRIPT_INVALID',
    messages: result.document.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      code: String(diagnostic.code),
      path: diagnostic.line
        ? `form-script.ts:${diagnostic.line}:${diagnostic.column || 1}`
        : 'form-script.ts',
      message: diagnostic.message,
    })),
  });
}

function prepareConnectors(definition: ReturnType<typeof migrateCanonicalFormToV1>, allowedOverride?: string[]) {
  try {
    return hydrateFormScriptConnectors(definition, allowedOverride);
  } catch (error) {
    if (error instanceof ScriptConnectorError) {
      throw new HttpError(error.status, error.message, {
        code: error.code,
        messages: [{ severity: 'error', code: error.code, path: 'formScript.connectors', message: error.message }],
      });
    }
    throw error;
  }
}

function prepareNewDefinition(input: Record<string, unknown>, formId: string) {
  const definition = prepareConnectors(migrateCanonicalFormToV1(input, formId));
  const compilation = compileFormDefinitionScript(definition);
  assertScriptCompiles(compilation);
  return { ...definition, formScript: compilation.document };
}

function createCanonicalForm(template: any, formId: string, formName?: string) {
  const registryData = template.parsed_registry_json as any;
  const isNewSchema = registryData && !Array.isArray(registryData);
  const fields = isNewSchema ? (registryData.fields || []) : (registryData || []);
  const layout = isNewSchema
    ? (registryData.layout || { type: 'form', children: [{ type: 'container', children: [] }] })
    : { type: 'form', children: [{ type: 'container', children: [] }] };
  const bindings: Record<string, any> = {};
  const localesEn: Record<string, any> = {};

  fields.forEach((field: any) => {
    bindings[field.fieldName] = { openehr: { templateAlias: field.templateAlias, path: field.openehrPath, rmType: field.rmType, flatPath: field.flatPath } };
    localesEn[`[name='${field.fieldName}']`] = { label: field.label };
  });

  return prepareNewDefinition({
    id: formId,
    name: formName || template.template_id,
    version: '0.1.0-draft',
    schemaVersion: FORM_DEFINITION_SCHEMA_VERSION,
    revision: 0,
    extensions: {},
    sourceTemplates: [{ alias: template.alias, id: template.template_id, version: template.version || '1.0.0', type: 'openEhrWebTemplate' }],
    layout,
    bindings,
    locales: { en: localesEn },
  }, formId);
}

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await prisma.form.findMany());
}));

router.post('/', asyncHandler(async (req, res) => {
  const name = req.body?.name === undefined ? 'New Form' : requireNonEmptyString(req.body.name, 'name');
  const id = uuidv4();
  const canonicalForm = prepareNewDefinition({ id, name, version: '0.1.0-draft', schemaVersion: FORM_DEFINITION_SCHEMA_VERSION, revision: 0, extensions: {}, sourceTemplates: [], layout: { type: 'form', children: [{ type: 'container', children: [] }] }, bindings: {}, locales: { en: {} } }, id);
  const form = await prisma.form.create({ data: { id, parent_id: id, name, version: canonicalForm.version, status: 'draft', canonical_json: canonicalForm as any } });
  res.status(201).json({ message: 'Empty form created', form });
}));

router.post('/:id/apply-template', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const templateId = requireNonEmptyString(req.body?.templateId, 'templateId');
  const formRecord = await prisma.form.findUnique({ where: { id: formId } });
  if (!formRecord) throw new HttpError(404, 'Form not found');
  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) throw new HttpError(404, 'Template not found');

  const current = formRecord.canonical_json as any;
  let canonicalForm = {
    ...createCanonicalForm(template, formRecord.id, current.name || formRecord.name),
    status: current.status || formRecord.status,
    settings: current.settings,
    extensions: current.extensions || {},
    revision: (current.revision ?? 0) + 1,
    ...(current.formScript ? { formScript: current.formScript } : {}),
  };
  canonicalForm = prepareConnectors(migrateCanonicalFormToV1(canonicalForm, formRecord.id)) as any;
  const compilation = compileFormDefinitionScript(canonicalForm);
  assertScriptCompiles(compilation);
  canonicalForm.formScript = compilation.document;
  const form = await prisma.form.update({ where: { id: formRecord.id }, data: { canonical_json: canonicalForm as any, name: canonicalForm.name, version: canonicalForm.version } });
  res.json({ message: 'Template applied', form });
}));

router.post('/generate-from-template', asyncHandler(async (req, res) => {
  const templateId = requireNonEmptyString(req.body?.templateId, 'templateId');
  const formName = req.body?.formName === undefined ? undefined : requireNonEmptyString(req.body.formName, 'formName');
  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) throw new HttpError(404, 'Template not found');

  const canonicalForm = createCanonicalForm(template, uuidv4(), formName);
  const form = await prisma.form.create({ data: { id: canonicalForm.id, parent_id: canonicalForm.id, name: canonicalForm.name, version: canonicalForm.version, status: 'draft', canonical_json: canonicalForm as any } });
  res.status(201).json({ message: 'Form generated', form });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');
  const canonicalForm = migrateCanonicalFormToV1({ ...(form.canonical_json as any), id: form.id }, form.id);
  res.json({ ...form, canonical_json: canonicalForm });
}));

router.post('/:id/script/check', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  if (typeof req.body?.source !== 'string') throw new HttpError(400, '"source" must be a string');
  const source = req.body.source;
  const stored = await prisma.form.findUnique({ where: { id: formId } });
  if (!stored) throw new HttpError(404, 'Form not found');
  const allowedOperations = req.body?.allowedOperations === undefined
    ? undefined
    : Array.isArray(req.body.allowedOperations)
      ? req.body.allowedOperations.filter((item: unknown): item is string => typeof item === 'string')
      : (() => { throw new HttpError(400, '"allowedOperations" must be a string array'); })();
  const definition = prepareConnectors(
    migrateCanonicalFormToV1({ ...(stored.canonical_json as any), id: stored.id }, stored.id),
    allowedOperations,
  );
  const result = compileFormScript(definition, source);
  res.json(result);
}));

router.post('/:id/script/generate', requireAuth, asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  if (typeof req.body?.source !== 'string') throw new HttpError(400, '"source" must be a string');
  if (typeof req.body?.instruction !== 'string') throw new HttpError(400, '"instruction" must be a string');
  const allowedOperations = req.body?.allowedOperations === undefined
    ? undefined
    : Array.isArray(req.body.allowedOperations)
      ? req.body.allowedOperations.filter((item: unknown): item is string => typeof item === 'string')
      : (() => { throw new HttpError(400, '"allowedOperations" must be a string array'); })();
  const stored = await prisma.form.findUnique({ where: { id: formId } });
  if (!stored) throw new HttpError(404, 'Form not found');

  const userId = req.auth?.id || 'anonymous';
  const definition = prepareConnectors(
    migrateCanonicalFormToV1({ ...(stored.canonical_json as any), id: stored.id }, stored.id),
    allowedOperations,
  );
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  const startedAt = Date.now();
  try {
    formScriptAiRateLimiter.assertAllowed(`${userId}:${formId}`);
    const candidate = await generateFormScriptCandidate(
      definition,
      req.body.source,
      req.body.instruction,
      undefined,
      controller.signal,
    );
    console.info('[FORM SCRIPT AI]', {
      formId,
      userId,
      durationMs: Date.now() - startedAt,
      valid: candidate.valid,
      status: 'success',
    });
    res.json(candidate);
  } catch (error) {
    console.warn('[FORM SCRIPT AI]', {
      formId,
      userId,
      durationMs: Date.now() - startedAt,
      status: controller.signal.aborted ? 'aborted' : 'error',
      code: error instanceof FormScriptAiError ? error.code : 'FORM_SCRIPT_AI_FAILED',
    });
    if (error instanceof FormScriptAiError) {
      throw new HttpError(error.status, error.message, {
        code: error.code,
        messages: [{
          severity: 'error',
          code: error.code,
          path: 'formScript.ai',
          message: error.message,
        }],
      });
    }
    throw error;
  } finally {
    req.removeListener('aborted', abort);
  }
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const stored = await prisma.form.findUnique({ where: { id: formId } });
  if (!stored) throw new HttpError(404, 'Form not found');
  const beforeSave = await pluginRegistry.runHook('beforeFormSave', { form: (req.body || {}) as Record<string, any>, data: (req.body || {}) as Record<string, any>, formId });
  let canonicalForm = normalizeCanonicalFormPayload(beforeSave.data || req.body, formId);
  const storedDefinition = migrateCanonicalFormToV1(stored.canonical_json, formId);
  canonicalForm.revision = storedDefinition.revision + 1;
  canonicalForm = prepareConnectors(canonicalForm);
  const compilation = compileFormDefinitionScript(canonicalForm);
  assertScriptCompiles(compilation);
  canonicalForm.formScript = compilation.document;
  const form = await prisma.form.update({ where: { id: formId }, data: { canonical_json: canonicalForm as any, name: canonicalForm.name, version: canonicalForm.version, status: canonicalForm.status || 'draft' } });
  await pluginRegistry.runHook('afterFormSave', { form: canonicalForm as Record<string, any>, data: canonicalForm as Record<string, any>, formId });
  res.json(form);
}));

router.post('/:id/publish', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');
  if (form.status === 'published') throw new HttpError(400, 'Form is already published');

  // Increment version logic: "0.1.0-draft" -> "1.0.0"
  let newVersion = '1.0.0';
  const match = form.version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (match) {
    newVersion = `${match[1] === '0' ? '1' : match[1]}.${match[2]}.${match[3]}`;
  }
  
  const canonicalForm = prepareConnectors(migrateCanonicalFormToV1({
    ...(form.canonical_json as any),
    schemaVersion: (form.canonical_json as any).schemaVersion || FORM_DEFINITION_SCHEMA_VERSION,
    revision: ((form.canonical_json as any).revision ?? 0) + 1,
    extensions: (form.canonical_json as any).extensions || {},
    version: newVersion,
    status: 'published',
  }, formId));
  const compilation = compileFormDefinitionScript(canonicalForm);
  assertScriptCompiles(compilation);
  canonicalForm.formScript = compilation.document;
  const published = await prisma.form.update({ 
    where: { id: formId }, 
    data: { status: 'published', version: newVersion, canonical_json: canonicalForm as any }
  });
  res.json({ message: 'Form published', form: published });
}));

router.post('/:id/create-draft', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');
  
  // create a new draft with incremented minor version
  const newId = uuidv4();
  let newVersion = '1.1.0-draft';
  const match = form.version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (match) {
    newVersion = `${match[1]}.${parseInt(match[2]) + 1}.0-draft`;
  }

  const canonicalForm = { ...(form.canonical_json as any), id: newId, schemaVersion: (form.canonical_json as any).schemaVersion || FORM_DEFINITION_SCHEMA_VERSION, revision: 0, extensions: (form.canonical_json as any).extensions || {}, version: newVersion, status: 'draft' };
  const draft = await prisma.form.create({
    data: {
      id: newId,
      parent_id: form.parent_id || form.id,
      name: form.name,
      version: newVersion,
      status: 'draft',
      canonical_json: canonicalForm
    }
  });

  res.status(201).json({ message: 'Draft created', form: draft });
}));

router.post('/:id/restore', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const oldForm = await prisma.form.findUnique({ where: { id: formId } });
  if (!oldForm) throw new HttpError(404, 'Form not found');
  
  const parentId = oldForm.parent_id || oldForm.id;
  
  // Find the latest version string to know what minor version to bump to
  const allVersions = await prisma.form.findMany({ where: { parent_id: parentId } });
  let maxMajor = 0;
  let maxMinor = 0;
  
  allVersions.forEach(v => {
    const match = v.version.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (match) {
      const maj = parseInt(match[1]);
      const min = parseInt(match[2]);
      if (maj > maxMajor) { maxMajor = maj; maxMinor = min; }
      else if (maj === maxMajor && min > maxMinor) { maxMinor = min; }
    }
  });

  const newId = uuidv4();
  const newVersion = `${maxMajor}.${maxMinor + 1}.0-draft`;

  const canonicalForm = { ...(oldForm.canonical_json as any), id: newId, revision: 0, version: newVersion, status: 'draft' };
  const restoredDraft = await prisma.form.create({
    data: {
      id: newId,
      parent_id: parentId,
      name: oldForm.name,
      version: newVersion,
      status: 'draft',
      canonical_json: canonicalForm
    }
  });

  res.status(201).json({ message: 'Restored as new draft', form: restoredDraft });
}));

router.post('/:id/archive', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');
  
  const canonicalForm = { ...(form.canonical_json as any), status: 'archived' };
  const archived = await prisma.form.update({
    where: { id: formId },
    data: { status: 'archived', canonical_json: canonicalForm }
  });
  
  res.json({ message: 'Form archived', form: archived });
}));

router.post('/:id/delete', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');
  
  const canonicalForm = { ...(form.canonical_json as any), status: 'deleted' };
  const deleted = await prisma.form.update({
    where: { id: formId },
    data: { status: 'deleted', canonical_json: canonicalForm }
  });
  
  res.json({ message: 'Form deleted', form: deleted });
}));

router.get('/parent/:parentId/latest-published', asyncHandler(async (req, res) => {
  const parentId = requireNonEmptyString(req.params.parentId, 'parentId');
  const forms = await prisma.form.findMany({
    where: { parent_id: parentId, status: 'published' },
    orderBy: { createdAt: 'desc' }
  });
  if (forms.length === 0) throw new HttpError(404, 'No active published form found');
  
  // Custom sort to find semver latest (or we just rely on createdAt)
  const latest = forms[0];
  const canonicalForm = migrateCanonicalFormToV1({ ...(latest.canonical_json as any), id: latest.id }, latest.id);
  res.json({ ...latest, canonical_json: canonicalForm });
}));

router.get('/parent/:parentId/versions', asyncHandler(async (req, res) => {
  const parentId = requireNonEmptyString(req.params.parentId, 'parentId');
  const forms = await prisma.form.findMany({
    where: { parent_id: parentId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, parent_id: true, name: true, version: true, status: true, createdAt: true, updatedAt: true }
  });
  res.json(forms);
}));

router.get('/:id/export/cambio', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');
  res.json(exportToCambioForm({ ...(form.canonical_json as any), id: form.id }));
}));

router.get('/:id/export/mappings', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');
  res.json(await exportMappings(normalizeCanonicalFormPayload(form.canonical_json, form.id)));
}));

export default router;
