import type { FormBuilderPlugin, JsonObject, PluginHookName } from 'plugin-api';
import { createN8nDataProvider } from './dataProvider';

/** The result contract every n8n workflow this plugin provisions must
 * return - checked on the way back in from every hook/submit response.
 * Also interpolated into the generated `jsCode` of the "Hook Response" node
 * in `emptyWorkflowPayload` (n8n's own JS runtime, not this file's), so
 * that generated code and this file's own check can never drift apart. */
const HOOK_RESULT_PROTOCOL = 'formbuilder.plugin-hook.v1';

function environment(name: string): string | undefined {
  const processLike = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process;
  const value = processLike?.env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'form';
}

function apiBase(configured?: string): string {
  return (configured || environment('N8N_API_URL') || 'http://host.docker.internal:5678/api/v1').replace(/\/$/, '');
}
function publicBase(configuredApi?: string, configuredPublic?: string): string {
  const configured = configuredPublic || environment('N8N_PUBLIC_URL');
  if (configured) return configured.replace(/\/$/, '');
  return apiBase(configuredApi).replace(/\/api\/v1\/?$/, '');
}

function formObject(form: JsonObject | undefined): JsonObject {
  return form && typeof form === 'object' && !Array.isArray(form) ? form : {};
}

function logHookResult(hook: string, status: number, body: JsonObject): void {
  const notices = Array.isArray(body.notices) ? body.notices : [];
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const summary = JSON.stringify({ hook, status, notices, errors, stop: body.stop === true, ...(typeof body.message === 'string' ? { message: body.message } : {}) });
  if (errors.length > 0 || body.stop === true) console.error(`[N8N HOOK RESULT] ${summary}`);
  else if (notices.length > 0) console.warn(`[N8N HOOK RESULT] ${summary}`);
  else console.info(`[N8N HOOK RESULT] ${summary}`);
}

// `settings` here is always this plugin's own `context.getSettings()` -
// read directly, never unwrapped from host-injected hook/action metadata
// (see the `[[hardcoded-example-plugin-settings-fix]]` memory for the
// per-plugin-id-hardcoded metadata mechanism this replaced).
function pluginSetting(settings: JsonObject, key: string): string | undefined {
  return text(settings[key]);
}

function lifecyclePath(workflowSlug: string, hook: string): string {
  return `${workflowSlug}/${hook}`;
}

const LIFECYCLE_HOOKS = ['beforeLoad', 'afterLoad', 'beforeSave', 'afterSave', 'beforeValidate', 'afterValidate', 'beforeSubmit', 'afterSubmit'] as const;
const ALL_HOOKS = [...LIFECYCLE_HOOKS, 'submit'] as const;
type HookName = (typeof ALL_HOOKS)[number];

