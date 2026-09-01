import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OnehrApiClient } from './api-client.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(scriptDirectory, '..');
const manifest = await readJson(path.join(packageDirectory, 'manifest.json'));
const packageId = manifest.packageId;
const dryRun = process.env.ONEHR_DRY_RUN === '1';
const allowNameReuse = process.env.ONEHR_ALLOW_NAME_REUSE === '1';
const api = new OnehrApiClient();

const aqlFunctions = await readJson(path.join(packageDirectory, 'data/aql-functions.json'));
const codeFunctions = await readJson(path.join(packageDirectory, 'data/code-functions.json'));
const widgets = await readJson(path.join(packageDirectory, 'data/data-widgets.json'));
const pluginConfig = await readJson(path.join(packageDirectory, 'config/plugins.json'));
const formExports = new Map();
for (const definition of manifest.forms) {
  formExports.set(definition.sourceId, await readJson(path.join(packageDirectory, definition.file)));
}

validatePackage();
await verifyRemoteTemplateDependencies();
await ensurePlugins();
const aqlIdMap = await upsertAqlFunctions();
await upsertCodeFunctions();
const widgetIdMap = await upsertWidgets(aqlIdMap);
const formIdMap = await importForms(aqlIdMap, widgetIdMap);

console.log(JSON.stringify({
  dryRun,
  packageId,
  mappedAqlFunctions: aqlIdMap.size,
  mappedWidgets: widgetIdMap.size,
  mappedForms: manifest.forms.length,
  dependencyAliases: Object.keys(manifest.dependencyAliases || {}).length,
}));

function validatePackage() {
  if (manifest.contents.templates !== 0) throw new Error('This package must not contain templates');
  if (manifest.forms.length !== 16) throw new Error(`Expected 16 form exports, found ${manifest.forms.length}`);
  if (!Array.isArray(aqlFunctions) || !Array.isArray(codeFunctions) || !Array.isArray(widgets)) {
    throw new Error('Function/widget artifacts must be JSON arrays');
  }
  for (const definition of manifest.forms) {
    const exported = formExports.get(definition.sourceId);
    if (exported?.exportVersion !== '1.0' || exported?.form?.id !== definition.sourceId) {
      throw new Error(`Broken full export artifact for ${definition.sourceId}`);
    }
  }
}

async function verifyRemoteTemplateDependencies() {
  const remoteTemplates = await api.get('/api/templates/remote');
  const remoteIds = new Set((remoteTemplates || []).map((item) => item.template_id));
  for (const templateId of manifest.requiredRemoteTemplateIds) {
    if (!remoteIds.has(templateId)) {
      throw new Error(`Required template ${templateId} is not available on the target EHRbase; no template is sent by this package`);
    }
  }
}

async function ensurePlugins() {
  const snapshot = await api.get('/api/plugins');
  const loaded = new Set((snapshot?.packages || []).filter((entry) => entry.enabled).map((entry) => entry.packageName));
  for (const packageName of pluginConfig.enabledPackageNames) {
    if (loaded.has(packageName)) continue;
    if (dryRun) console.log(`[dry-run] would load plugin ${packageName}`);
    else await api.post('/api/plugins/load', { packageName });
  }
}

async function upsertAqlFunctions() {
  const existing = (await api.get('/api/functions/aql'))?.functions || [];
  const byName = new Map(existing.map((item) => [`${item.packageName}::${item.name}`, item]));
  const idMap = new Map();
  for (const source of aqlFunctions) {
    const payload = pick(source, ['packageName', 'name', 'description', 'query', 'parameters', 'autoload', 'enabled']);
    const key = `${source.packageName}::${source.name}`;
    const target = byName.get(key);
    let saved = target;
    if (!target) {
      saved = dryRun ? { ...payload, id: `dry-aql-${source.id}` } : await api.post('/api/functions/aql', payload);
      if (dryRun) console.log(`[dry-run] would create AQL function ${key}`);
    } else if (!equivalent(payload, pick(target, Object.keys(payload)))) {
      saved = dryRun ? { ...target, ...payload } : await api.put(`/api/functions/aql/${encodeURIComponent(target.id)}`, payload);
      if (dryRun) console.log(`[dry-run] would update AQL function ${key}`);
    }
    idMap.set(source.id, saved.id);
  }
  return idMap;
}

async function upsertCodeFunctions() {
  const existing = (await api.get('/api/functions/code'))?.functions || [];
  const byName = new Map(existing.map((item) => [`${item.packageName}::${item.name}`, item]));
  for (const source of codeFunctions) {
    const payload = pick(source, ['packageName', 'name', 'description', 'source', 'enabled']);
    const key = `${source.packageName}::${source.name}`;
    const target = byName.get(key);
    if (!target) {
      if (dryRun) console.log(`[dry-run] would create code function ${key}`);
      else await api.post('/api/functions/code', payload);
    } else if (!equivalent(payload, pick(target, Object.keys(payload)))) {
      if (dryRun) console.log(`[dry-run] would update code function ${key}`);
      else await api.put(`/api/functions/code/${encodeURIComponent(target.id)}`, payload);
    }
  }
}

