import { v4 as uuidv4 } from 'uuid';
import {
  COMPOSITION_EXTENSION_KEY,
  COMPOSITION_SCHEMA_VERSION,
  FORM_DEFINITION_SCHEMA_VERSION,
  migrateCanonicalFormToV1,
} from 'core';
import prisma from '../db/prisma';
import { HttpError } from '../middleware/errorHandler';
import { normalizeCanonicalFormPayload } from '../validation/formValidation';
import { pluginRegistry } from '../plugins/pluginRegistry';
import {
  compileDefinitionScripts,
  generateDefinitionFromTemplate,
  prepareConnectors,
  prepareNewDefinition,
} from './formDefinitionPreparation';

/**
 * Draft persistence without the HTTP layer: creating an empty form, applying
 * or generating from a template and autosaving a draft. The revision
 * conflict rules (412 for a stale If-Match, 409 for a lost compare-and-set
 * without one) belong here so the router only parses and re-emits ETags.
 */
export function revisionConflictStatus(expectedRevision: number | undefined): number {
  return expectedRevision === undefined ? 409 : 412;
}

export async function createEmptyForm(input: { name: string; composition: boolean }) {
  const id = uuidv4();
  const canonicalForm = prepareNewDefinition({
    id, name: input.name, version: '0.1.0-draft', schemaVersion: FORM_DEFINITION_SCHEMA_VERSION, revision: 0,
    extensions: input.composition ? { [COMPOSITION_EXTENSION_KEY]: { schemaVersion: COMPOSITION_SCHEMA_VERSION, pages: [{ id: 'page-1', title: 'Seite 1', blocks: [] }] } } : {},
    sourceTemplates: [], layout: { type: 'form', children: [{ type: 'container', children: [] }] }, bindings: {}, locales: { en: {} },
  }, id);
  return prisma.form.create({ data: { id, parent_id: id, name: input.name, version: canonicalForm.version, status: 'draft', canonical_json: canonicalForm as any } });
}

export async function applyTemplateToDraft(formId: string, templateId: string) {
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
  return prisma.form.update({ where: { id: formRecord.id }, data: { canonical_json: canonicalForm as any, name: canonicalForm.name, version: canonicalForm.version } });
}

export async function generateFormFromTemplate(templateId: string, formName?: string) {
  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) throw new HttpError(404, 'Template not found');

  const canonicalForm = generateDefinitionFromTemplate(template, uuidv4(), formName);
  return prisma.form.create({ data: { id: canonicalForm.id, parent_id: canonicalForm.id, name: canonicalForm.name, version: canonicalForm.version, status: 'draft', canonical_json: canonicalForm as any } });
}

export async function saveDraft(formId: string, body: unknown, expectedRevision: number | undefined) {
  const stored = await prisma.form.findUnique({ where: { id: formId } });
  if (!stored) throw new HttpError(404, 'Form not found');
  const storedDefinition = migrateCanonicalFormToV1(stored.canonical_json, formId);
  if (expectedRevision !== undefined && expectedRevision !== storedDefinition.revision) {
    throw new HttpError(412, 'Form was changed by another request', { code: 'FORM_REVISION_CONFLICT' });
  }
  const beforeSave = await pluginRegistry.runHook('beforeFormSave', { form: (body || {}) as Record<string, any>, data: (body || {}) as Record<string, any>, formId });
  let canonicalForm = normalizeCanonicalFormPayload(beforeSave.data || body, formId);
  canonicalForm.revision = storedDefinition.revision + 1;
  canonicalForm = prepareConnectors(canonicalForm);
  canonicalForm = compileDefinitionScripts(canonicalForm) as typeof canonicalForm;
  // Compare-and-set against the EXACT persisted canonical_json that was read
  // above (not the migrated v1 shape): two saves from the same revision both
  // pass the If-Match check but only one can still match this predicate, and
  // legacy JSON formats compare correctly because they are used as stored.
  const claimed = await prisma.form.updateMany({
    where: { id: formId, canonical_json: { equals: stored.canonical_json as any } },
    data: { canonical_json: canonicalForm as any, name: canonicalForm.name, version: canonicalForm.version, status: canonicalForm.status || 'draft' },
  });
  if (claimed.count === 0) {
    throw new HttpError(revisionConflictStatus(expectedRevision), 'Form was changed by another request', { code: 'FORM_REVISION_CONFLICT' });
  }
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(409, 'Form was changed by another request', { code: 'FORM_REVISION_CONFLICT' });
  await pluginRegistry.runHook('afterFormSave', { form: canonicalForm as Record<string, any>, data: canonicalForm as Record<string, any>, formId });
  return form;
}
