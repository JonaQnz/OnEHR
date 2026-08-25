import { Router } from 'express';
import type { PluginActionContext } from 'plugin-api';
import { pluginRegistry } from '../plugins/pluginRegistry';
import { getConfig, getPluginSettings, getSafePluginSettings, saveConfig, savePluginSettings } from '../services/configService';
import { resolveActiveEhrbaseAuthorizationHeader } from '../services/ehrbaseConnectionPlugins';
import { getPluginPackageStatuses, loadPluginPackage, unloadPluginPackage } from '../plugins/pluginRegistry';
import { requirePermission } from '../middleware/auth';
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

// Runtime clients need the catalog to render declared form contributions, but
// changing plugin packages remains an administrative operation.
router.get('/', requirePermission('form.execute'), (_req, res) => {
  res.json({ ...pluginRegistry.snapshot(), packages: getPluginPackageStatuses() });
});

/** The Composition designer only exposes explicit widget package contributions. */
router.get('/widget-packages', requirePermission('form.design'), asyncHandler(async (_req, res) => {
  const contributions = pluginRegistry.getContributions()
    .filter((contribution) => contribution.extensionPoint === 'widget') as Array<any>;
  const requestedFunctions = contributions.flatMap((contribution) => contribution.widgets.map((widget: any) => widget.aqlFunction));
  const availableFunctions = await prisma.aqlFunction.findMany({
    where: { enabled: true, OR: requestedFunctions.map((functionRef: any) => ({ packageName: functionRef.packageName, name: functionRef.name })) },
    select: { id: true, packageName: true, name: true },
  });
  const functionIds = new Map(availableFunctions.map((item) => [`${item.packageName}.${item.name}`, item.id]));
  const packages = contributions.map((contribution) => {
    const widgets = contribution.widgets.map((widget: any) => {
      const aqlFunctionId = functionIds.get(`${widget.aqlFunction.packageName}.${widget.aqlFunction.name}`);
      return { ...widget, ...(aqlFunctionId ? { aqlFunctionId } : {}), available: Boolean(aqlFunctionId) };
    });
    return {
      id: `${contribution.pluginId}:${contribution.packageId}`,
      pluginId: contribution.pluginId,
      packageId: contribution.packageId,
      key: contribution.key,
      label: contribution.label,
      widgets,
      available: widgets.some((widget: any) => widget.available),
    };
  });
  // The technical Widget Editor persists configured widgets in the database.
  // They are first-party widget packages for the designer as well: unlike a
  // plugin declaration they already own a validated AQL mapping and must be
  // referenced by widgetId so runtime execution cannot drift from that mapping.
  const storedWidgets = await prisma.dataWidget.findMany({
    where: { enabled: true },
    select: { id: true, name: true, description: true, aqlFunctionId: true, configuration: true },
    orderBy: { name: 'asc' },
  });
  if (storedWidgets.length > 0) {
    const customWidgetsByPackage = new Map<string, typeof storedWidgets>();
    for (const widget of storedWidgets) {
      const configuration = widget.configuration && typeof widget.configuration === 'object' && !Array.isArray(widget.configuration)
        ? widget.configuration as Record<string, unknown>
        : {};
      const pkgName = typeof configuration.packageName === 'string' && configuration.packageName.trim() ? configuration.packageName.trim() : 'Konfigurierte Widgets';
      if (!customWidgetsByPackage.has(pkgName)) customWidgetsByPackage.set(pkgName, []);
      customWidgetsByPackage.get(pkgName)!.push(widget);
    }
    
    // Sort packages alphabetically, but keep "Konfigurierte Widgets" last
    const packageNames = Array.from(customWidgetsByPackage.keys()).sort((a, b) => {
      if (a === 'Konfigurierte Widgets') return 1;
      if (b === 'Konfigurierte Widgets') return -1;
      return a.localeCompare(b);
    });

    for (const pkgName of packageNames) {
      const widgetsInPkg = customWidgetsByPackage.get(pkgName)!;
      const pkgIdSafe = pkgName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      packages.push({
        id: `watehr:custom-widgets:${pkgIdSafe}`,
        pluginId: `watehr.custom-widgets.${pkgIdSafe}`,
        packageId: `custom-widgets-${pkgIdSafe}`,
        key: `watehr.custom-widgets.${pkgIdSafe}`,
        label: pkgName,
        available: true,
        widgets: widgetsInPkg.map((widget) => {
          const configuration = widget.configuration && typeof widget.configuration === 'object' && !Array.isArray(widget.configuration)
            ? widget.configuration as Record<string, unknown>
            : {};
          const display = configuration.display;
          const chartType = display === 'line' || display === 'area' || display === 'bar' || display === 'metric' || display === 'table' || display === 'text'
            ? display
            : 'table';
          return {
            id: widget.id,
            widgetId: widget.id,
            title: widget.name,
            ...(widget.description ? { description: widget.description } : {}),
            aqlFunctionId: widget.aqlFunctionId,
            requiredContext: ['ehrId'],
            columns: {
              value: typeof configuration.valueColumn === 'string' ? configuration.valueColumn : 'value',
              ...(typeof configuration.labelColumn === 'string' ? { label: configuration.labelColumn } : {}),
              ...(typeof configuration.timeColumn === 'string' ? { time: configuration.timeColumn } : {}),
            },
            chart: { type: chartType },
            available: true,
          };
        }),
      });
    }
  }
  res.json({ packages });
}));

router.get('/settings/:pluginId', requirePermission('plugin.configure'), (req, res) => {
  const pluginId = typeof req.params.pluginId === 'string' ? req.params.pluginId : '';
  const contribution = globalSettingsContribution(pluginId);
  if (!contribution) return res.status(404).json({ error: 'Global plugin settings are not declared' });
  return res.json({
    pluginId,
    settings: getSafePluginSettings(pluginId, contribution.secretKeys || []),
    contribution,
  });
});

router.post('/settings/:pluginId', requirePermission('plugin.configure'), (req, res) => {
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

router.post('/actions/:pluginId/:actionId', requirePermission('form.execute'), asyncHandler(async (req, res) => {
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
    userId: req.principal?.userId,
    principal: req.principal,
    form: body.form && typeof body.form === 'object' && !Array.isArray(body.form) ? body.form : {},
    data: body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data : {},
    metadata: {
      ...(body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {}),
      authSource: req.principal?.authSource || 'local',
      pluginSettings: getPluginSettings(contribution.pluginId),
    },
  };
  // The AQL prefill plugin calls EHRbase itself and needs the active
  // connection's URL/credentials to do so. Resolve them here, where the
  // config/connection services are directly available, instead of the
  // plugin having to reach across the package boundary for them.
  if (contribution.pluginId === 'org.openehr.aql-prefill') {
    context.metadata!.ehrbaseUrl = getConfig().ehrbaseUrl ?? null;
    if (!context.metadata!.authorization) {
      context.metadata!.authorization = await resolveActiveEhrbaseAuthorizationHeader().catch(() => undefined) ?? null;
    }
  }
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

router.post('/load', requirePermission('plugin.configure'), asyncHandler(async (req, res) => {
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

router.post('/unload', requirePermission('plugin.configure'), (req, res) => {
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
