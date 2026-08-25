import { Router } from 'express';
import { parseWebTemplate, isContextOrIgnoredNode } from '../parsers/webTemplateParser';
import prisma from '../db/prisma';
import { listRemoteTemplates, getRemoteWebTemplate } from '../services/ehrbaseService';
import { asyncHandler, HttpError } from '../middleware/errorHandler';
import { requirePermission } from '../middleware/auth';

const router = Router();

function getClinicalTemplateVersion(webTemplate: any): string {
  if (typeof webTemplate.semVer === 'string' && webTemplate.semVer.trim()) {
    return webTemplate.semVer.trim();
  }

  const versionedId = String(webTemplate.templateId || '').match(/\.v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
  return versionedId?.[1] || '1.0.0';
}

router.get('/', requirePermission('form.execute'), asyncHandler(async (_req, res) => {
  const templates = await prisma.template.findMany();
  res.json(templates);
}));

router.get('/remote', requirePermission('form.design'), asyncHandler(async (_req, res) => {
  res.json(await listRemoteTemplates());
}));

/**
 * Importing the same template_id twice used to always insert a new
 * `Template` row (same template_id, different id) - every re-import (the
 * "get the latest from EHRbase" case, or just picking a template that was
 * already imported again in the New Form dialog) left another orphaned
 * duplicate behind, with nothing in the UI to tell the copies apart. A
 * re-import now refreshes the existing row's content in place instead, so
 * a template_id maps to exactly one local `Template` row - callers still
 * get their version bump, just without a duplicate.
 */
async function upsertTemplate(parsed: ReturnType<typeof parseWebTemplate>, version: string) {
  const existing = await prisma.template.findFirst({ where: { template_id: parsed.templateId } });
  const data = {
    template_id: parsed.templateId,
    version,
    type: 'openEhrWebTemplate',
    alias: parsed.alias,
    parsed_registry_json: { fields: parsed.fields, layout: parsed.layout } as any,
  };
  return existing ? prisma.template.update({ where: { id: existing.id }, data }) : prisma.template.create({ data });
}

router.post('/remote/:templateId/import', requirePermission('form.design'), asyncHandler(async (req, res) => {
  const templateId = typeof req.params.templateId === 'string' ? req.params.templateId : undefined;
  if (!templateId) throw new HttpError(400, 'templateId is required');
  const webTemplate = await getRemoteWebTemplate(templateId);
  const parsed = parseWebTemplate(webTemplate);
  const template = await upsertTemplate(parsed, getClinicalTemplateVersion(webTemplate));
  res.json({ message: 'Template imported from EHRbase', template });
}));

router.post('/import', requirePermission('form.design'), asyncHandler(async (req, res) => {
  const webTemplate = req.body;
  const parsed = parseWebTemplate(webTemplate);
  const template = await upsertTemplate(parsed, getClinicalTemplateVersion(webTemplate));
  res.json({ message: 'Template imported', template });
}));

router.get('/:id/fields', requirePermission('form.execute'), asyncHandler(async (req, res) => {
  const templateId = typeof req.params.id === 'string' ? req.params.id : undefined;
  if (!templateId) throw new HttpError(400, 'id is required');
  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) throw new HttpError(404, 'Template not found');
  const data = template.parsed_registry_json as any;
  const fields = Array.isArray(data) ? data : (data?.fields || []);
  res.json(fields.filter((field: any) => !isContextOrIgnoredNode(field)));
}));

export default router;
