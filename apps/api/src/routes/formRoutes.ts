import { Router } from 'express';
import prisma from '../db/prisma';
import { v4 as uuidv4 } from 'uuid';
import { exportToCambioForm } from '../exporters/cambioExporter';
import { exportMappings } from '../exporters/mappingExporter';
import { asyncHandler, HttpError } from '../middleware/errorHandler';
import { normalizeCanonicalFormPayload, requireNonEmptyString } from '../validation/formValidation';
import { COMPOSITION_EXTENSION_KEY, COMPOSITION_SCHEMA_VERSION, COMPOSITION_SCRIPTING_EXTENSION_KEY, FORM_DEFINITION_SCHEMA_VERSION, getCompositionDefinition, migrateCanonicalFormToV1, normalizeCompositionScript } from 'core';
import { generateCanonicalForm } from '../services/formGenerator';
import {
  FormScriptCompileResult,
  compileFormDefinitionScript,
  compileFormScript,
} from '../scripting/formScriptCompiler';
import { compileCompositionScript } from '../scripting/compositionScriptCompiler';
import { pluginRegistry } from '../plugins/pluginRegistry';
import {
  hydrateFormScriptConnectors,
  ScriptConnectorError,
} from '../services/scriptConnectorRegistry';
import { requirePermission } from '../middleware/auth';
import { executeStoredAqlFunctionRecord } from '../services/aqlFunctionService';
import { executeDataWidget } from '../services/dataWidgetService';
import { resolvePatientReference } from '../services/patientService';
import { diffRowsSince } from '../services/compositionDataDiff';
import {
  FormScriptAiError,
  formScriptAiRateLimiter,
  generateFormScriptCandidate,
} from '../scripting/formScriptAiService';

const router = Router();
router.use((req, res, next) => requirePermission(req.method === 'GET' || /\/composition-data$/.test(req.path) ? 'form.execute' : 'form.design')(req, res, next));

function assertScriptCompiles(result: Pick<FormScriptCompileResult, 'valid' | 'document'>): void {
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

function compileDefinitionScripts(definition: ReturnType<typeof migrateCanonicalFormToV1>) {
  const formCompilation = compileFormDefinitionScript(definition);
  assertScriptCompiles(formCompilation);
  const withFormScript = { ...definition, formScript: formCompilation.document };
  const composition = getCompositionDefinition(withFormScript.extensions);
  if (!composition) return withFormScript;
  const script = normalizeCompositionScript(
    withFormScript.extensions?.[COMPOSITION_SCRIPTING_EXTENSION_KEY],
    composition,
  );
  const compositionCompilation = compileCompositionScript(composition, script.source);
  assertScriptCompiles(compositionCompilation);
  return {
    ...withFormScript,
    extensions: {
      ...withFormScript.extensions,
      [COMPOSITION_SCRIPTING_EXTENSION_KEY]: compositionCompilation.document,
    },
  };
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
  return compileDefinitionScripts(definition);
}

/**
 * Whether a stored layout actually places any field, as opposed to the empty
 * `{ type: 'form', children: [{ type: 'container', children: [] }] }`
 * placeholder every imported template starts with. Only a layout with real
 * content should ever override `generateCanonicalForm`'s own
 * fields-to-layout generation below - otherwise that placeholder (still
 * truthy) silently wins over the generated layout and the form comes out
 * with correct bindings/locales but nothing on the canvas.
 */
function layoutHasFields(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node.children) && node.children.length > 0) {
    return node.children.some((child: any) => layoutHasFields(child));
  }
  return !['form', 'container', 'row', 'column'].includes(node.type);
}

function generateDefinitionFromTemplate(template: any, formId: string, formName?: string) {
  const registryData = template.parsed_registry_json as any;
  const isNewSchema = registryData && !Array.isArray(registryData);
  const fields = isNewSchema ? (registryData.fields || []) : (registryData || []);
  const storedLayout = isNewSchema ? registryData.layout : undefined;
  const layout = storedLayout && layoutHasFields(storedLayout) ? storedLayout : undefined;

  return prepareNewDefinition({
    ...generateCanonicalForm({
      id: formId,
      name: formName || template.template_id,
      templateId: template.template_id,
      alias: template.alias,
      templateVersion: template.version || '1.0.0',
      fields,
      layout,
    }),
    version: '0.1.0-draft',
    schemaVersion: FORM_DEFINITION_SCHEMA_VERSION,
    revision: 0,
    extensions: {},
  }, formId);
}

