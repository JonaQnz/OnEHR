import { Router } from 'express';
import prisma from '../db/prisma';
import { v4 as uuidv4 } from 'uuid';
import { exportToCambioForm } from '../exporters/cambioExporter';
import { exportMappings } from '../exporters/mappingExporter';
import { asyncHandler, HttpError } from '../middleware/errorHandler';
import { normalizeCanonicalFormPayload, requireNonEmptyString } from '../validation/formValidation';

const router = Router();

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

  return {
    id: formId,
    name: formName || template.template_id,
    version: '0.1.0-draft',
    sourceTemplates: [{ alias: template.alias, id: template.template_id, version: template.version || '1.0.0', type: 'openEhrWebTemplate' }],
    layout,
    bindings,
    locales: { en: localesEn },
  };
}

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await prisma.form.findMany());
}));

router.post('/', asyncHandler(async (req, res) => {
  const name = req.body?.name === undefined ? 'New Form' : requireNonEmptyString(req.body.name, 'name');
  const id = uuidv4();
  const canonicalForm = { id, name, version: '0.1.0-draft', sourceTemplates: [], layout: { type: 'form', children: [{ type: 'container', children: [] }] }, bindings: {}, locales: { en: {} } };
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
  const canonicalForm = { ...createCanonicalForm(template, formRecord.id, current.name || formRecord.name), status: current.status || formRecord.status, settings: current.settings };
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
  res.json({ ...form, canonical_json: { ...(form.canonical_json as any), id: form.id } });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const formId = requireNonEmptyString(req.params.id, 'id');
  const canonicalForm = normalizeCanonicalFormPayload(req.body, formId);
  const form = await prisma.form.update({ where: { id: formId }, data: { canonical_json: canonicalForm as any, name: canonicalForm.name, version: canonicalForm.version, status: canonicalForm.status || 'draft' } });
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
  
  const canonicalForm = { ...(form.canonical_json as any), version: newVersion, status: 'published' };
  const published = await prisma.form.update({ 
    where: { id: formId }, 
    data: { status: 'published', version: newVersion, canonical_json: canonicalForm } 
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

  const canonicalForm = { ...(form.canonical_json as any), id: newId, version: newVersion, status: 'draft' };
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
