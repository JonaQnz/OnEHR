import { Router } from 'express';
import { parseWebTemplate } from '../parsers/webTemplateParser';
import prisma from '../db/prisma';
import { listRemoteTemplates, getRemoteWebTemplate } from '../services/ehrbaseService';

const router = Router();

function getClinicalTemplateVersion(webTemplate: any): string {
  if (typeof webTemplate.semVer === 'string' && webTemplate.semVer.trim()) {
    return webTemplate.semVer.trim();
  }

  const versionedId = String(webTemplate.templateId || '').match(/\.v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
  return versionedId?.[1] || '1.0.0';
}

router.get('/', async (req, res) => {
  const templates = await prisma.template.findMany();
  res.json(templates);
});

router.get('/remote', async (req, res) => {
  try {
    const templates = await listRemoteTemplates();
    res.json(templates);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/remote/:templateId/import', async (req, res) => {
  try {
    const templateId = req.params.templateId;
    // 1. Fetch from EHRbase
    const webTemplate = await getRemoteWebTemplate(templateId);
    
    // 2. Parse
    const parsed = parseWebTemplate(webTemplate);
    
    // 3. Save to DB
    const template = await prisma.template.create({
      data: {
        template_id: parsed.templateId,
        version: getClinicalTemplateVersion(webTemplate),
        type: 'openEhrWebTemplate',
        alias: parsed.alias,
        parsed_registry_json: {
          fields: parsed.fields,
          layout: parsed.layout
        } as any
      }
    });

    res.json({ message: 'Template imported from EHRbase', template });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/import', async (req, res) => {
  try {
    const webTemplate = req.body;
    const parsed = parseWebTemplate(webTemplate);
    
    // Save to DB
    const template = await prisma.template.create({
      data: {
        template_id: parsed.templateId,
        version: getClinicalTemplateVersion(webTemplate),
        type: 'openEhrWebTemplate',
        alias: parsed.alias,
        parsed_registry_json: {
          fields: parsed.fields,
          layout: parsed.layout
        } as any
      }
    });

    res.json({ message: 'Template imported', template });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id/fields', async (req, res) => {
  try {
    const template = await prisma.template.findUnique({
      where: { id: req.params.id }
    });
    if (!template) return res.status(404).json({ error: 'Template not found' });
    
    const data = template.parsed_registry_json as any;
    const fields = Array.isArray(data) ? data : (data?.fields || []);
    res.json(fields);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