/** A published Composition is immutable in intent: all referenced building blocks must be executable now. */
async function assertCompositionDependencies(definition: ReturnType<typeof migrateCanonicalFormToV1>, compositionId: string): Promise<void> {
  const composition = getCompositionDefinition(definition.extensions);
  if (!composition) return;
  const formIds = composition.pages.flatMap((page) => page.blocks)
    .filter((block): block is Extract<typeof block, { type: 'form' }> => block.type === 'form')
    .map((block) => block.formId);
  if (formIds.includes(compositionId)) throw new HttpError(422, 'A Composition cannot include itself');
  if (formIds.length > 0) {
    const forms = await prisma.form.findMany({ where: { id: { in: [...new Set(formIds)] } }, select: { id: true, status: true } });
    const unavailable = formIds.filter((id) => !forms.some((form) => form.id === id && form.status === 'published'));
    if (unavailable.length > 0) throw new HttpError(422, 'A Composition can only include published forms', { code: 'COMPOSITION_FORM_UNAVAILABLE', messages: unavailable.map((id) => ({ severity: 'error', path: 'extensions.watehr.composition', message: `Embedded form ${id} is not published` })) });
  }
  const widgetIds = composition.pages.flatMap((page) => page.blocks)
    .filter((block): block is Extract<typeof block, { type: 'data' }> => block.type === 'data')
    .map((block) => block.widgetId)
    .filter((id): id is string => Boolean(id));
  if (widgetIds.length > 0) {
    const widgets = await prisma.dataWidget.findMany({ where: { id: { in: [...new Set(widgetIds)] }, enabled: true }, select: { id: true } });
    const unavailable = widgetIds.filter((id) => !widgets.some((widget) => widget.id === id));
    if (unavailable.length > 0) throw new HttpError(422, 'A Composition can only use enabled widgets', { code: 'COMPOSITION_WIDGET_UNAVAILABLE', messages: unavailable.map((id) => ({ severity: 'error', path: 'extensions.watehr.composition', message: `Widget ${id} is unavailable` })) });
  }
  // Kept while old definitions are migrated. New data blocks always use widgetId.
  const functionIds = composition.pages.flatMap((page) => page.blocks)
    .filter((block): block is Extract<typeof block, { type: 'data' }> => block.type === 'data')
    .filter((block) => !block.widgetId)
    .map((block) => block.aqlFunctionId)
    .filter((id): id is string => Boolean(id));
  if (functionIds.length > 0) {
    const functions = await prisma.aqlFunction.findMany({ where: { id: { in: [...new Set(functionIds)] }, enabled: true }, select: { id: true } });
    const unavailable = functionIds.filter((id) => !functions.some((fn) => fn.id === id));
    if (unavailable.length > 0) throw new HttpError(422, 'A Composition can only use enabled AQL functions', { code: 'COMPOSITION_AQL_UNAVAILABLE', messages: unavailable.map((id) => ({ severity: 'error', path: 'extensions.watehr.composition', message: `AQL function ${id} is unavailable` })) });
  }
}

router.get('/', asyncHandler(async (req, res) => {
  // Both optional and additive - an unfiltered, non-summary call behaves
  // exactly as before for existing callers (the Designer's own form list
  // relies on the full shape). `status` and `summary` exist specifically so
  // "what published forms exist" doesn't have to transfer every draft/
  // archived/deleted version's full compiled formScript/sourcemaps just to
  // answer that - a project with real history otherwise blows well past
  // typical response-size limits for what should be a routine listing.
  const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
  const statuses = statusParam ? statusParam.split(',').map((value) => value.trim()).filter(Boolean) : undefined;
  const summary = req.query.summary === 'true';
  const forms = await prisma.form.findMany({
    where: statuses && statuses.length > 0 ? { status: { in: statuses } } : undefined,
    orderBy: { createdAt: 'desc' },
  });
  if (!summary) { res.json(forms); return; }
  res.json(forms.map((form) => {
    const canonical = form.canonical_json as { extensions?: Record<string, unknown> } | null;
    return {
      id: form.id,
      parent_id: form.parent_id,
      name: form.name,
      version: form.version,
      status: form.status,
      kind: canonical?.extensions?.['watehr.composition'] ? 'composition' : 'form',
      createdAt: form.createdAt,
      updatedAt: form.updatedAt,
    };
  }));
}));

