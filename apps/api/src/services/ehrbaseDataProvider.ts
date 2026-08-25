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
import {
  fromOpenEhrFlatComposition,
  toOpenEhrFlatComposition,
} from 'openehr-engine';
import { getConfig } from './configService';
import { getEhrbaseRequestConfig } from './ehrbaseConnectionPlugins';
import { getRemoteWebTemplate } from './ehrbaseService';

type ProviderHttp = Pick<AxiosInstance, 'get' | 'post' | 'put' | 'delete'>;
type ProviderConfig = ReturnType<typeof getConfig>;
type ProviderResponse = { data: any; headers?: Record<string, any>; status?: number };

export interface LatestCompositionContext {
  ehrId: string;
  templateId: string;
  reference?: string;
  flat: Record<string, unknown>;
  loadedAt: string;
}

/** openEHR `ORIGINAL_VERSION.lifecycle_state` values this app actively sets. */
export type DesiredLifecycleState = 'incomplete' | 'complete';

/** openEHR `AUDIT_DETAILS.change_type` values this app actively sets. */
export type DesiredChangeType = 'creation' | 'modification' | 'amendment';

export interface CommitWithLifecycleInput extends FormDataProviderSubmitInput {
  desiredLifecycleState: DesiredLifecycleState;
  desiredChangeType?: DesiredChangeType;
  changeDescription?: string;
}

export interface CommitWithLifecycleResult extends FormDataProviderSubmitResult {
  lifecycleState: DesiredLifecycleState;
  /** Whether the CDR was verified (by reading the version back) to have
   * actually applied lifecycleState - never assumed from a lack of error. */
  lifecycleConfirmed: boolean;
  changeType?: DesiredChangeType;
  /** Same verification, for changeType. `true` when no changeType was
   * requested (nothing to confirm). */
  changeTypeConfirmed: boolean;
}

export interface WithdrawInput {
  context: FormDataProviderContext;
  reference: string;
  reason?: string;
}

export interface WithdrawResult {
  versionUid: string;
}

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

/**
 * A WebTemplate is only a path-resolution fallback. Forms that already carry
 * flat paths can be mapped without an EHRbase template request.
 */
function requiresWebTemplateMapping(definition: CanonicalForm): boolean {
  const hasUnresolvedBinding = (binding: { path?: string; flatPath?: string } | undefined): boolean => Boolean(binding?.path && !binding.flatPath);
  if (Object.values(definition.bindings).some((entry) => hasUnresolvedBinding(entry.openehr))) return true;
  let required = false;
  const walk = (node: CanonicalForm['layout']): void => {
    if (hasUnresolvedBinding(node.binding)) required = true;
    node.children?.forEach(walk);
  };
  walk(definition.layout);
  return required;
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
  // The `etag` header carries the full `{uid}::{system}::{version}` form
  // reliably; `location` only ever contains the base (unversioned)
  // composition uid on this CDR (confirmed live) - preferring etag here
  // means every caller of referenceFrom() gets a directly `If-Match`/GET-able
  // version uid without needing a fallback AQL lookup.
  const etag = text(headers.etag) || text(headers.ETag);
  if (etag) return etag.replace(/^"|"$/g, '');
  return text(headers.location) || text(headers.Location) || text(response.data?.uid?.value) || text(response.data?.uid);
}

function versionUidFromReference(reference: unknown): string | undefined {
  const value = text(reference);
  if (!value) return undefined;
  const match = value.match(/([0-9a-f-]{36}::[^/\s]+::\d+)/i) || value.match(/([^/]+::[^/]+::\d+)$/);
  return match?.[1];
}

function latestComposition(data: any): Record<string, any> | undefined {
  if (Array.isArray(data)) return data[data.length - 1];
  if (Array.isArray(data?.compositions)) return data.compositions[data.compositions.length - 1];
  if (data?.composition && typeof data.composition === 'object') return data.composition;
  return data && typeof data === 'object' ? data : undefined;
}