function settingObject(settings: JsonObject, key: string): JsonObject {
  const value = settings[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function enabledHooks(settings: JsonObject, workflow: JsonObject): HookName[] {
  const global = settingObject(settings, 'webhooks');
  const form = workflow.enabledHooks && typeof workflow.enabledHooks === 'object' && !Array.isArray(workflow.enabledHooks) ? workflow.enabledHooks as JsonObject : {};
  return ALL_HOOKS.filter((hook) => {
    const globalDefault = false;
    const globalEnabled = typeof global[hook] === 'boolean' ? global[hook] as boolean : globalDefault;
    const formEnabled = typeof form[hook] === 'boolean' ? form[hook] as boolean : Object.keys(form).length === 0;
    return globalEnabled && formEnabled;
  });
}

function internalBase(configuredApi?: string): string {
  return apiBase(configuredApi).replace(/\/api\/v1\/?$/, '');
}

function workflowUrls(workflowSlug: string, configuredApi: string | undefined, configuredPublic: string | undefined, hooks: readonly string[]): { internal: Record<string, string>; public: Record<string, string> } {
  const internalRoot = internalBase(configuredApi);
  const publicRoot = publicBase(configuredApi, configuredPublic);
  return {
    internal: Object.fromEntries(hooks.map((hook) => [hook, `${internalRoot}/webhook/${lifecyclePath(workflowSlug, hook)}`])),
    public: Object.fromEntries(hooks.map((hook) => [hook, `${publicRoot}/webhook/${lifecyclePath(workflowSlug, hook)}`])),
  };
}

async function verifyWorkflowPublished(configuredApiUrl: string | undefined, apiKey: string, workflowId: string, webhookUrl: string): Promise<string | undefined> {
  let workflowResponse: Response;
  try {
    workflowResponse = await fetch(`${apiBase(configuredApiUrl)}/workflows/${encodeURIComponent(workflowId)}`, { headers: { Accept: 'application/json', 'X-N8N-API-KEY': apiKey }, signal: AbortSignal.timeout(5000) });
  } catch (error) {
    return `n8n Workflow konnte nicht geprüft werden: ${error instanceof Error ? error.message : String(error)}`;
  }
  const workflowText = await workflowResponse.text();
  if (!workflowResponse.ok) return `n8n Workflow-Prüfung antwortete mit HTTP ${workflowResponse.status}: ${workflowText.slice(0, 240)}`;
  let workflow: JsonObject = {};
  try { workflow = workflowText ? JSON.parse(workflowText) as JsonObject : {}; } catch { return 'n8n Workflow-Prüfung lieferte keine gültige Antwort.'; }
  if (workflow.active !== true && !workflow.activeVersion) return 'n8n Workflow ist nicht veröffentlicht/aktiviert. Bitte den Workflow in n8n aktivieren.';
  try {
    const probe = await fetch(webhookUrl, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Formbuilder-Preflight': 'true' }, signal: AbortSignal.timeout(5000), body: JSON.stringify({ protocol: 'formbuilder.preflight.v1', preflight: true }) });
    if (!probe.ok) return `n8n Webhook ist nicht erreichbar oder nicht aktiv (HTTP ${probe.status}).`;
  } catch (error) {
    return `n8n Webhook ist nicht erreichbar: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
}

function emptyWorkflowPayload(form: JsonObject, workflowSlug: string, hooks: readonly string[]): JsonObject {
  const formId = text(form.id) || 'form';
  const responseCode = [
    '// DO NOT CHANGE: Form Builder protocol adapter.',
    '// Add custom n8n logic in nodes BEFORE this adapter.',
    'const raw = $json ?? {};',
    'const source = raw.body && typeof raw.body === "object" ? raw.body : raw;',
    'const warnings = Array.isArray(source.warnings) ? source.warnings.map((item) => ({ ...item, severity: "warning" })) : [];',
    'const notices = [...warnings, ...(Array.isArray(source.notices) ? source.notices : [])];',
    'const errors = Array.isArray(source.errors) ? source.errors : [];',
    `return [{ json: { protocol: ${JSON.stringify(HOOK_RESULT_PROTOCOL)}, data: source.data || source.values || {}, notices, errors, stop: source.stop === true, ...(typeof source.message === "string" ? { message: source.message } : {}) } }];`,
  ].join('\n');
  const submitName = 'Form Webhook';
  const submitResponseName = 'Submit Hook Response';
  const submitPath = lifecyclePath(workflowSlug, 'submit');
  const lifecycleNodes = hooks.filter((hook) => hook !== 'submit').flatMap((hook, index) => {
    const name = `Form Webhook ${hook}`;
    const responseName = `DO NOT CHANGE - ${hook} Hook Response`;
    const path = lifecyclePath(workflowSlug, hook);
    return [
      { id: `form-webhook-${hook.toLowerCase()}`, name, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-640, (index + 1) * 180], parameters: { httpMethod: 'POST', path, responseMode: 'lastNode', options: {} }, webhookId: path },
      {
        id: `hook-response-${hook.toLowerCase()}`,
        name: responseName,
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [-360, (index + 1) * 180],
        parameters: { jsCode: responseCode },
        notes: 'DO NOT CHANGE. This final node returns the Form Builder protocol. Add custom logic in nodes before it.',
        notesInFlow: true,
      },
    ];
  });
  const lifecycleConnections = Object.fromEntries(hooks.filter((hook) => hook !== 'submit').map((hook) => {
    const name = `Form Webhook ${hook}`;
    const responseName = `DO NOT CHANGE - ${hook} Hook Response`;
    return [name, { main: [[{ node: responseName, type: 'main', index: 0 }]] }];
  }));
  return {
    name: `Form Builder: ${text(form.name) || formId}`,
    settings: { executionOrder: 'v1' },
    nodes: [
      { id: 'form-webhook', name: submitName, type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [-640, 0], parameters: { httpMethod: 'POST', path: submitPath, responseMode: 'lastNode', options: {} }, webhookId: submitPath },
      ...lifecycleNodes,
      {
        id: 'submit-hook-response',
        name: submitResponseName,
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [-360, 0],
        parameters: { jsCode: responseCode },
        notes: 'DO NOT CHANGE. This final node returns the Form Builder protocol. Add custom logic in nodes before it.',
        notesInFlow: true,
      },
    ],
    connections: {
      [submitName]: { main: [[{ node: submitResponseName, type: 'main', index: 0 }]] },
      ...lifecycleConnections,
    },
  } as unknown as JsonObject;
}

function submissionSettings(form: JsonObject, workflowId: string, urls: { internal: Record<string, string>; public: Record<string, string> }): JsonObject {
  const currentSettings = form.settings && typeof form.settings === 'object' && !Array.isArray(form.settings) ? form.settings as JsonObject : {};
  const enabled = Object.fromEntries(ALL_HOOKS.map((hook) => [hook, Boolean(urls.internal[hook])]));
  const currentSubmission = currentSettings.submission && typeof currentSettings.submission === 'object' && !Array.isArray(currentSettings.submission) ? currentSettings.submission as JsonObject : {};
  const hasSubmitHook = Boolean(urls.internal.submit);
  return {
    ...(form || {}),
    settings: {
      ...currentSettings,
      submission: {
        ...currentSubmission,
        ...(hasSubmitHook ? { mode: 'workflow', providerId: 'n8n' } : { providerId: currentSubmission.providerId === 'n8n' ? 'ehrbase' : currentSubmission.providerId || 'ehrbase' }),
        workflow: { engine: 'n8n', workflowId, webhookUrl: urls.internal.submit, publicWebhookUrl: urls.public.submit, hooks: urls.internal, enabledHooks: enabled, version: '1' },
      },
    },
  };
}

const plugin: FormBuilderPlugin = {
  manifest: {
    id: 'org.example.n8n',
    version: '1.4.0',
    apiVersion: '1.0',
    name: 'Example n8n Workflow',
    description: 'Provisioniert pro Formular einen sicheren Webhook-Workflow mit standardisiertem Ergebnisvertrag.',
    extensionPoints: ['settings', 'workflow', 'lifecycle', 'dataProvider'],
    permissions: ['form:read', 'form:write', 'network:request'],
  },
  activate(context) {
    context.registerFormDataProvider(createN8nDataProvider(context.getSettings));
    context.registerSettingsPanel({
      key: 'org.example.n8n.connection',
      panelId: 'org.example.n8n.connection',
      label: 'n8n Verbindung',
      scope: 'global',
      secretKeys: ['apiKey'],
      propertySchema: {
        type: 'object',
        properties: {
          apiUrl: { type: 'string', title: 'n8n API URL', format: 'uri', default: 'http://host.docker.internal:5678/api/v1', description: 'Docker: host.docker.internal; lokale Ausführung: localhost' },
          apiKey: { type: 'string', title: 'n8n API Key', format: 'password' },
          publicUrl: { type: 'string', title: 'Öffentliche n8n URL', format: 'uri' },
          webhooks: {
            type: 'object',
            title: 'Aktive n8n Webhooks (global)',
            properties: {
              beforeLoad: { type: 'boolean', title: 'Vor dem Laden', default: false },
              afterLoad: { type: 'boolean', title: 'Nach dem Laden', default: false },
              beforeSave: { type: 'boolean', title: 'Vor dem Speichern', default: false },
              afterSave: { type: 'boolean', title: 'Nach dem Speichern', default: false },
              beforeValidate: { type: 'boolean', title: 'Vor der Validierung', default: false },
              afterValidate: { type: 'boolean', title: 'Nach der Validierung', default: false },
              beforeSubmit: { type: 'boolean', title: 'Vor dem Absenden', default: false },
              afterSubmit: { type: 'boolean', title: 'Nach dem Absenden', default: false },
              submit: { type: 'boolean', title: 'Absenden an n8n', default: false },
            },
          },
        },
      },
    });
    context.registerSettingsPanel({
      key: 'org.example.n8n.submission',
      panelId: 'org.example.n8n.submission',
      scope: 'form',
      label: 'Als n8n Form konfigurieren',
      actionId: 'org.example.n8n.provision',
      formSettingsPath: 'settings.submission.workflow.enabledHooks',
      propertySchema: {
        type: 'object',
        properties: {
          beforeLoad: { type: 'boolean', title: 'Vor dem Laden aktivieren', default: false },
          afterLoad: { type: 'boolean', title: 'Nach dem Laden aktivieren', default: false },
          beforeSave: { type: 'boolean', title: 'Vor dem Speichern aktivieren', default: false },
          afterSave: { type: 'boolean', title: 'Nach dem Speichern aktivieren', default: false },
          beforeValidate: { type: 'boolean', title: 'Vor der Validierung aktivieren', default: false },
          afterValidate: { type: 'boolean', title: 'Nach der Validierung aktivieren', default: false },
          beforeSubmit: { type: 'boolean', title: 'Vor dem Absenden aktivieren', default: false },
          afterSubmit: { type: 'boolean', title: 'Nach dem Absenden aktivieren', default: false },
          submit: { type: 'boolean', title: 'Absenden-Webhook aktivieren', default: false },
        },
      },
    });
    for (const hook of LIFECYCLE_HOOKS) {
      context.registerWorkflow({
        key: `org.example.n8n.${hook.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
        workflowId: `org.example.n8n.${hook}`,
        label: `n8n ${hook} Hook`,
        trigger: hook,
      });
      context.registerHook(hook as PluginHookName, async (hookContext) => {
        const settings = hookContext.form.settings && typeof hookContext.form.settings === 'object' && !Array.isArray(hookContext.form.settings) ? hookContext.form.settings as JsonObject : {};
        const submission = settings.submission && typeof settings.submission === 'object' && !Array.isArray(settings.submission) ? settings.submission as JsonObject : {};
        if (submission.mode !== 'workflow' || submission.providerId !== 'n8n') return {};
        context.requirePermission('network:request');
        const pluginSettings = context.getSettings() as JsonObject;
        const apiKey = pluginSetting(pluginSettings, 'apiKey') || environment('N8N_API_KEY');
        if (!apiKey) return { errors: [{ path: 'n8n.apiKey', message: 'N8N_API_KEY ist nicht konfiguriert.' }] };
        const workflow = submission.workflow && typeof submission.workflow === 'object' && !Array.isArray(submission.workflow) ? submission.workflow as JsonObject : {};
        if (!workflow.hooks || typeof workflow.hooks !== 'object' || Array.isArray(workflow.hooks)) return {};
        const hooks = workflow.hooks as JsonObject;
        const endpoint = text(hooks[hook]);
        if (!endpoint) return {};
        const payload = { protocol: HOOK_RESULT_PROTOCOL, hook, form: hookContext.form, data: hookContext.data || {}, patient: { id: hookContext.patientId }, session: { id: hookContext.sessionId, userId: hookContext.userId }, metadata: hookContext.metadata || {} } as unknown as JsonObject;
        let response: Response;
        try {
          response = await fetch(endpoint, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-N8N-API-KEY': apiKey, 'X-Formbuilder-Protocol': HOOK_RESULT_PROTOCOL }, signal: AbortSignal.timeout(15000), body: JSON.stringify(payload) });
        } catch (error) {
          const timedOut = error instanceof Error && /timeout|abort/i.test(error.message);
          const message = timedOut ? 'n8n Workflow antwortete nicht innerhalb von 15 Sekunden.' : `n8n Hook konnte nicht erreicht werden: ${error instanceof Error ? error.message : String(error)}`;
          console.error(`[N8N HOOK ERROR] ${hook}: ${message}`);
          return { notices: [{ severity: 'error', path: `n8n.${hook}`, code: timedOut ? 'N8N_HOOK_TIMEOUT' : 'N8N_HOOK_UNREACHABLE', message }], stop: true, stopMessage: message };
        }
        const responseText = await response.text();
        let body: JsonObject = {};
        try { body = responseText ? JSON.parse(responseText) as JsonObject : {}; } catch { /* keep an empty response */ }
        if (!response.ok) {
          const message = `n8n Hook antwortete mit HTTP ${response.status}.`;
          console.error(`[N8N HOOK RESULT] ${JSON.stringify({ hook, status: response.status, errors: [{ severity: 'error', code: 'N8N_HOOK_HTTP_ERROR', message }], stop: true })}`);
          return { notices: [{ severity: 'error', path: `n8n.${hook}`, code: 'N8N_HOOK_HTTP_ERROR', message }], stop: true, stopMessage: `n8n ${hook} wurde mit HTTP ${response.status} beendet.` };
        }
        if (body.protocol !== HOOK_RESULT_PROTOCOL) {
          const message = 'n8n Workflow antwortete ohne standardisiertes Form-Builder-Ergebnis.';
          console.error(`[N8N HOOK RESULT] ${JSON.stringify({ hook, status: response.status, errors: [{ severity: 'error', code: 'N8N_HOOK_INVALID_RESPONSE', message }], stop: true })}`);
          return { notices: [{ severity: 'error', path: `n8n.${hook}`, code: 'N8N_HOOK_INVALID_RESPONSE', message }], stop: true, stopMessage: 'n8n Workflow-Ergebnis konnte nicht verarbeitet werden.' };
        }
        const notices = Array.isArray(body.notices) ? body.notices as any : undefined;
        logHookResult(hook, response.status, body);
        const errors = Array.isArray(body.errors) ? body.errors as any : undefined;
        return {
          data: body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data as JsonObject : hookContext.data,
          ...(notices ? { notices } : {}),
          ...(errors ? { errors } : {}),
          stop: body.stop === true,
          ...(typeof body.message === 'string' ? { stopMessage: body.message } : {}),
        };
      });
    }
    context.registerAction('org.example.n8n.provision', async ({ form: inputForm }) => {
      context.requirePermission('form:read');
      context.requirePermission('form:write');
      context.requirePermission('network:request');
      const settings = context.getSettings() as JsonObject;
      const configuredApiUrl = pluginSetting(settings, 'apiUrl');
      const configuredPublicUrl = pluginSetting(settings, 'publicUrl');
      const apiKey = pluginSetting(settings, 'apiKey') || environment('N8N_API_KEY');
      if (!apiKey) return { errors: [{ path: 'n8n.apiKey', message: 'N8N_API_KEY ist nicht konfiguriert.' }] };
      const form = formObject(inputForm);
      const formId = text(form.id) || 'form';
      const currentSettings = form.settings && typeof form.settings === 'object' && !Array.isArray(form.settings) ? form.settings as JsonObject : {};
      const currentSubmission = currentSettings.submission && typeof currentSettings.submission === 'object' && !Array.isArray(currentSettings.submission) ? currentSettings.submission as JsonObject : {};
      const currentWorkflow = currentSubmission.workflow && typeof currentSubmission.workflow === 'object' && !Array.isArray(currentSubmission.workflow) ? currentSubmission.workflow as JsonObject : {};
      const activeHooks = enabledHooks(settings, currentWorkflow);
      if (activeHooks.length === 0) return { errors: [{ path: 'n8n.webhooks', message: 'Mindestens ein global aktivierter n8n Webhook muss für dieses Formular ausgewählt sein.' }] };
      const workflowId = text(currentWorkflow.workflowId);
      const configuredPath = text(currentWorkflow.webhookUrl) || (currentWorkflow.hooks && typeof currentWorkflow.hooks === 'object' && !Array.isArray(currentWorkflow.hooks) ? text((currentWorkflow.hooks as JsonObject).submit) : undefined);
      const workflowSlug = configuredPath?.split('/webhook/')[1]?.split('/')[0] || `formbuilder-${slug(formId)}`;
      const workflow = emptyWorkflowPayload(form, workflowSlug, activeHooks);
      const url = `${apiBase(configuredApiUrl)}/workflows${workflowId ? `/${encodeURIComponent(workflowId)}` : ''}`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: workflowId ? 'PUT' : 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-N8N-API-KEY': apiKey },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify(workflow),
        });
      } catch (error) {
        return { errors: [{ path: 'n8n', message: `n8n API konnte nicht erreicht werden: ${error instanceof Error ? error.message : String(error)}` }] };
      }
      const responseText = await response.text();
      let saved: JsonObject = {};
      try { saved = responseText ? JSON.parse(responseText) as JsonObject : {}; } catch { /* n8n may return an empty body */ }
      if (!response.ok) return { errors: [{ path: 'n8n', message: `n8n API antwortete mit HTTP ${response.status}: ${responseText.slice(0, 300)}` }] };
      const savedId = text(saved.id) || workflowId;
      if (!savedId) return { errors: [{ path: 'n8n.workflowId', message: 'n8n API hat keine Workflow-ID zurückgegeben.' }] };
      const urls = workflowUrls(workflowSlug, configuredApiUrl, configuredPublicUrl, activeHooks);
      let activation: Response;
      try {
        activation = await fetch(`${apiBase(configuredApiUrl)}/workflows/${encodeURIComponent(savedId)}/activate`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'X-N8N-API-KEY': apiKey },
          signal: AbortSignal.timeout(15000),
        });
      } catch (error) {
        return { errors: [{ path: 'n8n.activation', message: `n8n Workflow konnte nicht aktiviert werden: ${error instanceof Error ? error.message : String(error)}` }] };
      }
      if (!activation.ok) {
        const activationText = await activation.text();
        return { errors: [{ path: 'n8n.activation', message: `n8n Aktivierung antwortete mit HTTP ${activation.status}: ${activationText.slice(0, 300)}` }] };
      }
      if (activeHooks.includes('submit')) {
        const preflightError = await verifyWorkflowPublished(configuredApiUrl, apiKey, savedId, urls.internal.submit);
        if (preflightError) return { errors: [{ path: 'n8n.preflight', message: preflightError }] };
      }
      return {
        data: submissionSettings(form, savedId, urls),
        message: workflowId ? 'n8n Workflow wurde aktualisiert und das Formular ist daran gebunden.' : 'n8n Workflow wurde erstellt und das Formular ist daran gebunden.',
      };
    });
  },
};

export default plugin;