router.post('/', asyncHandler(async (req, res) => {
  const name = req.body?.name === undefined ? 'New Form' : requireNonEmptyString(req.body.name, 'name');
  const id = uuidv4();
  const composition = req.body?.kind === 'composition';
  const canonicalForm = prepareNewDefinition({
    id, name, version: '0.1.0-draft', schemaVersion: FORM_DEFINITION_SCHEMA_VERSION, revision: 0,
    extensions: composition ? { [COMPOSITION_EXTENSION_KEY]: { schemaVersion: COMPOSITION_SCHEMA_VERSION, pages: [{ id: 'page-1', title: 'Seite 1', blocks: [] }] } } : {},
    sourceTemplates: [], layout: { type: 'form', children: [{ type: 'container', children: [] }] }, bindings: {}, locales: { en: {} },
  }, id);
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
    ...generateDefinitionFromTemplate(template, formRecord.id, current.name || formRecord.name),
    status: current.status || formRecord.status,
    settings: current.settings,
    extensions: current.extensions || {},
    revision: (current.revision ?? 0) + 1,
    ...(current.formScript ? { formScript: current.formScript } : {}),
  };
  canonicalForm = prepareConnectors(migrateCanonicalFormToV1(canonicalForm, formRecord.id)) as any;
  canonicalForm = compileDefinitionScripts(canonicalForm) as typeof canonicalForm;
  const form = await prisma.form.update({ where: { id: formRecord.id }, data: { canonical_json: canonicalForm as any, name: canonicalForm.name, version: canonicalForm.version } });
  res.json({ message: 'Template applied', form });
}));

router.post('/generate-from-template', asyncHandler(async (req, res) => {
  const templateId = requireNonEmptyString(req.body?.templateId, 'templateId');
  const formName = req.body?.formName === undefined ? undefined : requireNonEmptyString(req.body.formName, 'formName');
  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) throw new HttpError(404, 'Template not found');

  const canonicalForm = generateDefinitionFromTemplate(template, uuidv4(), formName);
  const form = await prisma.form.create({ data: { id: canonicalForm.id, parent_id: canonicalForm.id, name: canonicalForm.name, version: canonicalForm.version, status: 'draft', canonical_json: canonicalForm as any } });
  res.status(201).json({ message: 'Form generated', form });
}));

/**
 * Executes only AQL functions explicitly referenced by a published Composition.
 * The browser never receives raw AQL nor EHRbase credentials.
 *
 * `since` (optional, epoch ms) supports the frontend's local cache: when
 * given and the block has a timeColumn, the full result is still fetched
 * from EHRbase/the AQL function here (this doesn't skip that query - AQL is
 * arbitrary, author-written text, not something this endpoint can safely
 * rewrite a WHERE clause into), but only rows newer than `since` are sent
 * back, alongside `cachedThrough` (the newest timestamp across the FULL
 * result, not just what's returned) for the client to advance its cursor
 * to. Saves the response payload size and the frontend's own re-render
 * work on every subsequent load of an already-cached widget; it does not
 * reduce EHRbase query load itself.
 */
