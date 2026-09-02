/**
 * n8n `FormDataProvider` - moved here from `apps/api/src/services/n8nDataProvider.ts`
 * (see the `[[n8n-provider-moved-into-plugin]]` memory for why): this
 * provider is only ever reachable through a form whose
 * `settings.submission.workflow` was itself provisioned by THIS plugin's own
 * `org.example.n8n.provision` action - there is no other way to get a form
 * into that state. Keeping the provider as core, always-registered
 * `apps/api` code made it dead code whenever this plugin wasn't loaded (the
 * default in this deployment), while still needing this exact plugin's own
 * settings (`apiUrl`/`apiKey`) to do anything. Registering it via
 * `context.registerFormDataProvider()` means it only exists - and only
 * ever gets asked for - when this plugin is actually installed.
 */
import axios, { type AxiosInstance } from 'axios';
import type {
  FormDataProvider,
  FormDataProviderError,
  FormDataProviderForm,
  FormDataProviderLoadInput,
  FormDataProviderLoadResult,
  FormDataProviderSubmitInput,
  FormSubmissionEnvelope,
  FormDataProviderSubmitResult,
} from 'core';
import { FORM_SUBMISSION_PROTOCOL } from 'core';
import { toOpenEhrFlatComposition } from 'openehr-engine';

type ProviderHttp = Pick<AxiosInstance, 'post'>;
type ProviderResponse = { data: any; headers?: Record<string, any>; status?: number };
type ProviderMessage = { severity: 'info' | 'warning' | 'error'; code?: string; path?: string; message: string };

export class N8nProviderError extends Error implements FormDataProviderError {
  public readonly status?: number;
  public readonly code: string;
  public readonly messages?: ProviderMessage[];