const webTemplateCache = new Map<string, any>();

// Per-connection (base URL) memory of whether the real openEHR audit/version
// headers (`openEHR-AUDIT_DETAILS`/`openEHR-VERSION`) actually take effect
// on that CDR. Populated by commitWithLifecycle()'s attempt-then-verify
// step, not assumed - a fresh connection is always attempted at least once.
// `false` means "seen to be ignored"; absent means "unknown, attempt it".
const lifecycleHeaderSupport = new Map<string, boolean>();

async function getWebTemplateTree(tplId: string): Promise<any> {
  const cached = webTemplateCache.get(tplId);
  if (cached) return cached;
  try {
    const wt = await getRemoteWebTemplate(tplId);
    if (wt?.tree) {
      webTemplateCache.set(tplId, wt.tree);
      return wt.tree;
    }
    throw new EhrbaseProviderError(`WebTemplate '${tplId}' does not contain a tree`, 'TEMPLATE_INVALID', 422);
  } catch (err: any) {
    if (err instanceof EhrbaseProviderError) throw err;
    console.warn(`[EhrbaseDataProvider] Could not fetch WebTemplate for ${tplId}:`, err.message);
    const status = err.response?.status || 500;
    throw new EhrbaseProviderError(`Failed to fetch WebTemplate '${tplId}': ${err.message}`, 'TEMPLATE_NOT_FOUND', status);
  }
}

export class EhrbaseDataProvider implements FormDataProvider {
  public readonly id = 'ehrbase';
  public readonly displayName = 'EHRbase';
  public readonly capabilities = ['load', 'submit', 'draft'] as const;

  private readonly http: ProviderHttp;
  private readonly configOverride?: ProviderConfig;

  constructor(options: { http?: ProviderHttp; config?: ProviderConfig } = {}) {
    this.http = options.http || axios;
    this.configOverride = options.config;
  }

  private get config(): ProviderConfig {
    return this.configOverride || getConfig();
  }

  private async connectionRequestConfig(): Promise<{ ehrbaseUrl: string; headers: Record<string, string>; auth?: { username: string; password: string } }> {
    if (!this.configOverride) return getEhrbaseRequestConfig();
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (this.configOverride.authMode === 'keycloak') {
      throw new EhrbaseProviderError('Keycloak test configuration requires an explicit connection plugin', 'EHRBASE_NOT_CONFIGURED', 503);
    }
    const auth = this.configOverride.ehrbaseUser && this.configOverride.ehrbasePass
      ? { username: this.configOverride.ehrbaseUser, password: this.configOverride.ehrbasePass } : undefined;
    return { ehrbaseUrl: baseUrl(this.configOverride), headers, ...(auth ? { auth } : {}) };
  }

  private async providerBaseUrl(): Promise<string> {
    return (await this.connectionRequestConfig()).ehrbaseUrl;
  }

  private async requestOptions(): Promise<Record<string, any>> {
    const { headers, auth } = await this.connectionRequestConfig();
    return { headers, ...(auth ? { auth } : {}) };
  }