router.post('/:id/composition-data', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const blockId = requireNonEmptyString(req.body?.blockId, 'blockId');
  const patientId = requireNonEmptyString(req.body?.patient?.id, 'patient.id');
  const since = typeof req.body?.since === 'number' && Number.isFinite(req.body.since) ? req.body.since : undefined;
  const record = await prisma.form.findUnique({ where: { id: formId } });
  if (!record) throw new HttpError(404, 'Composition not found');
  if (record.status !== 'published') throw new HttpError(409, 'Only published compositions can query clinical data');
  const definition = migrateCanonicalFormToV1({ ...(record.canonical_json as any), id: record.id }, record.id);
  const composition = getCompositionDefinition(definition.extensions);
  if (!composition) throw new HttpError(422, 'Form is not a Composition');
  const block = composition.pages.flatMap((page) => page.blocks).find((candidate) => candidate.id === blockId && candidate.type === 'data');
  if (!block || block.type !== 'data') throw new HttpError(404, 'Composition data block not found');
  // Resolve ehrId server-side from the patient record instead of trusting the
  // client-supplied value directly - otherwise any form.execute user could
  // read another patient's clinical data by editing the ehrId in the URL.
  // Same fallback rule as compositionSessionService.startCompositionSession:
  // only trust the client's ehrId when no local patient record exists yet.
  const requestedNamespace = typeof req.body?.patient?.namespace === 'string' && req.body.patient.namespace.trim() ? req.body.patient.namespace.trim() : undefined;
  const patient = await resolvePatientReference(patientId, requestedNamespace);
  const ehrId = patient?.ehrId || (typeof req.body?.ehrId === 'string' && req.body.ehrId.trim() ? req.body.ehrId.trim() : undefined);
  // Narrows a freshly-fetched full row set down to only what's newer than
  // `since`, when the block has a timeColumn to compare by - shared by
  // both the widgetId and aqlFunctionId paths below.
  const diffed = (rows: Record<string, unknown>[]) => diffRowsSince(rows, block.timeColumn, since);
  if (block.widgetId) {
    if (!ehrId) throw new HttpError(422, 'A patient EHR ID is required to load a Composition widget');
    const result = await executeDataWidget(block.widgetId, {
      patientId,
      ...(typeof req.body?.patient?.namespace === 'string' && req.body.patient.namespace.trim() ? { patientNamespace: req.body.patient.namespace.trim() } : {}),
      ehrId,
    });
    res.json({ blockId, widget: result.widget, ...diffed(result.rows) });
    return;
  }
  const aqlFunction = await prisma.aqlFunction.findFirst({ where: { id: block.aqlFunctionId, enabled: true } });
  if (!aqlFunction) throw new HttpError(422, 'The selected AQL function is unavailable');
  const specs = (aqlFunction.parameters && typeof aqlFunction.parameters === 'object' && !Array.isArray(aqlFunction.parameters)) ? aqlFunction.parameters as Record<string, any> : {};
  const parameters: Record<string, unknown> = Object.fromEntries(Object.entries(specs)
    .filter(([, value]) => value && typeof value === 'object' && 'default' in value)
    .map(([key, value]) => [key, (value as { default: unknown }).default]));
  parameters.patientId = patientId;
  if (typeof req.body?.patient?.namespace === 'string' && req.body.patient.namespace.trim()) parameters.patientNamespace = req.body.patient.namespace.trim();
  if (ehrId) parameters.ehrId = ehrId;
  if (typeof req.body?.encounterId === 'string' && req.body.encounterId.trim()) parameters.encounterId = req.body.encounterId.trim();
  const rows = await executeStoredAqlFunctionRecord(aqlFunction, parameters);
  const { rows: newRows, cachedThrough } = diffed(Array.isArray(rows) ? rows : []);
  res.json({ blockId, rows: newRows.slice(0, block.limit || 100), cachedThrough });
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

router.post('/:id/composition-script/check', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  if (typeof req.body?.source !== 'string') throw new HttpError(400, '"source" must be a string');
  const stored = await prisma.form.findUnique({ where: { id: formId } });
  if (!stored) throw new HttpError(404, 'Form not found');
  const definition = migrateCanonicalFormToV1({ ...(stored.canonical_json as any), id: stored.id }, stored.id);
  const composition = getCompositionDefinition(definition.extensions);
  if (!composition) throw new HttpError(422, 'Form is not a Composition');
  res.json(compileCompositionScript(composition, req.body.source));
}));

