import prisma from '../db/prisma';
import { v4 as uuidv4 } from 'uuid';
import { exportToCambioForm } from '../exporters/cambioExporter';
import { exportMappings } from '../exporters/mappingExporter';
import { HttpError } from '../middleware/errorHandler';
import { normalizeCanonicalFormPayload } from '../validation/formValidation';
import { migrateCanonicalFormToV1 } from 'core';
import { prepareNewDefinition } from './formDefinitionPreparation';

async function getStoredForm(formId: string) {
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');
  return form;
}

export async function exportCambio(formId: string) {
  const form = await getStoredForm(formId);
  return exportToCambioForm({ ...(form.canonical_json as any), id: form.id });
}

export async function exportFormMappings(formId: string) {
  const form = await getStoredForm(formId);
  return exportMappings(normalizeCanonicalFormPayload(form.canonical_json, form.id));
}

export async function exportFullForm(formId: string) {
  const form = await getStoredForm(formId);
  const canonicalForm = migrateCanonicalFormToV1({ ...(form.canonical_json as any), id: form.id }, form.id);
  return {
    exportVersion: '1.0',
    form: canonicalForm,
  };
}

export async function importFullForm(input: unknown) {
  const payload = input as { exportVersion?: unknown; form?: any } | null;
  if (!payload || payload.exportVersion !== '1.0' || !payload.form) {
    throw new HttpError(400, 'Invalid full export payload format.');
  }

  const formDef = payload.form;
  const id = uuidv4();
  const canonicalForm = prepareNewDefinition({
    ...formDef,
    id,
    name: formDef.name + ' (Imported)',
    version: '0.1.0-draft',
    status: 'draft',
    revision: 0
  }, id);

  return prisma.form.create({
    data: {
      id,
      parent_id: id,
      name: canonicalForm.name,
      version: canonicalForm.version,
      status: 'draft',
      canonical_json: canonicalForm as any
    }
  });
}