  /**
   * Resolves a Composition target only when a mode needs existing clinical
   * data. The returned value is a version UID, suitable for both GET and
   * optimistic PUT (`If-Match`).
   */
  private async findLatestCompositionVersion(ehrId: string, templateId: string): Promise<string | undefined> {
    // EHRbase requires the ORDER BY expression to be selected as well.
    // `context/start_time` expresses the clinical event time and is the
    // established fallback ordering for forms that have no explicit reference.
    const aql = `SELECT c/uid/value, c/context/start_time/value FROM EHR e [ehr_id/value='${ehrId}'] CONTAINS COMPOSITION c WHERE c/archetype_details/template_id/value='${templateId}' ORDER BY c/context/start_time/value DESC LIMIT 1`;
    const response = await this.http.post(`${await this.providerBaseUrl()}/query/aql`, { q: aql }, await this.requestOptions()) as ProviderResponse;
    const candidate = response.data?.rows?.[0]?.[0];
    return text(candidate);
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
        const response = await this.http.get(`${await this.providerBaseUrl()}/ehr`, {
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
          await this.http.get(`${await this.providerBaseUrl()}/ehr/${encodeURIComponent(rawId)}`, {
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
    if (error instanceof EhrbaseProviderError) throw error;
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

    const mode = input.context.mode;

    if (mode === 'create') {
      return { providerId: this.id, values: {}, metadata: { ehrId, templateId: id } };
    }

    const wtTree = requiresWebTemplateMapping(input.form.definition) ? await getWebTemplateTree(id) : undefined;
    let response: ProviderResponse;
    let versionUid = versionUidFromReference(input.reference);

    try {
      if (!versionUid) {
        versionUid = await this.findLatestCompositionVersion(ehrId, id);
      }

      if (versionUid) {
        response = await this.http.get(`${await this.providerBaseUrl()}/ehr/${encodeURIComponent(ehrId)}/composition/${encodeURIComponent(versionUid)}`, {
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
    const composition = latestComposition(response.data);
    return {
      providerId: this.id,
      values: composition ? fromOpenEhrFlatComposition(input.form.definition, composition, wtTree) : {},
      reference: mode !== 'prefill' && composition ? (versionUid || referenceFrom(response)) : undefined,
      metadata: { ehrId, templateId: id },
    };
  }

  /**
   * Loads the complete latest Flat Composition independently from form value
   * mapping. This is used as read-only script context on session start.
   */
  public async loadLatestCompositionContext(
    input: Pick<FormDataProviderLoadInput, 'context' | 'form'>,
  ): Promise<LatestCompositionContext | undefined> {
    try {
      const ehrId = await this.resolveEhrId(input.context);
      const id = templateId(input.form);
      const versionUid = await this.findLatestCompositionVersion(ehrId, id);
      if (!versionUid) return undefined;
      const response = await this.http.get(
        `${await this.providerBaseUrl()}/ehr/${encodeURIComponent(ehrId)}/composition/${encodeURIComponent(versionUid)}`,
        { ...(await this.requestOptions()), params: { format: 'FLAT' } },
      ) as ProviderResponse;
      const composition = latestComposition(response.data);
      if (!composition) return undefined;
      return {
        ehrId,
        templateId: id,
        reference: versionUid || referenceFrom(response),
        flat: composition,
        loadedAt: new Date().toISOString(),
      };
    } catch (error) {
      if ((error as any)?.response?.status === 404) return undefined;
      return this.handleError(error);
    }
  }

  public async submit(input: FormDataProviderSubmitInput): Promise<FormDataProviderSubmitResult> {
    return (await this.commitComposition(input, 'submit')).result;
  }

  /**
   * Persists the current (possibly incomplete) values as the session's
   * running draft - same create-vs-update targeting as submit(), so a
   * session that already has a draft composition keeps writing new versions
   * of that same composition rather than spawning a new one on every
   * autosave. The eventual submit() reuses that same reference too, once
   * one exists, so "draft, then finalize" lands as one continuous version
   * history, not two disconnected compositions.
   */
  public async draft(input: FormDataProviderSubmitInput): Promise<FormDataProviderSubmitResult> {
    return (await this.commitComposition(input, 'draft')).result;
  }

  /**
   * Commits a composition the same way submit()/draft() do, but additionally
   * *attempts* the real openEHR `lifecycle_state`/`change_type` mechanism via
   * the FLAT endpoint's documented `openEHR-AUDIT_DETAILS`/`openEHR-VERSION`
   * headers, then reads the committed version back to check whether the CDR
   * actually applied them. This CDR (confirmed live) silently ignores those
   * headers, so on it every commit here still lands as a normal FLAT
   * create/update - the save itself never fails or degrades because of this
   * - but the returned `lifecycleConfirmed`/`changeTypeConfirmed` flags tell
   * the caller the truth instead of pretending the request took effect.
   * Once a connection is seen to ignore the headers, subsequent calls skip
   * the pointless attempt+readback round-trip for that connection.
   */
  public async commitWithLifecycle(input: CommitWithLifecycleInput, label: 'submit' | 'draft'): Promise<CommitWithLifecycleResult> {
    const url = await this.providerBaseUrl();
    const attemptHeaders = lifecycleHeaderSupport.get(url) !== false;
    const auditHeaders = attemptHeaders ? this.buildAuditHeaders(input) : undefined;
    const { result, ehrId, fullVersionUid } = await this.commitComposition(input, label, { auditHeaders });

    let lifecycleConfirmed = false;
    let changeTypeConfirmed = !input.desiredChangeType;
    if (attemptHeaders && fullVersionUid) {
      const metadata = await this.readBackVersionMetadata(ehrId, fullVersionUid);
      lifecycleConfirmed = metadata?.lifecycleStateCode === input.desiredLifecycleState;
      if (input.desiredChangeType) changeTypeConfirmed = metadata?.changeTypeCode === input.desiredChangeType;
      // lifecycleState is always requested (unlike changeType, which is
      // optional), so its own confirmation alone is sufficient evidence of
      // whether this connection actually applies the headers at all.
      if (!lifecycleConfirmed) {
        lifecycleHeaderSupport.set(url, false);
        console.warn('[EhrbaseDataProvider] CDR did not apply requested lifecycle/change-type via audit headers; caching as unsupported for this connection', { url, requested: { lifecycleState: input.desiredLifecycleState, changeType: input.desiredChangeType }, actual: metadata });
      }
    }

    return {
      ...result,
      lifecycleState: input.desiredLifecycleState,
      lifecycleConfirmed,
      changeType: input.desiredChangeType,
      changeTypeConfirmed,
    };
  }

  /**
   * Logical withdrawal of a Composition via the CDR's real DELETE endpoint
   * (confirmed live to be genuine spec-correct logical deletion - the
   * withdrawn version stays fully retrievable, only the "current" pointer
   * changes). Never a physical purge.
   */
  public async withdraw(input: WithdrawInput): Promise<WithdrawResult> {
    if (typeof this.http.delete !== 'function') {
      throw new EhrbaseProviderError('The configured EHRbase transport does not support composition withdrawal', 'EHRBASE_DELETE_UNSUPPORTED', 502);
    }
    const ehrId = await this.resolveEhrId(input.context);
    const versionUid = versionUidFromReference(input.reference) || text(input.reference);
    if (!versionUid) {
      throw new EhrbaseProviderError('No composition version reference to withdraw', 'COMPOSITION_NOT_FOUND_FOR_EDIT', 404);
    }
    const options = await this.requestOptions();
    if (input.reason) {
      // Best-effort only, same silently-ignored-header caveat as
      // commitWithLifecycle() - DELETE's own logical-delete semantics are
      // what's proven to work; this header is never relied upon for
      // correctness, only attempted.
      options.headers = { ...options.headers, 'openEHR-AUDIT_DETAILS': JSON.stringify({ description: { value: input.reason } }) };
    }
    try {
      // Despite EHRbase's OpenAPI schema naming this path parameter
      // `preceding_version_uid`, it is the full versioned uid of the version
      // being withdrawn, not a "preceding" version - confirmed live.
      const response = await this.http.delete(
        `${await this.providerBaseUrl()}/ehr/${encodeURIComponent(ehrId)}/composition/${encodeURIComponent(versionUid)}`,
        options,
      ) as ProviderResponse;
      return { versionUid: referenceFrom(response) || versionUid };
    } catch (error: any) {
      if (error?.response?.status === 412) {
        throw new EhrbaseProviderError('The composition changed since it was loaded. Reload the form before withdrawing.', 'COMPOSITION_VERSION_CONFLICT', 409);
      }
      if (error?.response?.status === 404) {
        throw new EhrbaseProviderError('The composition to withdraw no longer exists', 'COMPOSITION_NOT_FOUND_FOR_EDIT', 404);
      }
      return this.handleError(error);
    }
  }

  private buildAuditHeaders(input: CommitWithLifecycleInput): Record<string, string> {
    // Code strings below are best-effort: `creation`=249 is confirmed against
    // the openEHR Terminology audit change type group; `amendment`/
    // `modification` codes are not conclusively confirmed against an
    // authoritative enumeration and are inferred. This is safe because the
    // header is never trusted blindly - commitWithLifecycle() always reads
    // the committed version back and verifies what the CDR actually applied.
    const changeTypeCode = input.desiredChangeType === 'amendment' ? '250' : input.desiredChangeType === 'modification' ? '251' : '249';
    const lifecycleCode = input.desiredLifecycleState === 'complete' ? '532' : '553';
    const auditDetails = {
      system_id: 'form-builder',
      time_committed: { value: new Date().toISOString() },
      change_type: {
        value: input.desiredChangeType || 'creation',
        defining_code: { terminology_id: { value: 'openehr' }, code_string: changeTypeCode },
      },
      ...(input.changeDescription ? { description: { value: input.changeDescription } } : {}),
      committer: { name: input.context.userId || 'Form Builder' },
    };
    const version = {
      lifecycle_state: {
        value: input.desiredLifecycleState,
        defining_code: { terminology_id: { value: 'openehr' }, code_string: lifecycleCode },
      },
    };
    return {
      'openEHR-AUDIT_DETAILS': JSON.stringify(auditDetails),
      'openEHR-VERSION': JSON.stringify(version),
    };
  }

  /**
   * Reads a specific committed version back via the canonical (non-FLAT)
   * versioned_composition endpoint to check its actual `lifecycle_state`/
   * `commit_audit.change_type` - the only reliable way to know whether the
   * CDR applied requested metadata, since it accepts the request headers
   * without error either way (confirmed live).
   */
  private async readBackVersionMetadata(ehrId: string, fullVersionUid: string): Promise<{ lifecycleStateCode?: string; changeTypeCode?: string } | undefined> {
    try {
      const baseUid = fullVersionUid.split('::')[0];
      const response = await this.http.get(
        `${await this.providerBaseUrl()}/ehr/${encodeURIComponent(ehrId)}/versioned_composition/${encodeURIComponent(baseUid)}/version/${encodeURIComponent(fullVersionUid)}`,
        await this.requestOptions(),
      ) as ProviderResponse;
      return {
        lifecycleStateCode: text(response.data?.lifecycle_state?.value),
        changeTypeCode: text(response.data?.commit_audit?.change_type?.value),
      };
    } catch (error) {
      console.warn('[EhrbaseDataProvider] Could not read back version metadata for lifecycle verification:', (error as any)?.message);
      return undefined;
    }
  }

  private async commitComposition(
    input: FormDataProviderSubmitInput,
    label: 'submit' | 'draft',
    extra?: { auditHeaders?: Record<string, string> },
  ): Promise<{ result: FormDataProviderSubmitResult; ehrId: string; templateId: string; fullVersionUid?: string }> {
    const mode = input.context.mode;
    if (mode === 'view') {
      throw new EhrbaseProviderError('A composition cannot be submitted from view mode', 'FORM_MODE_READ_ONLY', 403);
    }
    let ehrId: string;
    try {
      ehrId = await this.resolveEhrId(input.context);
    } catch (error) {
      if (error instanceof EhrbaseProviderError) throw error;
      return this.handleError(error);
    }
    const id = templateId(input.form);
    const wtTree = requiresWebTemplateMapping(input.form.definition) ? await getWebTemplateTree(id) : undefined;
    const flatBody = toOpenEhrFlatComposition(
      input.form.definition,
      input.values,
      { composerName: input.context.userId },
      wtTree,
    );
    let response: ProviderResponse;
    const options = await this.requestOptions();
    if (extra?.auditHeaders) options.headers = { ...options.headers, ...extra.auditHeaders };

    // draft() always trusts its given reference as an update target - the
    // caller (formSessionService) only ever hands it a reference it already
    // knows is safe to continue (this session's own prior draft, or, when
    // seeding an edit-mode session's first draft, the composition actually
    // being edited). submit()'s policy is stricter and unchanged in the
    // normal case (only edit mode updates in place) precisely so a
    // prefill's source composition, or any other externally-supplied
    // reference, is never silently overwritten - continuesDraft is the one
    // explicit exception, set only when the reference is this session's own
    // autosaved draft.
    const updatesExistingComposition = label === 'draft' ? Boolean(input.reference) : (mode === 'edit' || Boolean(input.continuesDraft));
    let versionUid = updatesExistingComposition ? versionUidFromReference(input.reference) : undefined;
    console.info(`[EhrbaseDataProvider] ${label === 'draft' ? 'Autosaving draft composition' : 'Submitting composition'}`, {
      ehrId,
      templateId: id,
      fieldCount: Object.keys(flatBody).filter((key) => !key.startsWith('ctx/')).length,
      operation: updatesExistingComposition ? 'update-existing' : 'create-new',
    });
    console.info('[EhrbaseDataProvider] Generated flat composition body:\n', JSON.stringify(flatBody, null, 2));

    try {
      if (updatesExistingComposition) {
        versionUid = versionUid || await this.findLatestCompositionVersion(ehrId, id);
        if (!versionUid) {
          if (label === 'draft') {
            // No composition to update yet (e.g. edit-mode session whose
            // provider data hasn't loaded) - a draft write degrades to a
            // create instead of hard-failing the autosave.
            response = await this.http.post(`${await this.providerBaseUrl()}/ehr/${encodeURIComponent(ehrId)}/composition`, flatBody, {
              ...options,
              params: { templateId: id, format: 'FLAT' },
              headers: { ...options.headers, Prefer: 'return=representation' },
            }) as ProviderResponse;
          } else {
            throw new EhrbaseProviderError(`No existing composition found for template '${id}'; edit mode cannot create one`, 'COMPOSITION_NOT_FOUND_FOR_EDIT', 404);
          }
        } else {
          if (typeof this.http.put !== 'function') {
            throw new EhrbaseProviderError('The configured EHRbase transport does not support versioned composition updates', 'EHRBASE_UPDATE_UNSUPPORTED', 502);
          }
          try {
            const baseUid = versionUid.split('::')[0];
            response = await this.http.put(`${await this.providerBaseUrl()}/ehr/${encodeURIComponent(ehrId)}/composition/${encodeURIComponent(baseUid)}`, flatBody, {
              ...options,
              params: { templateId: id, format: 'FLAT' },
              headers: { ...options.headers, 'If-Match': versionUid, Prefer: 'return=representation' },
            }) as ProviderResponse;
          } catch (putErr: any) {
            if (putErr?.response?.status === 412) {
              throw new EhrbaseProviderError('The composition changed since it was loaded. Reload the form before saving.', 'COMPOSITION_VERSION_CONFLICT', 409);
            }
            if (putErr?.response?.status === 404) {
              throw new EhrbaseProviderError(`The composition selected for template '${id}' no longer exists`, 'COMPOSITION_NOT_FOUND_FOR_EDIT', 404);
            }
            throw putErr;
          }
        }
      } else {
        response = await this.http.post(`${await this.providerBaseUrl()}/ehr/${encodeURIComponent(ehrId)}/composition`, flatBody, {
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
    return {
      result: { providerId: this.id, reference, metadata: { ehrId, templateId: id } },
      ehrId,
      templateId: id,
      fullVersionUid: reference?.includes('::') ? reference : undefined,
    };
  }
}

export const ehrbaseDataProvider = new EhrbaseDataProvider();