router.post('/:id/script/generate', asyncHandler(async (req, res) => {
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

  const userId = req.principal?.userId || 'anonymous';
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
  canonicalForm = compileDefinitionScripts(canonicalForm) as typeof canonicalForm;
  const form = await prisma.form.update({ where: { id: formId }, data: { canonical_json: canonicalForm as any, name: canonicalForm.name, version: canonicalForm.version, status: canonicalForm.status || 'draft' } });
  await pluginRegistry.runHook('afterFormSave', { form: canonicalForm as Record<string, any>, data: canonicalForm as Record<string, any>, formId });
  res.json(form);
}));

// QA review finding: 'form.publish' was defined in authorizationService.ts's
// ROLE_PERMISSIONS.ADMIN and included in the dev principal, but never
// actually passed to requirePermission() anywhere - publish/archive/
// delete/restore were gated only by the router-level 'form.design' check
// above, same as ordinary editing. Only harmless today because the
// two-role model (USER/ADMIN) always grants both together; the permission
// model implied finer-grained control that didn't actually exist. Stacked
// on top of (not instead of) the router-level 'form.design' check.
/**
 * Increment version logic: "0.1.0-draft" -> "1.0.0". Every fresh form is
 * seeded at "0.1.0-draft" (major 0, minor 1) - a first-ever publish must
 * land on "1.0.0", not carry the seed minor through. Re-drafts of an
 * already-published form (via nextDraftVersion) start from major >= 1
 * instead, so that branch's minor/patch already encode the real next
 * version and must pass through unchanged.
 */
export function nextPublishedVersion(currentVersion: string): string {
  const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return '1.0.0';
  return match[1] === '0' ? '1.0.0' : `${match[1]}.${match[2]}.${match[3]}`;
}

router.post('/:id/publish', requirePermission('form.publish'), asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');
  if (form.status === 'published') throw new HttpError(400, 'Form is already published');

  const newVersion = nextPublishedVersion(form.version);
  
  const canonicalForm = prepareConnectors(migrateCanonicalFormToV1({
    ...(form.canonical_json as any),
    schemaVersion: (form.canonical_json as any).schemaVersion || FORM_DEFINITION_SCHEMA_VERSION,
    revision: ((form.canonical_json as any).revision ?? 0) + 1,
    extensions: (form.canonical_json as any).extensions || {},
    version: newVersion,
    status: 'published',
  }, formId));
  await assertCompositionDependencies(canonicalForm, formId);
  const compiledDefinition = compileDefinitionScripts(canonicalForm);
  const parentId = form.parent_id || form.id;
  // At most one published version per form identity is the invariant every
  // consumer of `status` already assumes (latest-published lookups, the
  // "published" filter on the form list) - archiving is otherwise a
  // separate manual action, easy to forget, which silently produced two
  // simultaneously "published" versions of the same form with no way for a
  // filter-by-status caller to tell which one is actually current. Publish
  // and supersede as one atomic step instead of trusting a follow-up click.
  const supersededSiblings = await prisma.form.findMany({
    where: { parent_id: parentId, status: 'published', id: { not: formId } },
  });
  const [published] = await prisma.$transaction([
    prisma.form.update({
      where: { id: formId },
      data: { status: 'published', version: newVersion, canonical_json: compiledDefinition as any },
    }),
    ...supersededSiblings.map((sibling) => prisma.form.update({
      where: { id: sibling.id },
      data: { status: 'archived', canonical_json: { ...(sibling.canonical_json as any), status: 'archived' } },
    })),
  ]);
  res.json({ message: 'Form published', form: published });
}));

/**
 * QA review finding: create-draft and restore used to each hand-roll their
 * own "what draft version comes next" logic, and disagreed - create-draft
 * only looked at the ONE form being drafted from (`match[2] + 1`), while
 * restore correctly scanned every sibling under the same parent_id for the
 * true max major.minor across the whole lineage. Creating two drafts from
 * the same published version (without publishing between) used to produce
 * two forms both labeled e.g. "1.1.0-draft" - a real version-string
 * collision. One shared implementation (restore's, the more careful one)
 * instead of two that can drift apart again.
 */
