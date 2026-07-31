import { Router } from 'express';
import type { PluginActionContext } from 'plugin-api';
import { pluginRegistry } from '../plugins/pluginRegistry';
import { getConfig, getPluginSettings, getSafePluginSettings, saveConfig, savePluginSettings } from '../services/configService';
import { getPluginPackageStatuses, loadPluginPackage, unloadPluginPackage } from '../plugins/pluginRegistry';
import { requireAuth } from '../middleware/auth';
import prisma from '../db/prisma';
import { asyncHandler } from '../middleware/errorHandler';

const router = Router();

function globalSettingsContribution(pluginId: string): any {
  return pluginRegistry.getContributions().find((item) => item.pluginId === pluginId && item.extensionPoint === 'settings' && (item as any).scope === 'global');
}

function declaredSettingsKeys(contribution: any): string[] | undefined {
  const properties = contribution?.propertySchema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return undefined;
  return Object.keys(properties);
}

router.get('/', (_req, res) => {
  res.json({ ...pluginRegistry.snapshot(), packages: getPluginPackageStatuses() });
});

router.get('/settings/:pluginId', (req, res) => {
  const pluginId = typeof req.params.pluginId === 'string' ? req.params.pluginId : '';
  const contribution = globalSettingsContribution(pluginId);
  if (!contribution) return res.status(404).json({ error: 'Global plugin settings are not declared' });
  return res.json({
    pluginId,
    settings: getSafePluginSettings(pluginId, contribution.secretKeys || []),
    contribution,
  });
});

router.post('/settings/:pluginId', (req, res) => {
  const pluginId = typeof req.params.pluginId === 'string' ? req.params.pluginId : '';
  const contribution = globalSettingsContribution(pluginId);
  if (!contribution) return res.status(404).json({ error: 'Global plugin settings are not declared' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Settings must be an object' });
  const allowedKeys = declaredSettingsKeys(contribution);
  const updates = req.body as Record<string, unknown>;
  if (allowedKeys && Object.keys(updates).some((key) => !allowedKeys.includes(key))) return res.status(400).json({ error: 'Unknown plugin setting' });
  savePluginSettings(pluginId, updates);
  return res.json({
    pluginId,
    settings: getSafePluginSettings(pluginId, contribution.secretKeys || []),
    contribution,
  });
});

router.post('/actions/:pluginId/:actionId', requireAuth, asyncHandler(async (req, res) => {
  const pluginId = typeof req.params.pluginId === 'string' ? req.params.pluginId : '';
  const actionId = typeof req.params.actionId === 'string' ? req.params.actionId : '';
  console.log(`[PluginRoutes] POST /actions/${pluginId}/${actionId} received`);

  const contribution = pluginRegistry.getContributions().find((item) => (item.pluginId === pluginId || (item.pluginId === 'org.openehr.aql-prefill' && pluginId === 'formbuilder-plugin-aql-prefill') || (item.pluginId === 'formbuilder-plugin-aql-prefill' && pluginId === 'org.openehr.aql-prefill')) && ['settings', 'runtime', 'form'].includes(item.extensionPoint) && (item as any).actionId === actionId);
  if (!contribution) {
    console.warn(`[PluginRoutes] Action not declared for ${pluginId}:${actionId}`);
    return res.status(404).json({ error: 'Plugin action is not declared' });
  }

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, any> : {};
  const context: PluginActionContext = {
    formId: typeof body.formId === 'string' ? body.formId : undefined,
    patientId: typeof body.patientId === 'string' ? body.patientId : undefined,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    userId: req.auth?.id,
    form: body.form && typeof body.form === 'object' && !Array.isArray(body.form) ? body.form : {},
    data: body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {},
    metadata: {
      ...(body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {}),
      authMode: req.auth?.authMode || 'local',
      pluginSettings: getPluginSettings(contribution.pluginId),
      authorization: req.headers.authorization,
    },
  };
  try {
    if (contribution.extensionPoint === 'settings' && context.formId) {
      const storedForm = await prisma.form.findUnique({ where: { id: context.formId } });
      if (!storedForm) return res.status(404).json({ error: 'Form not found' });
      context.form = {
        ...(storedForm.canonical_json as Record<string, any>),
        id: storedForm.id,
        version: storedForm.version,
        name: storedForm.name,
      };
    }
    const result = await pluginRegistry.runAction(contribution.pluginId, actionId, context);
    if (result.errors && result.errors.length > 0) {
      console.warn(`[PluginRoutes] Action ${contribution.pluginId}:${actionId} returned errors:`, result.errors);
      return res.status(422).json(result);
    }
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to execute plugin action';
    console.error(`[PluginRoutes] Action ${contribution.pluginId}:${actionId} threw exception:`, message);
    return res.status(400).json({ error: message });
  }
}));

router.post('/load', asyncHandler(async (req, res) => {
  const packageName = typeof req.body?.packageName === 'string' ? req.body.packageName.trim() : '';
  if (!packageName) return res.status(400).json({ error: 'packageName is required' });

  try {
    const manifest = await loadPluginPackage(packageName);
    const configured = getConfig().pluginPackages || [];
    if (!configured.includes(packageName)) saveConfig({ pluginPackages: [...configured, packageName] });
    return res.status(201).json({ ...pluginRegistry.snapshot(), packageName, manifest, packages: getPluginPackageStatuses() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load plugin';
    return res.status(400).json({ error: message });
  }
}));

router.post('/unload', (req, res) => {
  const packageName = typeof req.body?.packageName === 'string' ? req.body.packageName.trim() : '';
  if (!packageName) return res.status(400).json({ error: 'packageName is required' });

  try {
    const removed = unloadPluginPackage(packageName);
    if (!removed) return res.status(404).json({ error: 'Plugin package is not loaded' });
    const configured = (getConfig().pluginPackages || []).filter((name) => name !== packageName);
    saveConfig({ pluginPackages: configured });
    return res.json({ ...pluginRegistry.snapshot(), packageName, enabled: false, packages: getPluginPackageStatuses() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to unload plugin';
    return res.status(400).json({ error: message });
  }
});

export default router;
