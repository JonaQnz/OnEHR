import axios, { type AxiosInstance } from 'axios';
import type {
  CanonicalForm,
  FormDataProvider,
  FormDataProviderContext,
  FormDataProviderForm,
  FormDataProviderLoadInput,
  FormDataProviderLoadResult,
  FormDataProviderSubmitInput,
  FormDataProviderSubmitResult,
  FormSessionValues,
} from 'core';
import { getConfig } from './configService';
import { getValidToken } from './authService';
import { getRemoteWebTemplate } from './ehrbaseService';

type ProviderHttp = Pick<AxiosInstance, 'get' | 'post' | 'put'>;
type ProviderConfig = ReturnType<typeof getConfig>;
type ProviderResponse = { data: any; headers?: Record<string, any>; status?: number };

export class EhrbaseProviderError extends Error {
  public readonly status?: number;
  public readonly code: string;

  constructor(message: string, code = 'EHRBASE_REQUEST_FAILED', status?: number) {
    super(message);
    this.name = 'EhrbaseProviderError';
    this.code = code;
    this.status = status;
  }
}

function baseUrl(config: ProviderConfig): string {
  if (!config.ehrbaseUrl) throw new EhrbaseProviderError('EHRbase URL is not configured', 'EHRBASE_NOT_CONFIGURED', 503);
  return config.ehrbaseUrl.replace(/\/$/, '');
}

