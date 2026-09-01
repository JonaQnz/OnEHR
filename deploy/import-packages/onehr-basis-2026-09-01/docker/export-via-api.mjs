import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OnehrApiClient } from './api-client.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(scriptDirectory, '..');
const dataDirectory = path.join(packageDirectory, 'data');
const formsDirectory = path.join(dataDirectory, 'forms');
const configDirectory = path.join(packageDirectory, 'config');

const formSelection = [
  { id: '66f056d4-de67-4650-8732-0b131a5152b1', file: '01-person-basis.json', role: 'section' },
  { id: '2e06e44e-1b9a-40c4-bc5b-d7efc139abe1', file: '02-diagnose-basis.json', role: 'section' },
  { id: '226ee58f-0d8e-4309-b744-4098580f469f', file: '03-medikation-basis.json', role: 'section' },
  { id: '1d7db2e8-f483-431f-94aa-d9d49115bfd8', file: '04-prozedur-basis.json', role: 'section' },
  { id: '7505912b-72ec-4181-9288-e77bb2670ca9', file: '05-anordnung-basis.json', role: 'section' },
  { id: '7c1210b2-39a4-4b4a-a479-62c1925fe38f', file: '06-laborwert-basis.json', role: 'section' },
  { id: '3de1ad0c-41d5-4c9e-a788-f60287f8b999', file: '07-arzneimittelgabe-basis.json', role: 'section' },
  { id: '2c2724c9-59a4-4b44-908a-556f4a771de4', file: '08-medikamentengabe-emar.json', role: 'section' },
  { id: '8acb2b68-6be5-4217-ab28-9b00bc094f96', file: '09-laborbericht-panel.json', role: 'section' },
  { id: 'a78f1088-44cb-4d98-87b8-8fd4c18974fd', file: '10-anordnung-einzelformular.json', role: 'composition' },
  { id: 'eda16486-e4c3-4d84-859e-87e7f6c505cf', file: '11-diagnose-einzelformular.json', role: 'composition' },
  { id: 'a1a92b8f-e5ef-4f35-9f64-c18ef4e8fc13', file: '12-laborbericht-panel-einzelformular.json', role: 'composition' },
  { id: '8338ddde-26d9-49fd-8edf-095d12415edc', file: '13-laborwert-einzelformular.json', role: 'composition' },
  { id: '5bc67710-d0e3-4301-ba43-cc93a8f29bec', file: '14-medikamentengabe-einzelformular.json', role: 'composition' },
  { id: '6e2c3a61-df64-4771-8507-0ee30cddd055', file: '15-medikation-einzelformular.json', role: 'composition' },
  { id: '573656a0-e52d-4564-a559-47ec8d3cbbf3', file: '16-prozedur-einzelformular.json', role: 'composition' },
];

const api = new OnehrApiClient();
await fs.rm(formsDirectory, { recursive: true, force: true });
await fs.mkdir(formsDirectory, { recursive: true });
await fs.mkdir(configDirectory, { recursive: true });

const manifestForms = [];
const requiredTemplateIds = new Set();
for (const selected of formSelection) {
  const exported = await api.get(`/api/forms/${encodeURIComponent(selected.id)}/export/full`);
  if (exported?.exportVersion !== '1.0' || exported?.form?.id !== selected.id) {
    throw new Error(`Invalid full export returned for form ${selected.id}`);
  }
  for (const template of exported.form.sourceTemplates || []) {
    if (template?.id) requiredTemplateIds.add(template.id);
  }
  await writeJson(path.join(formsDirectory, selected.file), exported);
  manifestForms.push({
    sourceId: selected.id,
    name: exported.form.name,
    sourceVersion: exported.form.version,
    role: selected.role,
    file: `data/forms/${selected.file}`,
  });
}

const [aqlResult, codeResult, widgetResult, pluginResult] = await Promise.all([
  api.get('/api/functions/aql'),
  api.get('/api/functions/code'),
  api.get('/api/widgets'),
  api.get('/api/plugins'),
]);
const aqlFunctions = aqlResult?.functions || [];
const codeFunctions = codeResult?.functions || [];
const widgets = widgetResult?.widgets || [];
const enabledPackageNames = (pluginResult?.packages || [])
  .filter((entry) => entry.enabled)
  .map((entry) => entry.packageName)
  .sort();

await writeJson(path.join(dataDirectory, 'aql-functions.json'), aqlFunctions);
await writeJson(path.join(dataDirectory, 'code-functions.json'), codeFunctions);
await writeJson(path.join(dataDirectory, 'data-widgets.json'), widgets);
await writeJson(path.join(configDirectory, 'plugins.json'), {
  enabledPackageNames,
  builtInSystemConnectionPlugins: ['none', 'basic', 'hip-keycloak'],
  notes: {
    'hip-keycloak': 'Built into onEHR. No connection configuration, tenant URL, username, password, token, or plugin setting is exported.',
  },
});

const manifest = {
  packageId: 'onehr-basis-2026-09-01',
  packageVersion: '2.0.0',
  createdAt: new Date().toISOString(),
  transport: 'onEHR REST API full exports/imports',
  contents: {
    forms: manifestForms.length,
    formSections: manifestForms.filter((item) => item.role === 'section').length,
    singleFormCompositions: manifestForms.filter((item) => item.role === 'composition').length,
    aqlFunctions: aqlFunctions.length,
    codeFunctions: codeFunctions.length,
    dataWidgets: widgets.length,
    templates: 0,
  },
  forms: manifestForms,
  requiredRemoteTemplateIds: [...requiredTemplateIds].sort(),
  dependencyAliases: {
    'ee3e789e-5863-4008-9260-aa0b8f39a8d4': '7505912b-72ec-4181-9288-e77bb2670ca9',
  },
  excludes: [
    'WebTemplates and OPT files',
    'database dumps or SQL',
    'patients and clinical patient data',
    'users, roles, and sessions',
    'EHRbase/HIP connection configuration and credentials',
    'plugin settings and secrets',
    'integration call logs',
  ],
};
await writeJson(path.join(packageDirectory, 'manifest.json'), manifest);
await writeChecksums(packageDirectory);

console.log(JSON.stringify(manifest.contents));

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeChecksums(rootDirectory) {
  const files = [
    'manifest.json',
    'config/plugins.json',
    'data/aql-functions.json',
    'data/code-functions.json',
    'data/data-widgets.json',
    ...formSelection.map((item) => `data/forms/${item.file}`),
  ];
  const lines = [];
  for (const relativePath of files) {
    const content = await fs.readFile(path.join(rootDirectory, relativePath));
    lines.push(`${crypto.createHash('sha256').update(content).digest('hex')}  ${relativePath}`);
  }
  await fs.writeFile(path.join(rootDirectory, 'SHA256SUMS'), `${lines.join('\n')}\n`, 'utf8');
}
