import axios from 'axios';
import prisma from '../db/prisma';
import { getFormFunctionImportConfiguration, type FormDataProviderContext, type FormDataProviderForm } from 'core';
import { HttpError } from '../middleware/errorHandler';
import { getEhrbaseRequestConfig } from './ehrbaseConnectionPlugins';
import { EhrbaseDataProvider, type LatestCompositionContext } from './ehrbaseDataProvider';
import { executeStoredQuery, listStoredQueries, putStoredQuery, rowsFromResultSet } from './ehrbaseService';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
const NAME_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]*$/;
const UNSAFE_AQL = /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\b/i;
const CODE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const UNSAFE_CODE = /\b(import|require|fetch|XMLHttpRequest|WebSocket|eval|Function)\b/;

export interface AqlFunctionParameter {
  default?: string | number | boolean | null;
  required?: boolean;
}

export interface AqlFunctionDefinition {
  id: string;
  packageName: string;
  name: string;
  description: string;
  /** Read-through cache of what's defined on EHRbase under ehrbaseQueryName() - see that function. */
  query: string;
  /** The version EHRbase reports for that definition (e.g. "1.0.0"), or undefined if this row hasn't synced with EHRbase yet. */
  ehrbaseVersion?: string;
  parameters: Record<string, AqlFunctionParameter>;
  autoload: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CodeFunctionDefinition {
  id: string;
  packageName: string;
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

type AqlRecord = {
  id: string; packageName: string; name: string; description: string; query: string; ehrbaseVersion: string | null;
  parameters: unknown; autoload: boolean; enabled: boolean; createdAt: Date; updatedAt: Date;
};
type CodeRecord = { id: string; packageName: string; name: string; description: string; source: string; enabled: boolean; createdAt: Date; updatedAt: Date };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asParameters(value: unknown): Record<string, AqlFunctionParameter> {
  if (!isRecord(value)) return {};
  const result: Record<string, AqlFunctionParameter> = {};
  for (const [key, spec] of Object.entries(value)) {
    if (!IDENTIFIER.test(key) || !isRecord(spec)) continue;
    const defaultValue = spec.default;
    if (defaultValue !== undefined && defaultValue !== null && !['string', 'number', 'boolean'].includes(typeof defaultValue)) continue;
    result[key] = {
      ...(defaultValue !== undefined ? { default: defaultValue as string | number | boolean | null } : {}),
      ...(typeof spec.required === 'boolean' ? { required: spec.required } : {}),
    };
  }
  return result;
}

function publicDefinition(record: AqlRecord): AqlFunctionDefinition {
  return {
    id: record.id,
    packageName: record.packageName,
    name: record.name,
    description: record.description,
    query: record.query,
    ...(record.ehrbaseVersion ? { ehrbaseVersion: record.ehrbaseVersion } : {}),
    parameters: asParameters(record.parameters),
    autoload: record.autoload,
    enabled: record.enabled,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
function publicCodeDefinition(record: CodeRecord): CodeFunctionDefinition {
  return { id: record.id, packageName: record.packageName, name: record.name, description: record.description, source: record.source, enabled: record.enabled, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString() };
}

/** Dot form, e.g. "custom.aktive-diagnosen-anzahl" - used everywhere *within*
 * Forms (formScript's `context.aql[...]` keys, error messages, MCP docs).
 * Unrelated to and independent from ehrbaseQueryName() below; kept as its
 * own convention so nothing that already reads context.aql needs to change. */
export function qualifiedAqlFunctionName(packageName: string, name: string): string {
  return `${packageName}.${name}`;
}

/** `::` form, e.g. "custom::aktive-diagnosen-anzahl" - the actual name this
 * query is (or will be) defined under on EHRbase's own Query Service. Only
 * ever used talking to EHRbase (putStoredQuery/executeStoredQuery/list
 * matching), never inside Forms itself. */
export function ehrbaseQueryName(packageName: string, name: string): string {
  return `${packageName}::${name}`;
}

/** Splits an EHRbase-reported qualified query name ("pkg::name") back into
 * its parts. Returns null for anything not shaped like one of ours (a
 * single "::" separating two lower-case/number/hyphen segments) - stored
 * queries defined by other tools against this same EHRbase instance are
 * deliberately left alone rather than guessed at. */
function splitEhrbaseName(fullName: string): { packageName: string; name: string } | null {
  const parts = fullName.split('::');
  if (parts.length !== 2) return null;
  const [packageName, name] = parts;
  if (!NAME_SEGMENT.test(packageName) || !NAME_SEGMENT.test(name)) return null;
  return { packageName, name };
}

/** Lets query authors keep writing the `:paramName` placeholders Forms has
 * always used - EHRbase's stored-query engine binds `$paramName` instead,
 * so this is translated once here rather than asking every query author to
 * relearn the syntax. */
function normalizeAqlParamSyntax(query: string): string {
  return query.replace(/:([A-Za-z][A-Za-z0-9_]*)\b/g, '$$$1');
}

export function validateAqlFunctionInput(value: unknown): {
  packageName: string; name: string; description: string; query: string;
  parameters: Record<string, AqlFunctionParameter>; autoload: boolean; enabled: boolean;
} {
  if (!isRecord(value)) throw new HttpError(400, 'AQL function payload must be an object');
  const packageName = typeof value.packageName === 'string' ? value.packageName.trim() : '';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const query = typeof value.query === 'string' ? value.query.trim() : '';
  if (!NAME_SEGMENT.test(packageName) || !NAME_SEGMENT.test(name)) {
    throw new HttpError(400, 'packageName and name must each start with a letter and contain only letters, digits, hyphens or underscores: ' + packageName + '::' + name);
  }
  if (!/^SELECT\b/i.test(query) || UNSAFE_AQL.test(query) || query.includes(';')) {
    throw new HttpError(400, 'Only one read-only SELECT AQL query is allowed');
  }
  const rawParameters = value.parameters === undefined ? {} : value.parameters;
  if (!isRecord(rawParameters)) throw new HttpError(400, 'parameters must be an object');
  for (const [key, spec] of Object.entries(rawParameters)) {
    if (!IDENTIFIER.test(key) || !isRecord(spec)) throw new HttpError(400, `Invalid AQL parameter '${key}'`);
    if ('default' in spec && spec.default !== null && !['string', 'number', 'boolean'].includes(typeof spec.default)) {
      throw new HttpError(400, `Invalid default value for AQL parameter '${key}'`);
    }
  }
  return {
    packageName,
    name,
    query,
    description: typeof value.description === 'string' ? value.description.trim() : '',
    parameters: asParameters(rawParameters),
    autoload: value.autoload !== false,
    enabled: value.enabled !== false,
  };
}

export function validateCodeFunctionInput(value: unknown): { packageName: string; name: string; description: string; source: string; enabled: boolean } {
  if (!isRecord(value)) throw new HttpError(400, 'Code function payload must be an object');
  const packageName = typeof value.packageName === 'string' ? value.packageName.trim() : '';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const source = typeof value.source === 'string' ? value.source.trim() : '';
  if (!CODE_IDENTIFIER.test(packageName) || !CODE_IDENTIFIER.test(name)) {
    throw new HttpError(400, 'packageName and name must be valid JavaScript identifiers');
  }
  if (!new RegExp(`^\\s*export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`).test(source)) {
    throw new HttpError(400, `Code must export function ${name}(...)`);
  }
  if (UNSAFE_CODE.test(source)) throw new HttpError(400, 'Code functions cannot import modules or access network/eval APIs');
  return { packageName, name, source, description: typeof value.description === 'string' ? value.description.trim() : '', enabled: value.enabled !== false };
}

function aqlLiteral(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  throw new HttpError(422, 'AQL parameters must be string, number, boolean, or null');
}

/** Replaces only named parameters with safely encoded AQL literals. */
export function bindAqlParameters(query: string, parameters: Record<string, unknown>): string {
  const bound = query.replace(/:([A-Za-z][A-Za-z0-9_]*)\b/g, (placeholder, key: string) => (
    Object.prototype.hasOwnProperty.call(parameters, key) ? aqlLiteral(parameters[key]) : placeholder
  ));
  const unresolved = bound.match(/:([A-Za-z][A-Za-z0-9_]*)\b/);
  if (unresolved) throw new HttpError(422, `Missing AQL parameter '${unresolved[1]}'`);
  return bound;
}

/** Ad-hoc, throwaway AQL execution - the query text lives only in the
 * caller (a debug panel, the patient registry's configured sync query),
 * never registered anywhere. Genuine reusable queries never call this -
 * see executeStoredAqlFunctionRecord below, which runs a query EHRbase
 * itself has stored. */
export async function executeAqlQuery(query: string, parameters: Record<string, unknown>): Promise<unknown> {
  const { ehrbaseUrl, headers, auth } = await getEhrbaseRequestConfig();
  const response = await axios.post(
    `${ehrbaseUrl}/query/aql`,
    { q: bindAqlParameters(query, parameters) },
    { headers, ...(auth ? { auth } : {}) },
  );
  return rowsFromResultSet(response.data);
}

/** Runs a registered AQL Function/Query - i.e. one EHRbase has stored under
 * ehrbaseQueryName(record) - with real server-side parameter binding
 * (`$paramName`, not client-side string substitution). This is what
 * widgets, Composition data blocks, and autoloaded form context actually
 * execute against; executeAqlQuery above is for one-off/debug queries only. */
export async function executeStoredAqlFunctionRecord(record: { packageName: string; name: string }, parameters: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  return executeStoredQuery(ehrbaseQueryName(record.packageName, record.name), parameters);
}

/**
 * The list of queries Forms can bind widgets/forms to. EHRbase's own
 * Query Service is the source of truth for what exists; this reads that
 * list and, for every `packageName::name`-shaped entry, keeps (or creates)
 * a local metadata row - the only place description/parameters/autoload
 * live, since EHRbase's stored-query model doesn't have those. A query
 * defined directly against EHRbase by something other than Forms shows up
 * here too, with sane defaults, the first time this runs after it exists -
 * "loaded", not just whatever Forms itself has created.
 */
/** "1.2.10" > "1.2.9" - plain string/localeCompare gets this wrong, and
 * EHRbase's own list ordering isn't a documented guarantee, so versions
 * are compared numerically here rather than trusting list order. */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
    const diff = (partsA[i] || 0) - (partsB[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function listAqlFunctions(): Promise<AqlFunctionDefinition[]> {
  const [stored, local] = await Promise.all([
    listStoredQueries(),
    prisma.aqlFunction.findMany(),
  ]);
  // GET /definition/query returns every version of every name, not just the
  // latest - keep only each name's newest version before doing anything else,
  // or the loop below would see the same name twice and (for a name with no
  // local row yet) try to create it twice.
  const latestByName = new Map<string, typeof stored[number]>();
  for (const definition of stored) {
    const current = latestByName.get(definition.name);
    if (!current || compareVersions(definition.version, current.version) > 0) latestByName.set(definition.name, definition);
  }
  const localByEhrbaseName = new Map(local.map((record) => [ehrbaseQueryName(record.packageName, record.name), record]));
  const results: AqlFunctionDefinition[] = [];
  for (const definition of latestByName.values()) {
    const parts = splitEhrbaseName(definition.name);
    if (!parts) continue; // Not one of ours (no "pkg::name" shape) - leave whatever defined it alone.
    const existing = localByEhrbaseName.get(definition.name);
    if (existing) {
      const record = (existing.query !== definition.q || existing.ehrbaseVersion !== definition.version)
        // Keep the cache in sync - e.g. someone edited it directly on EHRbase, or defined a version we didn't originate.
        ? await prisma.aqlFunction.update({ where: { id: existing.id }, data: { query: definition.q, ehrbaseVersion: definition.version } })
        : existing;
      results.push(publicDefinition(record));
      continue;
    }
    const created = await prisma.aqlFunction.create({ data: {
      packageName: parts.packageName, name: parts.name, description: '', query: definition.q,
      ehrbaseVersion: definition.version, parameters: {}, autoload: false, enabled: true,
    } });
    results.push(publicDefinition(created));
  }
  return results.sort((a, b) => (a.packageName === b.packageName ? a.name.localeCompare(b.name) : a.packageName.localeCompare(b.packageName)));
}

export async function createAqlFunction(input: unknown): Promise<AqlFunctionDefinition> {
  const data = validateAqlFunctionInput(input);
  const stored = await putStoredQuery(ehrbaseQueryName(data.packageName, data.name), normalizeAqlParamSyntax(data.query));
  try {
    return publicDefinition(await prisma.aqlFunction.create({ data: {
      packageName: data.packageName, name: data.name, description: data.description, query: stored.q,
      ehrbaseVersion: stored.version, parameters: data.parameters as any, autoload: data.autoload, enabled: data.enabled,
    } }));
  } catch (error: any) {
    if (error?.code === 'P2002') {
      // The EHRbase-side PUT above already happened (and, being versioned/permanent, can't be undone) - only the
      // local metadata row failed to save, most likely because listAqlFunctions() auto-discovered this same
      // name in between. Fetch and update that row instead of leaving the new EHRbase version unreferenced.
      const existing = await prisma.aqlFunction.findFirst({ where: { packageName: data.packageName, name: data.name } });
      if (existing) {
        return publicDefinition(await prisma.aqlFunction.update({ where: { id: existing.id }, data: {
          description: data.description, query: stored.q, ehrbaseVersion: stored.version,
          parameters: data.parameters as any, autoload: data.autoload, enabled: data.enabled,
        } }));
      }
    }
    throw error;
  }
}

export async function updateAqlFunction(id: string, input: unknown): Promise<AqlFunctionDefinition> {
  const data = validateAqlFunctionInput(input);
  const existing = await prisma.aqlFunction.findUnique({ where: { id } });
  if (!existing) throw new HttpError(404, 'AQL function not found');
  // Renaming would try to define a brand-new EHRbase query rather than version the existing one - and the old
  // name's definition would still be sitting on EHRbase forever regardless, unreferenced. Simpler to just not
  // allow it: create a new query under the new name instead.
  if (existing.packageName !== data.packageName || existing.name !== data.name) {
    throw new HttpError(400, 'packageName/name cannot be changed after creation - EHRbase stored queries are permanent per name. Create a new query instead.');
  }
  const stored = await putStoredQuery(ehrbaseQueryName(data.packageName, data.name), normalizeAqlParamSyntax(data.query));
  return publicDefinition(await prisma.aqlFunction.update({ where: { id }, data: {
    description: data.description, query: stored.q, ehrbaseVersion: stored.version,
    parameters: data.parameters as any, autoload: data.autoload, enabled: data.enabled,
  } }));
}

/** Only removes Forms' local reference/metadata - EHRbase's own stored-
 * query definition has no delete operation (see ehrbaseService.ts) and
 * stays there permanently. If nothing else re-discovers and re-lists it
 * (listAqlFunctions does, on every call), it simply won't appear here
 * anymore. */
export async function deleteAqlFunction(id: string): Promise<void> {
  try { await prisma.aqlFunction.delete({ where: { id } }); }
  catch (error: any) { if (error?.code === 'P2025') throw new HttpError(404, 'AQL function not found'); throw error; }
}

export async function listCodeFunctions(): Promise<CodeFunctionDefinition[]> {
  const records = await prisma.codeFunction.findMany({ orderBy: [{ packageName: 'asc' }, { name: 'asc' }] });
  return records.map(publicCodeDefinition);
}
export async function createCodeFunction(input: unknown): Promise<CodeFunctionDefinition> {
  const data = validateCodeFunctionInput(input);
  try { return publicCodeDefinition(await prisma.codeFunction.create({ data })); }
  catch (error: any) { if (error?.code === 'P2002') throw new HttpError(409, `Code function '${qualifiedAqlFunctionName(data.packageName, data.name)}' already exists`); throw error; }
}
export async function updateCodeFunction(id: string, input: unknown): Promise<CodeFunctionDefinition> {
  const data = validateCodeFunctionInput(input);
  try { return publicCodeDefinition(await prisma.codeFunction.update({ where: { id }, data })); }
  catch (error: any) { if (error?.code === 'P2025') throw new HttpError(404, 'Code function not found'); if (error?.code === 'P2002') throw new HttpError(409, `Code function '${qualifiedAqlFunctionName(data.packageName, data.name)}' already exists`); throw error; }
}
export async function deleteCodeFunction(id: string): Promise<void> {
  try { await prisma.codeFunction.delete({ where: { id } }); }
  catch (error: any) { if (error?.code === 'P2025') throw new HttpError(404, 'Code function not found'); throw error; }
}

export async function buildSessionRuntimeContext(
  form: FormDataProviderForm,
  context: FormDataProviderContext,
): Promise<{ composition?: LatestCompositionContext; aql: Record<string, unknown>; codeFunctions: Array<{ packageName: string; name: string; source: string }>; errors?: Array<{ source: 'composition' | 'aql'; function?: string; message: string }> }> {
  const result: { composition?: LatestCompositionContext; aql: Record<string, unknown>; codeFunctions: Array<{ packageName: string; name: string; source: string }>; errors: Array<{ source: 'composition' | 'aql'; function?: string; message: string }> } = { aql: {}, codeFunctions: [], errors: [] };
  if (form.definition.sourceTemplates?.[0]?.id) {
    try {
      result.composition = await new EhrbaseDataProvider().loadLatestCompositionContext({ form, context });
    } catch (error: any) {
      result.errors.push({ source: 'composition', message: error?.message || 'Latest composition could not be loaded' });
    }
  }

  const imports = getFormFunctionImportConfiguration(form.definition);
  const functions = imports.aqlFunctionIds.length > 0
    ? await prisma.aqlFunction.findMany({ where: { enabled: true, id: { in: imports.aqlFunctionIds } }, orderBy: [{ packageName: 'asc' }, { name: 'asc' }] })
    : [];
  const templateId = form.definition.sourceTemplates?.[0]?.id;
  for (const definition of functions) {
    const qualifiedName = qualifiedAqlFunctionName(definition.packageName, definition.name);
    const parameterSpec = asParameters(definition.parameters);
    const parameters: Record<string, unknown> = Object.fromEntries(Object.entries(parameterSpec)
      .filter(([, spec]) => spec.default !== undefined)
      .map(([key, spec]) => [key, spec.default]));
    Object.assign(parameters, {
      patientId: context.patientId,
      patientNamespace: context.patientNamespace,
      ehrId: context.ehrId || result.composition?.ehrId,
      templateId,
    });
    try {
      result.aql[qualifiedName] = await executeStoredAqlFunctionRecord(definition, parameters);
    } catch (error: any) {
      result.errors.push({ source: 'aql', function: qualifiedName, message: error?.message || 'AQL function failed' });
    }
  }
  const codeFunctions = imports.codePackages.length > 0
    ? await prisma.codeFunction.findMany({ where: { enabled: true, packageName: { in: imports.codePackages } }, orderBy: [{ packageName: 'asc' }, { name: 'asc' }] })
    : [];
  result.codeFunctions = codeFunctions.map((item) => ({ packageName: item.packageName, name: item.name, source: item.source }));
  return result.errors.length > 0
    ? result
    : { composition: result.composition, aql: result.aql, codeFunctions: result.codeFunctions };
}