  constructor(message: string, code = 'N8N_REQUEST_FAILED', status?: number, messages?: ProviderMessage[]) {
    super(message);
    this.name = 'N8nProviderError';
    this.code = code;
    this.status = status;
    this.messages = messages;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function reachableWorkflowUrl(endpoint: string, getSettings: () => Record<string, unknown>): string {
  try {
    const parsed = new URL(endpoint);
    if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) return endpoint;
    const configuredApi = text(getSettings().apiUrl);
    if (!configuredApi) return endpoint;
    const api = new URL(configuredApi);
    parsed.protocol = api.protocol;
    parsed.hostname = api.hostname;
    parsed.port = api.port;
    return parsed.toString();
  } catch {
    return endpoint;
  }
}

function workflowUrl(form: FormDataProviderForm, getSettings: () => Record<string, unknown>): string {
  const submission = form.definition.settings?.submission;
  if (submission?.mode !== 'workflow' || submission.providerId !== 'n8n') {
    throw new N8nProviderError('Das Formular ist nicht für n8n konfiguriert.', 'N8N_FORM_NOT_CONFIGURED', 409);
  }
  const endpoint = text(submission.workflow?.webhookUrl);
  if (!endpoint) throw new N8nProviderError('Für das Formular ist kein n8n Webhook hinterlegt.', 'N8N_WEBHOOK_NOT_CONFIGURED', 503);
  try {
    const parsed = new URL(endpoint);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
  } catch {
    throw new N8nProviderError('Der n8n Webhook ist keine gültige HTTP-URL.', 'N8N_WEBHOOK_INVALID', 422);
  }
  return reachableWorkflowUrl(endpoint, getSettings);
}

async function verifyWorkflowBeforeSubmit(form: FormDataProviderForm, endpoint: string, getSettings: () => Record<string, unknown>): Promise<void> {
  const workflow = form.definition.settings?.submission?.workflow;
  const workflowId = text(workflow?.workflowId);
  if (!workflowId) return;
  const settings = getSettings();
  const apiUrl = text(settings.apiUrl);
  const apiKey = text(settings.apiKey);
  if (!apiUrl || !apiKey) throw new N8nProviderError('n8n Workflow kann vor dem Absenden nicht geprüft werden: API URL oder API-Key fehlen.', 'N8N_PREFLIGHT_NOT_CONFIGURED', 409);
  let response: Response;
  try {
    response = await fetch(`${apiUrl.replace(/\/$/, '')}/workflows/${encodeURIComponent(workflowId)}`, { headers: { Accept: 'application/json', 'X-N8N-API-KEY': apiKey }, signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new N8nProviderError(`n8n Workflow konnte vor dem Absenden nicht geprüft werden: ${error instanceof Error ? error.message : String(error)}`, 'N8N_PREFLIGHT_FAILED', 502);
  }
  if (!response.ok) throw new N8nProviderError(`n8n Workflow-Prüfung antwortete mit HTTP ${response.status}.`, 'N8N_PREFLIGHT_FAILED', 502);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (body.active !== true && !body.activeVersion) throw new N8nProviderError('n8n Workflow ist nicht veröffentlicht/aktiviert.', 'N8N_WORKFLOW_INACTIVE', 409);
  if (!endpoint) throw new N8nProviderError('Für das Formular ist kein n8n Webhook hinterlegt.', 'N8N_WEBHOOK_NOT_CONFIGURED', 503);
}
function referenceFrom(response: ProviderResponse): string | undefined {
  const headers = response.headers || {};
  return text(headers.location) || text(headers.Location) || text(response.data?.executionId) || text(response.data?.workflowId) || text(response.data?.id);
}

function metadataFrom(response: ProviderResponse): Record<string, any> | undefined {
  const body = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return { response: body };
}

export class N8nDataProvider implements FormDataProvider {
  public readonly id = 'n8n';
  public readonly displayName = 'n8n Workflow';
  public readonly capabilities = ['submit'] as const;

  private readonly http: ProviderHttp;
  private readonly getSettings: () => Record<string, unknown>;

  constructor(getSettings: () => Record<string, unknown>, options: { http?: ProviderHttp } = {}) {
    this.getSettings = getSettings;
    this.http = options.http || axios;
  }

  public async load(_input: FormDataProviderLoadInput): Promise<FormDataProviderLoadResult> {
    throw new N8nProviderError('n8n unterstützt in diesem Modus nur das Absenden.', 'N8N_LOAD_NOT_SUPPORTED', 405);
  }

  public async submit(input: FormDataProviderSubmitInput): Promise<FormDataProviderSubmitResult> {
    const endpoint = workflowUrl(input.form, this.getSettings);
    const payload: FormSubmissionEnvelope = {
      protocol: FORM_SUBMISSION_PROTOCOL,
      source: 'formbuilder',
      form: {
        id: input.form.id,
        version: input.form.version,
        definition: input.form.definition,
      },
      patient: {
        id: input.context.patientId,
        namespace: input.context.patientNamespace,
      },
      session: {
        id: input.context.sessionId,
        userId: input.context.userId,
        authMode: input.context.authMode,
      },
      composition: {
        format: 'flat',
        templateId: input.form.definition.sourceTemplates?.[0]?.id,
        values: toOpenEhrFlatComposition(input.form.definition, input.values, { composerName: input.context.userId }),
      },
      values: input.values,
    };

    let response: ProviderResponse;
    await verifyWorkflowBeforeSubmit(input.form, endpoint, this.getSettings);
    try {
      response = await this.http.post(endpoint, payload, {
        timeout: 15000,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Formbuilder-Protocol': FORM_SUBMISSION_PROTOCOL,
        },
      }) as ProviderResponse;
    } catch (error) {
      const status = typeof (error as any)?.response?.status === 'number' ? (error as any).response.status : undefined;
      const code = String((error as any)?.code || '');
      const timedOut = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ERR_CANCELED';
      console.error('[N8N PROVIDER ERROR]', JSON.stringify({ status: status || 502, code: timedOut ? 'N8N_WORKFLOW_TIMEOUT' : 'N8N_REQUEST_FAILED' }));
      throw new N8nProviderError(timedOut ? 'n8n Workflow antwortete nicht innerhalb von 15 Sekunden.' : `n8n Webhook konnte nicht erreicht werden${status ? ` (${status})` : ''}.`, timedOut ? 'N8N_WORKFLOW_TIMEOUT' : 'N8N_REQUEST_FAILED', status || 502);
    }
    if (typeof response.status === 'number' && (response.status < 200 || response.status >= 300)) {
      throw new N8nProviderError(`n8n Webhook antwortete mit HTTP ${response.status}.`, 'N8N_REQUEST_FAILED', response.status);
      console.error('[N8N PROVIDER RESULT]', JSON.stringify({ status: response.status, errors: [{ severity: 'error', code: 'N8N_REQUEST_FAILED', message: 'n8n Webhook HTTP error' }], stop: true }));
    }
    const metadata = metadataFrom(response);
    const workflowResult = metadata?.response;
    if (workflowResult) {
      if (workflowResult.protocol !== 'formbuilder.plugin-hook.v1') {
        const message = 'n8n Workflow antwortete ohne standardisiertes Form-Builder-Ergebnis.';
        console.error('[N8N PROVIDER RESULT]', JSON.stringify({ status: response.status, errors: [{ severity: 'error', code: 'N8N_INVALID_WORKFLOW_RESULT', message }], stop: true }));
        throw new N8nProviderError(message, 'N8N_INVALID_WORKFLOW_RESULT', 502, [{ severity: 'error', code: 'N8N_INVALID_WORKFLOW_RESULT', message }]);
      }
      const errors = Array.isArray(workflowResult.errors) ? workflowResult.errors : [];
      if (workflowResult.stop === true || errors.length > 0) {
        const first = errors.find((item: any) => item && typeof item.message === 'string');
        console.info('[N8N PROVIDER RESULT]', JSON.stringify({ status: response.status, notices: workflowResult.notices || [], errors, stop: workflowResult.stop === true, ...(typeof workflowResult.message === 'string' ? { message: workflowResult.message } : {}) }));
        const notices = Array.isArray(workflowResult.notices) ? workflowResult.notices : [];
        const details = [...errors, ...notices].map((item: any) => typeof item?.message === 'string' ? item.message : '').filter(Boolean).join('; ');
        const resultMessages: ProviderMessage[] = [...errors, ...notices].filter((item: any) => item && typeof item.message === 'string').map((item: any) => ({ severity: item.severity === 'error' || item.severity === 'warning' ? item.severity : 'info', ...(typeof item.code === 'string' ? { code: item.code } : {}), ...(typeof item.path === 'string' ? { path: item.path } : {}), message: item.message }));
        throw new N8nProviderError(typeof workflowResult.message === 'string' ? workflowResult.message : details || first?.message || 'n8n Workflow hat den Vorgang angehalten.', 'N8N_WORKFLOW_STOPPED', 422, resultMessages);
      }
    }
    return { providerId: this.id, reference: referenceFrom(response), metadata };
  }
}

export function createN8nDataProvider(getSettings: () => Record<string, unknown>, options?: { http?: ProviderHttp }): FormDataProvider {
  return new N8nDataProvider(getSettings, options);
}