async function upsertWidgets(aqlIdMap) {
  const existing = (await api.get('/api/widgets'))?.widgets || [];
  const idMap = new Map();
  for (const source of widgets) {
    const matching = existing.filter((item) => item.name === source.name);
    if (matching.length > 1) throw new Error(`Multiple target widgets are named "${source.name}"`);
    const remappedAqlId = aqlIdMap.get(source.aqlFunctionId);
    if (!remappedAqlId) throw new Error(`Widget "${source.name}" references missing AQL function ${source.aqlFunctionId}`);
    const payload = {
      name: source.name,
      description: source.description,
      aqlFunctionId: remappedAqlId,
      configuration: source.configuration,
      enabled: source.enabled,
    };
    const target = matching[0];
    let saved = target;
    if (!target) {
      saved = dryRun ? { ...payload, id: `dry-widget-${source.id}` } : await api.post('/api/widgets', payload);
      if (dryRun) console.log(`[dry-run] would create widget ${source.name}`);
    } else if (!equivalent(payload, pick(target, Object.keys(payload)))) {
      saved = dryRun ? { ...target, ...payload } : await api.put(`/api/widgets/${encodeURIComponent(target.id)}`, payload);
      if (dryRun) console.log(`[dry-run] would update widget ${source.name}`);
    }
    idMap.set(source.id, saved.id);
  }
  return idMap;
}

async function importForms(aqlIdMap, widgetIdMap) {
  const summaries = await api.get('/api/forms?summary=true');
  const idMap = new Map();
  const sections = manifest.forms.filter((item) => item.role === 'section');
  const compositions = manifest.forms.filter((item) => item.role === 'composition');
  for (const definition of sections) {
    await importOneForm(definition, summaries, idMap, aqlIdMap, widgetIdMap);
  }
  for (const [alias, sourceId] of Object.entries(manifest.dependencyAliases || {})) {
    const targetId = idMap.get(sourceId);
    if (!targetId) throw new Error(`Dependency alias ${alias} points to unmapped source form ${sourceId}`);
    idMap.set(alias, targetId);
  }
  for (const definition of compositions) {
    await importOneForm(definition, summaries, idMap, aqlIdMap, widgetIdMap);
  }
  return idMap;
}

async function importOneForm(definition, summaries, formIdMap, aqlIdMap, widgetIdMap) {
  const exported = formExports.get(definition.sourceId);
  const replacements = new Map([...aqlIdMap, ...widgetIdMap, ...formIdMap]);
  const remapped = deepRemap(structuredClone(exported.form), replacements);
  remapped.extensions = {
    ...(remapped.extensions || {}),
    'onehr.importPackage': {
      packageId,
      packageVersion: manifest.packageVersion,
      sourceId: definition.sourceId,
      sourceVersion: definition.sourceVersion,
    },
  };
  if (definition.role === 'composition') validateCompositionReferences(definition, remapped, formIdMap, widgetIdMap);

  const existing = await findExistingImportedForm(definition, summaries);
  if (existing?.status === 'published') {
    formIdMap.set(definition.sourceId, existing.id);
    return;
  }
  if (dryRun) {
    const simulatedId = existing?.id || `dry-form-${definition.sourceId}`;
    formIdMap.set(definition.sourceId, simulatedId);
    console.log(`[dry-run] would ${existing ? 'resume' : 'import'} and publish form ${definition.name}`);
    return;
  }

  const imported = existing
    ? { form: existing }
    : await api.post('/api/forms/import/full', { exportVersion: '1.0', form: remapped });
  const targetId = imported?.form?.id;
  if (!targetId) throw new Error(`Import API returned no form ID for ${definition.name}`);
  const draft = {
    ...remapped,
    id: targetId,
    name: definition.name,
    version: '0.1.0-draft',
    status: 'draft',
    revision: 0,
  };
  await api.put(`/api/forms/${encodeURIComponent(targetId)}`, draft);
  const published = await api.post(`/api/forms/${encodeURIComponent(targetId)}/publish`);
  const publishedId = published?.form?.id || targetId;
  formIdMap.set(definition.sourceId, publishedId);
  summaries.push({ id: publishedId, name: definition.name, status: 'published' });
}

async function findExistingImportedForm(definition, summaries) {
  const candidates = summaries.filter((item) => (
    item.name === definition.name || item.name === `${definition.name} (Imported)`
  ));
  for (const candidate of candidates) {
    const full = await api.get(`/api/forms/${encodeURIComponent(candidate.id)}`);
    const marker = full?.canonical_json?.extensions?.['onehr.importPackage'];
    if (marker?.packageId === packageId && marker?.sourceId === definition.sourceId) {
      if (!['draft', 'published'].includes(candidate.status)) {
        throw new Error(`Marked form ${candidate.id} has unsupported status ${candidate.status}`);
      }
      return candidate;
    }
  }
  const publishedNameCollisions = candidates.filter(
    (item) => item.status === 'published' && item.name === definition.name,
  );
  if (publishedNameCollisions.length === 0) return undefined;
  if (allowNameReuse && publishedNameCollisions.length === 1) {
    console.log(`Reusing unmarked published form by name: ${definition.name}`);
    return publishedNameCollisions[0];
  }
  throw new Error(
    `Published form name collision for "${definition.name}". Set ONEHR_ALLOW_NAME_REUSE=1 to explicitly reuse a single existing form.`,
  );
}

function validateCompositionReferences(definition, canonical, formIdMap, widgetIdMap) {
  const formTargetIds = new Set(formIdMap.values());
  const widgetTargetIds = new Set(widgetIdMap.values());
  visit(canonical, (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (value.type === 'form' && Object.hasOwn(value, 'formId') && (!value.formId || !formTargetIds.has(value.formId))) {
      throw new Error(`Composition "${definition.name}" contains an unmapped form block reference ${value.formId || '<missing>'}`);
    }
    if (value.type === 'data' && value.widgetId && !widgetTargetIds.has(value.widgetId)) {
      throw new Error(`Composition "${definition.name}" contains an unmapped data-widget reference ${value.widgetId}`);
    }
  });
}

function visit(value, callback) {
  callback(value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) visit(item, callback);
  }
}

function deepRemap(value, replacements) {
  if (typeof value === 'string') return replacements.get(value) || value;
  if (Array.isArray(value)) return value.map((item) => deepRemap(item, replacements));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepRemap(item, replacements)]));
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}

function equivalent(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}
