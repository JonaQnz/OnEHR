import { Router } from 'express';
import { parseWebTemplate, isContextOrIgnoredNode } from '../parsers/webTemplateParser';
import prisma from '../db/prisma';
import { listRemoteTemplates, getRemoteWebTemplate } from '../services/ehrbaseService';
import { asyncHandler, HttpError } from '../middleware/errorHandler';

const router = Router();

function getClinicalTemplateVersion(webTemplate: any): string {
  if (typeof webTemplate.semVer === 'string' && webTemplate.semVer.trim()) {
    return webTemplate.semVer.trim();
  }

  const versionedId = String(webTemplate.templateId || '').match(/\.v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
  return versionedId?.[1] || '1.0.0';
}

router.get('/', asyncHandler(async (_req, res) => {
  const templates = await prisma.template.findMany();
  res.json(templates);
}));

router.get('/remote', asyncHandler(async (_req, res) => {
  res.json(await listRemoteTemplates());
}));

router.post('/remote/:templateId/import', asyncHandler(async (req, res) => {
  const templateId = typeof req.params.templateId === 'string' ? req.params.templateId : undefined;
  if (!templateId) throw new HttpError(400, 'templateId is required');
  const webTemplate = await getRemoteWebTemplate(templateId);
  const parsed = parseWebTemplate(webTemplate);
  const template = await prisma.template.create({
    data: {
      template_id: parsed.templateId,
      version: getClinicalTemplateVersion(webTemplate),
      type: 'openEhrWebTemplate',
      alias: parsed.alias,
      parsed_registry_json: { fields: parsed.fields, layout: parsed.layout } as any,
    },
  });
  res.json({ message: 'Template imported from EHRbase', template });
}));

router.post('/import', asyncHandler(async (req, res) => {
  const webTemplate = req.body;
  const parsed = parseWebTemplate(webTemplate);
  const template = await prisma.template.create({
    data: {
      template_id: parsed.templateId,
      version: getClinicalTemplateVersion(webTemplate),
      type: 'openEhrWebTemplate',
      alias: parsed.alias,
      parsed_registry_json: { fields: parsed.fields, layout: parsed.layout } as any,
    },
  });
  res.json({ message: 'Template imported', template });
}));

router.get('/:id/fields', asyncHandler(async (req, res) => {
  const templateId = typeof req.params.id === 'string' ? req.params.id : undefined;
  if (!templateId) throw new HttpError(400, 'id is required');
  const template = await prisma.template.findUnique({ where: { id: templateId } });
  if (!template) throw new HttpError(404, 'Template not found');
  const data = template.parsed_registry_json as any;
  const fields = Array.isArray(data) ? data : (data?.fields || []);
  res.json(fields.filter((field: any) => !isContextOrIgnoredNode(field)));
}));

export default router;