function templateId(form: FormDataProviderForm): string {
  const id = form.definition.sourceTemplates?.[0]?.id;
  if (!id) throw new EhrbaseProviderError('The form has no openEHR source template', 'FORM_TEMPLATE_REQUIRED', 422);
  return id;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function extractEhrId(payload: any): string | undefined {
  const direct = text(payload?.ehr_id?.value) || text(payload?.ehr_id) || text(payload?.ehrId);
  if (direct) return direct;
  const first = Array.isArray(payload?.ehrs) ? payload.ehrs[0] : Array.isArray(payload) ? payload[0] : undefined;
  return text(first?.ehr_id?.value) || text(first?.ehr_id) || text(first?.ehrId);
}

function referenceFrom(response: ProviderResponse): string | undefined {
  const headers = response.headers || {};
  return text(headers.location) || text(headers.Location) || text(response.data?.uid?.value) || text(response.data?.uid);
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function indexedPath(path: string, index: number | undefined): string {
  return index === undefined ? path : `${path}:${index}`;
}

const STRUCTURAL_RM_TYPES = new Set([
  'ACTIVITY', 'CLUSTER', 'SECTION', 'COMPOSITION', 'INSTRUCTION',
  'OBSERVATION', 'EVALUATION', 'ACTION', 'ADMIN_ENTRY',
  'EVENT_CONTEXT', 'HISTORY', 'EVENT', 'POINT_EVENT', 'INTERVAL_EVENT',
  'ITEM_TREE', 'ITEM_LIST', 'ITEM_TABLE', 'ITEM_SINGLE', 'ITEM_STRUCTURE',
  'ELEMENT', 'PARTY_PROXY', 'PARTY_IDENTIFIED', 'PARTY_RELATED', 'PARTY_SELF',
]);

function setFlatValue(output: Record<string, any>, path: string, rmType: string | undefined, value: any, index?: number): void {
  if (isEmpty(value)) return;
  if (rmType && STRUCTURAL_RM_TYPES.has(rmType)) return;
  const key = indexedPath(path, index);
  if (rmType === 'DV_QUANTITY') {
    const quantity = typeof value === 'object' && value !== null ? value : { magnitude: value };
    if (!isEmpty(quantity.magnitude)) output[`${key}|magnitude`] = typeof quantity.magnitude === 'string' && quantity.magnitude.trim() !== '' ? Number(quantity.magnitude) : quantity.magnitude;
    if (!isEmpty(quantity.unit)) output[`${key}|unit`] = quantity.unit;
    return;
  }
  if (rmType === 'DV_CODED_TEXT' || rmType === 'CODE_PHRASE') {
    const coded = typeof value === 'object' && value !== null ? value : { code: value, value };
    const code = !isEmpty(coded.code) ? coded.code : coded.value;
    if (!isEmpty(code)) output[`${key}|code`] = code;
    if (!isEmpty(coded.value)) output[`${key}|value`] = coded.value;
    if (!isEmpty(coded.terminology)) output[`${key}|terminology`] = coded.terminology;
    return;
  }
  if (rmType === 'DV_BOOLEAN') {
    output[key] = value === true || value === 'true';
    return;
  }
  output[key] = value;
}

/**
 * Build aqlPath → flatPath lookup from a WebTemplate tree.
 */
function buildAqlToFlatMap(tree: any): Map<string, { flatPath: string; rmType: string }> {
  const map = new Map<string, { flatPath: string; rmType: string }>();
  function walk(node: any, prefix: string): void {
    const id = node.id || node.name;
    const current = prefix ? `${prefix}/${id}` : id;
    if (node.aqlPath) map.set(node.aqlPath, { flatPath: current, rmType: node.rmType });
    if (node.children) node.children.forEach((c: any) => walk(c, current));
  }
  walk(tree, '');
  return map;
}

/**
 * Walk a form layout tree to collect field-level bindings keyed by field ID.
 */
function collectFieldBindings(layout: any): Map<string, { path: string; rmType?: string; flatPath?: string }> {
  const map = new Map<string, { path: string; rmType?: string; flatPath?: string }>();
  function walk(node: any): void {
    if (node.id && node.binding?.openehr?.path) {
      map.set(node.id, {
        path: node.binding.openehr.path,
        rmType: node.binding.openehr.rmType,
        flatPath: node.binding.openehr.flatPath,
      });
    }
    if (node.children) node.children.forEach(walk);
  }
  walk(layout);
  return map;
}

/**
 * Resolve the flat path for a binding: prefer explicit flatPath, then resolve
 * through WebTemplate aql→flat map, then fall back to the raw path.
 */
function resolveFlatPath(
  binding: { path?: string; rmType?: string; flatPath?: string },
  aqlMap: Map<string, { flatPath: string; rmType: string }> | undefined,
): string | undefined {
  const explicit = text(binding.flatPath);
  if (explicit) return explicit;
  if (binding.path && aqlMap) {
    const resolved = aqlMap.get(binding.path);
    if (resolved) return resolved.flatPath;
  }
  return text(binding.path);
}

export function toEhrbaseFlatComposition(
  definition: CanonicalForm,
  values: FormSessionValues,
  context: FormDataProviderContext,
  webTemplateTree?: any,
): Record<string, any> {
  const templateId = definition.sourceTemplates?.[0]?.id;
  const flat: Record<string, any> = {
    'ctx/language': 'en',
    'ctx/territory': 'DE',
    'ctx/time': new Date().toISOString(),
    'ctx/composer_name': context.userId || 'Form Builder',
    ...(templateId ? { 'ctx/template_id': templateId } : {}),
  };

  const aqlMap = webTemplateTree ? buildAqlToFlatMap(webTemplateTree) : undefined;

  // 1. Collect bindings from the layout fields (keyed by field_xxx IDs)
  const fieldBindings = definition.layout ? collectFieldBindings(definition.layout) : new Map();

  // 2. Iterate values and resolve each field's binding
  for (const [fieldId, value] of Object.entries(values)) {
    // Try layout-level binding first (matches field_xxx keys)
    const fb = fieldBindings.get(fieldId);
    if (fb) {
      const flatPath = resolveFlatPath(fb, aqlMap);
      if (flatPath) {
        if (Array.isArray(value)) value.forEach((entry, index) => setFlatValue(flat, flatPath, fb.rmType, entry, index));
        else setFlatValue(flat, flatPath, fb.rmType, value);
      }
      continue;
    }

    // Fall back to definition.bindings (keyed by binding name)
    const wrapped = definition.bindings?.[fieldId];
    const binding = wrapped?.openehr;
    if (binding) {
      const flatPath = resolveFlatPath(binding, aqlMap);
      if (flatPath) {
        if (Array.isArray(value)) value.forEach((entry, index) => setFlatValue(flat, flatPath, binding.rmType, entry, index));
        else setFlatValue(flat, flatPath, binding.rmType, value);
      }
    }
  }
  return flat;
}

function readFlatValue(flat: Record<string, any>, path: string, rmType?: string): any {
  const escapedPath = path.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/\\\//g, '(?::\\d+)?\\/');
  const pathRegex = new RegExp('^' + escapedPath + '(?::\\d+)?(?:\\|.*)?$');
  const matchingKeys = Object.keys(flat).filter(k => pathRegex.test(k));
  if (matchingKeys.length === 0) return undefined;
  
  const values: any[] = [];
  for (const k of matchingKeys) {
    // extract indices
    const indices: number[] = [];
    const re = /:(\d+)(?=\/|$|\|)/g;
    let m;
    while ((m = re.exec(k)) !== null) indices.push(Number(m[1]));
    
    // extract value
    let val: any = undefined;
    if (rmType === 'DV_QUANTITY') {
        if (k.endsWith('|magnitude')) val = { magnitude: flat[k], unit: flat[k.replace('|magnitude', '|unit')] };
        else continue;
    } else if (rmType === 'DV_CODED_TEXT' || rmType === 'CODE_PHRASE') {
        if (k.endsWith('|code')) val = flat[k];
        else if (k.endsWith('|value') && !matchingKeys.find(mk => mk === k.replace('|value', '|code'))) val = flat[k];
        else continue;
    } else {
        val = flat[k];
    }
    
    // build nested structure
    let current = values;
    for (let i = 0; i < indices.length - 1; i++) {
        if (!current[indices[i]]) current[indices[i]] = [];
        current = current[indices[i]] as any;
    }
    if (indices.length > 0) {
        current[indices[indices.length - 1]] = val;
    } else {
        return val; // no indices, simple scalar return
    }
  }
  return values.length > 0 ? values : undefined;
}

export function fromEhrbaseFlatComposition(
  definition: CanonicalForm,
  composition: Record<string, any>,
  webTemplateTree?: any,
): FormSessionValues {
  const values: FormSessionValues = {};
  const aqlMap = webTemplateTree ? buildAqlToFlatMap(webTemplateTree) : undefined;

  // Collect bindings from layout fields (keyed by field ID)
  const fieldBindings = definition.layout ? collectFieldBindings(definition.layout) : new Map();

  // Read from layout bindings first
  for (const [fieldId, fb] of fieldBindings.entries()) {
    const flatPath = resolveFlatPath(fb, aqlMap);
    if (!flatPath) continue;
    const value = readFlatValue(composition, flatPath, fb.rmType);
    if (!isEmpty(value)) values[fieldId] = value;
  }

  // Also try definition.bindings for any bindings not covered by layout
  for (const [fieldId, wrapped] of Object.entries(definition.bindings || {})) {
    if (values[fieldId] !== undefined) continue;
    const binding = wrapped?.openehr;
    if (!binding) continue;
    const flatPath = resolveFlatPath(binding, aqlMap);
    if (!flatPath) continue;
    const value = readFlatValue(composition, flatPath, binding?.rmType);
    if (!isEmpty(value)) values[fieldId] = value;
  }
  
  console.log('[EhrbaseDataProvider] Mapped flat composition to values:', {
    compositionKeyCount: Object.keys(composition).length,
    compositionKeys: Object.keys(composition),
    matchedValues: values,
    unmatchedBindings: Array.from(fieldBindings.entries())
      .filter(([id]) => values[id] === undefined)
      .map(([id, fb]) => ({ id, path: resolveFlatPath(fb, aqlMap) }))
  });

  return values;
}

function latestComposition(data: any): Record<string, any> | undefined {
  if (Array.isArray(data)) return data[data.length - 1];
  if (Array.isArray(data?.compositions)) return data.compositions[data.compositions.length - 1];
  if (data?.composition && typeof data.composition === 'object') return data.composition;
  return data && typeof data === 'object' ? data : undefined;
}

const webTemplateCache = new Map<string, any>();

async function getWebTemplateTree(tplId: string): Promise<any> {
  const cached = webTemplateCache.get(tplId);
  if (cached) return cached;
  try {
    const wt = await getRemoteWebTemplate(tplId);
    if (wt?.tree) {
      webTemplateCache.set(tplId, wt.tree);
      return wt.tree;
    }
  } catch (err: any) {
    console.warn(`[EhrbaseDataProvider] Could not fetch WebTemplate for ${tplId}:`, err.message);
  }
  return undefined;
}

export class EhrbaseDataProvider implements FormDataProvider {
  public readonly id = 'ehrbase';
  public readonly displayName = 'EHRbase';
  public readonly capabilities = ['load', 'submit'] as const;

  private readonly http: ProviderHttp;
  private readonly configOverride?: ProviderConfig;

  constructor(options: { http?: ProviderHttp; config?: ProviderConfig } = {}) {
    this.http = options.http || axios;
    this.configOverride = options.config;
  }

  private get config(): ProviderConfig {
    return this.configOverride || getConfig();
  }

  private async requestOptions(): Promise<Record<string, any>> {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
    let auth: { username: string; password: string } | undefined;
    if (this.config.authMode === 'keycloak') {
      const token = await getValidToken();
      headers.Authorization = `Bearer ${token}`;
    } else if (this.config.ehrbaseUser && this.config.ehrbasePass) {
      auth = { username: this.config.ehrbaseUser, password: this.config.ehrbasePass };
    }
    return { headers, ...(auth ? { auth } : {}) };
  }

  private async resolveEhrId(context: FormDataProviderContext): Promise<string> {
    const explicitEhrId = text(context.ehrId);
    if (explicitEhrId) {
      console.info('[EhrbaseDataProvider] Target EHR resolved', {
        ehrId: explicitEhrId,
        source: 'patient-registry',
      });
      return explicitEhrId;
    }

    const rawId = text(context.patientId);
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (rawId) {
      try {
        const response = await this.http.get(`${baseUrl(this.config)}/ehr`, {
          ...(await this.requestOptions()),
          params: {
            subject_id: rawId,
            subject_namespace: context.patientNamespace || this.config.ehrbaseSubjectNamespace || 'default',
          },
        }) as ProviderResponse;
        const ehrId = extractEhrId(response.data);
        if (ehrId) {
          console.info('[EhrbaseDataProvider] Target EHR resolved', {
            ehrId,
            source: 'subject-reference',
          });
          return ehrId;
        }
      } catch (error: any) {
        if (error?.response?.status !== 404) throw error;
      }

      // An explicit EHR ID is still supported for standalone sessions, but only
      // after subject lookup did not resolve the value as a patient identifier.
      if (UUID_REGEX.test(rawId)) {
        try {
          await this.http.get(`${baseUrl(this.config)}/ehr/${encodeURIComponent(rawId)}`, {
            ...(await this.requestOptions()),
          });
          console.info('[EhrbaseDataProvider] Target EHR resolved', {
            ehrId: rawId,
            source: 'explicit-ehr-id',
          });
          return rawId;
        } catch (error: any) {
          if (error?.response?.status !== 404) throw error;
        }
      }
    }

    if (!rawId && this.config.defaultEhrId?.trim()) {
      const ehrId = this.config.defaultEhrId.trim();
      console.info('[EhrbaseDataProvider] Target EHR resolved', {
        ehrId,
        source: 'default',
      });
      return ehrId;
    }
    throw new EhrbaseProviderError('EHRbase returned no EHR for this patient', 'PATIENT_EHR_NOT_FOUND', 404);
  }

  private handleError(error: unknown): never {
    const response = (error as any)?.response;
    const status = typeof response?.status === 'number' ? response.status : undefined;
    let detail = '';
    if (response?.data) {
      if (typeof response.data === 'string') {
        detail = `: ${response.data.slice(0, 300)}`;
      } else if (typeof response.data === 'object') {
        const msg = response.data.message || response.data.error || response.data.userMessage || (Array.isArray(response.data.errors) ? response.data.errors.join(', ') : undefined);
        detail = msg ? `: ${msg}` : `: ${JSON.stringify(response.data)}`;
      }
    } else if ((error as any)?.message) {
      detail = `: ${(error as any).message}`;
    }
    console.error('[EhrbaseDataProvider] Request failed:', status, detail, (error as any)?.stack);
    throw new EhrbaseProviderError(`EHRbase request failed${status ? ` (${status})` : ''}${detail}`, 'EHRBASE_REQUEST_FAILED', status || 502);
  }

  public async load(input: FormDataProviderLoadInput): Promise<FormDataProviderLoadResult> {
    let ehrId: string;
    try {
      ehrId = await this.resolveEhrId(input.context);
    } catch (error) {
      if (error instanceof EhrbaseProviderError) throw error;
      return this.handleError(error);
    }
    const id = templateId(input.form);

    const mode = (input.context as any).mode || 'create';

    if (mode === 'create') {
      return { providerId: this.id, values: {}, metadata: { ehrId, templateId: id } };
    }

    const wtTree = await getWebTemplateTree(id);
    let response: ProviderResponse;
    const reference = (input as any).reference;
    let versionUid: string | undefined;
    if (reference) {
      const match = String(reference).match(/([0-9a-f-]{36}::[^/\s]+::\d+)/i) || String(reference).match(/([^/]+::[^/]+::\d+)$/);
      if (match) versionUid = match[1];
    }

    try {
      if (!versionUid) {
        // We must query AQL to find the latest composition for this template
        // EHRbase requires the ORDER BY column to be present in the SELECT statement
        const aql = `SELECT c/uid/value, c/context/start_time/value FROM EHR e [ehr_id/value='${ehrId}'] CONTAINS COMPOSITION c WHERE c/archetype_details/template_id/value='${id}' ORDER BY c/context/start_time/value DESC LIMIT 1`;
        const aqlResponse = await this.http.post(`${baseUrl(this.config)}/query/aql`, { q: aql }, await this.requestOptions()) as ProviderResponse;
        
        const rows = aqlResponse.data?.rows || [];
        if (rows.length > 0 && rows[0][0]) {
          versionUid = rows[0][0];
        }
      }

      if (versionUid) {
        response = await this.http.get(`${baseUrl(this.config)}/ehr/${encodeURIComponent(ehrId)}/composition/${encodeURIComponent(versionUid)}`, {
          ...(await this.requestOptions()),
          params: { format: 'FLAT' },
        }) as ProviderResponse;
      } else {
        // No composition found
        return { providerId: this.id, values: {}, metadata: { ehrId, templateId: id } };
      }
    } catch (error) {
      if ((error as any)?.response?.status === 404) return { providerId: this.id, values: {}, metadata: { ehrId, templateId: id } };
      return this.handleError(error);
    }
    const composition = response.data;
    return {
      providerId: this.id,
      values: composition ? fromEhrbaseFlatComposition(input.form.definition, composition, wtTree) : {},
      reference: mode !== 'prefill' && composition ? (versionUid || referenceFrom(response)) : undefined,
      metadata: { ehrId, templateId: id },
    };
  }

  public async submit(input: FormDataProviderSubmitInput): Promise<FormDataProviderSubmitResult> {
    let ehrId: string;
    try {
      ehrId = await this.resolveEhrId(input.context);
    } catch (error) {
      if (error instanceof EhrbaseProviderError) throw error;
      return this.handleError(error);
    }
    const id = templateId(input.form);
    const wtTree = await getWebTemplateTree(id);
    const flatBody = toEhrbaseFlatComposition(input.form.definition, input.values, input.context, wtTree);
    let response: ProviderResponse;
    const options = await this.requestOptions();

    let versionUid: string | undefined;
    const strategy = (input.form.definition as any).settings?.ehrbase?.storageStrategy;
    console.info('[EhrbaseDataProvider] Submitting composition', {
      ehrId,
      templateId: id,
      fieldCount: Object.keys(flatBody).filter((key) => !key.startsWith('ctx/')).length,
      strategy: strategy || 'update_or_create',
    });
    
    if (strategy !== 'always_new') {
      const ref = (input as any).reference;
      if (ref) {
        const match = String(ref).match(/([0-9a-f-]{36}::[^/\s]+::\d+)/i) || String(ref).match(/([^/]+::[^/]+::\d+)$/);
        if (match) versionUid = match[1];
      }
    }

    try {
      if (versionUid && typeof this.http.put === 'function') {
        try {
          response = await this.http.put(`${baseUrl(this.config)}/ehr/${encodeURIComponent(ehrId)}/composition/${encodeURIComponent(versionUid)}`, flatBody, {
            ...options,
            params: { templateId: id, format: 'FLAT' },
            headers: { ...options.headers, 'If-Match': versionUid, Prefer: 'return=representation' },
          }) as ProviderResponse;
        } catch (putErr: any) {
          if (putErr?.response?.status === 404 || putErr?.response?.status === 412) {
            response = await this.http.post(`${baseUrl(this.config)}/ehr/${encodeURIComponent(ehrId)}/composition`, flatBody, {
              ...options,
              params: { templateId: id, format: 'FLAT' },
              headers: { ...options.headers, Prefer: 'return=representation' },
            }) as ProviderResponse;
          } else {
            throw putErr;
          }
        }
      } else {
        response = await this.http.post(`${baseUrl(this.config)}/ehr/${encodeURIComponent(ehrId)}/composition`, flatBody, {
          ...options,
          params: { templateId: id, format: 'FLAT' },
          headers: { ...options.headers, Prefer: 'return=representation' },
        }) as ProviderResponse;
      }
    } catch (error) {
      return this.handleError(error);
    }
    const reference = referenceFrom(response);
    console.info('[EhrbaseDataProvider] Composition accepted', {
      ehrId,
      templateId: id,
      status: response.status,
      reference,
    });
    return { providerId: this.id, reference, metadata: { ehrId, templateId: id } };
  }
}

export const ehrbaseDataProvider = new EhrbaseDataProvider();
