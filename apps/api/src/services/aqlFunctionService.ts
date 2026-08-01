import axios from 'axios';
import prisma from '../db/prisma';
import type { FormDataProviderContext, FormDataProviderForm } from 'core';
import { HttpError } from '../middleware/errorHandler';
import { getConfig } from './configService';
import { getValidToken } from './authService';
import { EhrbaseDataProvider, type LatestCompositionContext } from './ehrbaseDataProvider';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
const QUALIFIED_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
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
  query: string;
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
  id: string; packageName: string; name: string; description: string; query: string;
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

export function qualifiedAqlFunctionName(packageName: string, name: string): string {
  return `${packageName}.${name}`;
}

export function validateAqlFunctionInput(value: unknown): {
  packageName: string; name: string; description: string; query: string;
  parameters: Record<string, AqlFunctionParameter>; autoload: boolean; enabled: boolean;
} {
  if (!isRecord(value)) throw new HttpError(400, 'AQL function payload must be an object');
  const packageName = typeof value.packageName === 'string' ? value.packageName.trim() : '';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const query = typeof value.query === 'string' ? value.query.trim() : '';
  if (!QUALIFIED_NAME.test(`${packageName}.${name}`)) {
    throw new HttpError(400, 'packageName and name must form a lower-case qualified function name');
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

async function ehrbaseRequestOptions(): Promise<{ headers: Record<string, string>; auth?: { username: string; password: string } }> {
  const config = getConfig();
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (config.authMode === 'keycloak') {
    headers.Authorization = `Bearer ${await getValidToken()}`;
    return { headers };
  }
  if (!config.ehrbaseUser || !config.ehrbasePass) throw new HttpError(503, 'EHRbase credentials are not configured');
  return { headers, auth: { username: config.ehrbaseUser, password: config.ehrbasePass } };
}

export async function executeAqlQuery(query: string, parameters: Record<string, unknown>): Promise<unknown> {
  const config = getConfig();
  if (!config.ehrbaseUrl) throw new HttpError(503, 'EHRbase URL is not configured');
  const response = await axios.post(
    `${config.ehrbaseUrl.replace(/\/$/, '')}/query/aql`,
    { q: bindAqlParameters(query, parameters) },
    await ehrbaseRequestOptions(),
  );
  return response.data?.rows ?? [];
}

export async function listAqlFunctions(): Promise<AqlFunctionDefinition[]> {
  const records = await prisma.aqlFunction.findMany({ orderBy: [{ packageName: 'asc' }, { name: 'asc' }] });
  return records.map(publicDefinition);
}

export async function createAqlFunction(input: unknown): Promise<AqlFunctionDefinition> {
  const data = validateAqlFunctionInput(input);
  try {
    return publicDefinition(await prisma.aqlFunction.create({ data: { ...data, parameters: data.parameters as any } }));
  } catch (error: any) {
    if (error?.code === 'P2002') throw new HttpError(409, `AQL function '${qualifiedAqlFunctionName(data.packageName, data.name)}' already exists`);
    throw error;
  }
}

export async function updateAqlFunction(id: string, input: unknown): Promise<AqlFunctionDefinition> {
  const data = validateAqlFunctionInput(input);
  try {
    return publicDefinition(await prisma.aqlFunction.update({ where: { id }, data: { ...data, parameters: data.parameters as any } }));
  } catch (error: any) {
    if (error?.code === 'P2025') throw new HttpError(404, 'AQL function not found');
    if (error?.code === 'P2002') throw new HttpError(409, `AQL function '${qualifiedAqlFunctionName(data.packageName, data.name)}' already exists`);
    throw error;
  }
}

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

  const functions = await prisma.aqlFunction.findMany({ where: { enabled: true, autoload: true }, orderBy: [{ packageName: 'asc' }, { name: 'asc' }] });
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
      result.aql[qualifiedName] = await executeAqlQuery(definition.query, parameters);
    } catch (error: any) {
      result.errors.push({ source: 'aql', function: qualifiedName, message: error?.message || 'AQL function failed' });
    }
  }
  const codeFunctions = await prisma.codeFunction.findMany({ where: { enabled: true }, orderBy: [{ packageName: 'asc' }, { name: 'asc' }] });
  result.codeFunctions = codeFunctions.map((item) => ({ packageName: item.packageName, name: item.name, source: item.source }));
  return result.errors.length > 0
    ? result
    : { composition: result.composition, aql: result.aql, codeFunctions: result.codeFunctions };
}