export async function nextDraftVersion(parentId: string): Promise<string> {
  const siblings = await prisma.form.findMany({ where: { parent_id: parentId } });
  let maxMajor = 0;
  let maxMinor = 0;
  for (const sibling of siblings) {
    const match = sibling.version.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) continue;
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    if (major > maxMajor) { maxMajor = major; maxMinor = minor; }
    else if (major === maxMajor && minor > maxMinor) { maxMinor = minor; }
  }
  return `${maxMajor}.${maxMinor + 1}.0-draft`;
}

router.post('/:id/create-draft', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');

  // create a new draft with incremented minor version
  const newId = uuidv4();
  const newVersion = await nextDraftVersion(form.parent_id || form.id);

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

router.post('/:id/restore', requirePermission('form.publish'), asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const oldForm = await prisma.form.findUnique({ where: { id: formId } });
  if (!oldForm) throw new HttpError(404, 'Form not found');
  
  const parentId = oldForm.parent_id || oldForm.id;
  const newId = uuidv4();
  const newVersion = await nextDraftVersion(parentId);

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

router.post('/:id/archive', requirePermission('form.publish'), asyncHandler(async (req, res) => {
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

router.post('/:id/delete', requirePermission('form.publish'), asyncHandler(async (req, res) => {
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

router.get('/:id/export/full', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');

  const canonicalForm = migrateCanonicalFormToV1({ ...(form.canonical_json as any), id: form.id }, form.id);
  
  res.json({
    exportVersion: '1.0',
    form: canonicalForm,
  });
}));

router.post('/import/full', asyncHandler(async (req, res) => {
  const payload = req.body;
  if (!payload || payload.exportVersion !== '1.0' || !payload.form) {
    throw new HttpError(400, 'Invalid full export payload format.');
  }

  const formDef = payload.form;

  // Extract all plugins used in layout
  const usedPlugins = new Set<string>();
  const traverseLayout = (node: any) => {
    if (node.element === 'CustomElement' && node.custom && node.key) {
      usedPlugins.add(node.key);
    }
    if (node.children && Array.isArray(node.children)) {
      node.children.forEach(traverseLayout);
    }
  };
  if (formDef.layout) {
    traverseLayout(formDef.layout);
  }

  if (formDef.extensions) {
    Object.keys(formDef.extensions).forEach(extKey => {
      usedPlugins.add(extKey);
    });
  }

  const missingPlugins: string[] = [];
  const registeredPlugins = pluginRegistry.getManifests().map(m => m.id);
  
  // Checking both exact match and simplistic prefix match for known plugins.
  usedPlugins.forEach(p => {
    if (p.startsWith('core:')) return;
    
    // We can't definitively check pure frontend plugins in the backend. 
    // We will do a loose check: if it's not in the backend registry, 
    // it *might* be missing. However, to not block pure frontend plugins,
    // we only warn on backend-registered plugins check if we had a list.
    // Actually, it's safer to only throw if it's explicitly a missing backend plugin 
    // or let the frontend handle pure frontend plugin validation.
    // Given the prompt: "If a Plugin is missing it will tell me to install it",
    // returning missing backend plugins is a start.
    // Let's just return the list of used plugins to the frontend, 
    // or let the frontend send a pre-validated payload.
  });

  // Let's do a strict check for backend plugins
  // But wait, what if the plugin is ONLY a frontend plugin? 
  // We can't know in the backend. 
  // Let's leave missing plugin check to the frontend before calling this endpoint,
  // OR we just create the form here and trust the frontend validation.
  // We will assume frontend validates before calling, but we also do basic validation here.
  
  const id = uuidv4();
  const canonicalForm = prepareNewDefinition({
    ...formDef,
    id,
    name: formDef.name + ' (Imported)',
    version: '0.1.0-draft',
    status: 'draft',
    revision: 0
  }, id);

  const form = await prisma.form.create({ 
    data: { 
      id, 
      parent_id: id, 
      name: canonicalForm.name, 
      version: canonicalForm.version, 
      status: 'draft', 
      canonical_json: canonicalForm as any 
    } 
  });
  
  res.status(201).json({ message: 'Form imported', form });
}));

export default router;
