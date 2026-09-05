import type {
  JsonObject as CoreJsonObject,
  JsonPrimitive as CoreJsonPrimitive,
  JsonValue as CoreJsonValue,
  FormIssue as CoreFormIssue,
  ValidationIssue as CoreValidationIssue,
  FormDataProvider,
  TerminologyProvider,
} from 'core';
import type { Principal } from 'core';

export type { FormDataProvider, TerminologyProvider } from 'core';

export type JsonPrimitive = CoreJsonPrimitive;
export type JsonValue = CoreJsonValue;
export type JsonObject = CoreJsonObject;
export type ValidationIssue = CoreValidationIssue;

export const PLUGIN_API_VERSION = '1.0' as const;

export const PLUGIN_EXTENSION_POINTS = [
  'settings',
  'field',
  'form',
  'renderer',
  'designer',
  'runtime',
  'scripting',
  'dataProvider',
  'terminology',
  'workflow',
  'lifecycle',
  'ui',
  'widget',
] as const;

export type PluginExtensionPoint = (typeof PLUGIN_EXTENSION_POINTS)[number];

export const PLUGIN_PERMISSIONS = [
  'form:read',
  'form:write',
  'patient:read',
  'ehrbase:read',
  'ehrbase:write',
  'network:request',
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export type MaybePromise<T> = T | Promise<T>;

/**
 * Framework-neutral frontend extension contract. Components are intentionally
 * opaque here: the web host owns React and validates/renders them at its edge.
 */
export interface FrontendExtensionContribution {
  pluginId: string;
  slot: string;
  component: unknown;
}

export interface FrontendFieldContribution {
  pluginId: string;
  key: string;
  component: unknown;
  toolboxItem: Record<string, unknown>;
}

export interface FrontendRendererContribution {
  pluginId: string;
  uiElement: string;
  renderer: unknown;
}

export interface FrontendPluginRegistrar {
  registerExtension(extension: FrontendExtensionContribution): void;
  registerField(field: FrontendFieldContribution): void;
  registerRenderer(renderer: FrontendRendererContribution): void;
}

export type FrontendPluginRegistration = (registrar: FrontendPluginRegistrar) => MaybePromise<void>;

export interface FrontendPluginModule {
  registerFrontendPlugin?: FrontendPluginRegistration;
}

export interface PluginManifest {
  id: string;
  version: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  name: string;
  description?: string;
  extensionPoints: readonly PluginExtensionPoint[];
  permissions?: readonly PluginPermission[];
}

export interface PluginLogger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface FieldContribution {
  extensionPoint: 'field';
  key: string;
  fieldType: string;
  label: string;
  propertySchema?: JsonObject;
}

export interface SettingsContribution {
  extensionPoint: 'settings';
  key: string;
  panelId: string;
  label: string;
  propertySchema?: JsonObject;
  actionId?: string;
  scope?: 'global' | 'form';
  secretKeys?: readonly string[];
  formSettingsPath?: string;
}

export interface FormContribution {
  extensionPoint: 'form';
  key: string;
  actionId: string;
  label: string;
  placement?: 'toolbar' | 'footer' | 'context' | 'hidden';
}

export interface RendererContribution {
  extensionPoint: 'renderer';
  key: string;
  rendererId: string;
  fieldTypes: readonly string[];
}

export interface DesignerPanelContribution {
  extensionPoint: 'designer';
  key: string;
  panelId: string;
  label: string;
  placement: 'left' | 'right' | 'bottom';
  propertySchema?: JsonObject;
}

export interface RuntimeActionContribution {
  extensionPoint: 'runtime';
  key: string;
  actionId: string;
  label: string;
  placement?: 'toolbar' | 'footer' | 'context' | 'hidden';
}

export interface ScriptingOperationContribution {
  extensionPoint: 'scripting';
  key: string;
  operationId: string;
  actionId: string;
  label: string;
  description?: string;
  permissions?: readonly PluginPermission[];
  inputSchema: JsonObject;
  outputSchema: JsonObject;
}

export interface DataProviderContribution {
  extensionPoint: 'dataProvider';
  key: string;
  providerId: string;
  label: string;
  capabilities: readonly ('load' | 'submit')[];
}

export interface TerminologyProviderContribution {
  extensionPoint: 'terminology';
  key: string;
  providerId: string;
  label: string;
  capabilities: readonly ('search' | 'lookup' | 'validate' | 'discover' | 'manage')[];
}

export interface WorkflowContribution {
  extensionPoint: 'workflow';
  key: string;
  workflowId: string;
  label: string;
  trigger: 'beforeLoad' | 'afterLoad' | 'beforeSave' | 'afterSave' | 'beforeValidate' | 'afterValidate' | 'beforeSubmit' | 'afterSubmit';
}

export interface UIExtensionContribution {
  extensionPoint: 'ui';
  key: string;
  slot: string;
}

/** A plugin may publish several reusable clinical widgets as one package. */
export interface WidgetPackageContribution {
  extensionPoint: 'widget'; key: string; packageId: string; label: string;
  widgets: readonly { id: string; title: string; aqlFunction: { packageName: string; name: string }; requiredContext: readonly ['ehrId']; columns: { value: string; label?: string; time?: string; unit?: string }; chart: { type: 'line' | 'area' | 'bar' | 'metric' | 'table' | 'text'; x?: string; y?: string } }[];
}

export type PluginContribution =
  | FieldContribution
  | SettingsContribution
  | FormContribution
  | RendererContribution
  | DesignerPanelContribution
  | RuntimeActionContribution
  | ScriptingOperationContribution
  | DataProviderContribution
  | TerminologyProviderContribution
  | WorkflowContribution
  | UIExtensionContribution
  | WidgetPackageContribution;

export type RegisteredContribution = PluginContribution & {
  pluginId: string;
};

export type PluginHookName =
  | 'beforeFormLoad'
  | 'afterFormLoad'
  | 'beforeFormSave'
  | 'afterFormSave'
  | 'beforeLoad'
  | 'afterLoad'
  | 'beforeSave'
  | 'afterSave'
  | 'beforeValidate'
  | 'afterValidate'
  | 'beforeSubmit'
  | 'afterSubmit';

export interface PluginHookContext {
  formId?: string;
  patientId?: string;
  sessionId?: string;
  userId?: string;
  /** Trusted server-side caller context. Frontend plugins never construct it. */
  principal?: Principal;
  form: JsonObject;
  data?: JsonObject;
  metadata?: JsonObject;
}

export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, string>;
  returns: string;
  execute: (...args: any[]) => any;
}

export interface FunctionPackageDefinition {
  id: string;
  version: string;
  functions: FunctionDefinition[];
}

export function defineFunctionPackage(pkg: FunctionPackageDefinition): FunctionPackageDefinition {
  return pkg;
}

export interface PluginValidationError extends CoreFormIssue {
  code?: string;
}

export type PluginNoticeSeverity = 'info' | 'warning' | 'error';

export interface PluginNotice {
  severity: PluginNoticeSeverity;
  message: string;
  code?: string;
  path?: string;
  details?: JsonObject;
}

export interface PluginHookResult {
  data?: JsonObject;
  errors?: readonly PluginValidationError[];
  warnings?: readonly PluginNotice[];
  notices?: readonly PluginNotice[];
  stop?: boolean;
  stopMessage?: string;
}

export type PluginHook = (context: PluginHookContext) => MaybePromise<PluginHookResult | void>;
export interface PluginActionContext extends PluginHookContext {
  sessionId?: string;
  userId?: string;
}
export interface PluginActionResult {
  data?: JsonObject;
  message?: string;
  errors?: readonly PluginValidationError[];
  warnings?: readonly PluginNotice[];
  notices?: readonly PluginNotice[];
  stop?: boolean;
  stopMessage?: string;
}
export type PluginAction = (context: PluginActionContext) => MaybePromise<PluginActionResult | void>;

export interface PluginActivationContext {
  manifest: PluginManifest;
  host: PluginHostInfo;
  logger: PluginLogger;
  permissions: readonly PluginPermission[];
  hasPermission(permission: PluginPermission): boolean;
  requirePermission(permission: PluginPermission): void;
  /**
   * This plugin's own persisted settings (whatever was saved through its
   * `settings` contribution's property schema) - read fresh on every call,
   * not just a snapshot from `activate()` time. The generic replacement for
   * a plugin reaching for its settings via a host-injected, per-plugin-id
   * hardcoded metadata key (see `[[hardcoded-example-plugin-settings-fix]]`
   * memory for the exact bug this replaced) - every registered hook/action
   * closure already has `context` in scope, so this is always available
   * without the host needing to know which plugin is asking.
   */
  getSettings(): Record<string, unknown>;
  registerContribution(contribution: PluginContribution): void;
  registerFieldType(contribution: Omit<FieldContribution, 'extensionPoint'>): void;
  registerSettingsPanel(contribution: Omit<SettingsContribution, 'extensionPoint'>): void;
  registerFormAction(contribution: Omit<FormContribution, 'extensionPoint'>): void;
  registerRenderer(contribution: Omit<RendererContribution, 'extensionPoint'>): void;
  registerDesignerPanel(contribution: Omit<DesignerPanelContribution, 'extensionPoint'>): void;
  registerRuntimeAction(contribution: Omit<RuntimeActionContribution, 'extensionPoint'>): void;
  registerScriptingOperation(
    contribution: Omit<ScriptingOperationContribution, 'extensionPoint' | 'actionId'>,
    handler: PluginAction,
  ): void;
  registerDataProvider(contribution: Omit<DataProviderContribution, 'extensionPoint'>): void;
  /**
   * Registers a live, callable `FormDataProvider` implementation - not just
   * the `DataProviderContribution` metadata `registerDataProvider` above
   * declares. This is what makes a provider actually reachable via
   * `getDataProvider(id)` on the host; the metadata contribution is derived
   * from the provider automatically (id/displayName/capabilities), so a
   * plugin never has to declare the same information twice. Use this (not a
   * hardcoded host-side registration) for any provider that only makes sense
   * when this plugin is actually installed and configured - e.g. a
   * workflow-engine submission target a form can only be switched to via
   * this same plugin's own settings panel.
   */
  registerFormDataProvider(provider: FormDataProvider): void;
  /**
   * Registers a live, callable `TerminologyProvider` implementation -
   * exactly the same shape/purpose as `registerFormDataProvider` above,
   * mirrored for terminology search/lookup/validate/discover/manage. Core
   * and `apps/api`'s generic terminology routes know only the neutral
   * `TerminologyProvider` contract (packages/core/terminology) - never a
   * concrete backend like HAPI/FHIR. See the HAPI terminology plugin for
   * the reference implementation.
   */
  registerTerminologyProvider(provider: TerminologyProvider): void;
  registerWidgetPackage(contribution: Omit<WidgetPackageContribution, 'extensionPoint'>): void;
  registerWorkflow(contribution: Omit<WorkflowContribution, 'extensionPoint'>): void;
  registerUIExtension(contribution: Omit<UIExtensionContribution, 'extensionPoint'>): void;
  registerHook(name: PluginHookName, handler: PluginHook): void;
  registerAction(actionId: string, handler: PluginAction): void;
}

export interface FormBuilderPlugin {
  manifest: PluginManifest;
  activate(context: PluginActivationContext): MaybePromise<void>;
}

export interface PluginHostInfo {
  apiVersion: typeof PLUGIN_API_VERSION;
  extensionPoints: readonly PluginExtensionPoint[];
  permissions: readonly PluginPermission[];
}

export interface PluginSnapshot {
  apiVersion: typeof PLUGIN_API_VERSION;
  host: PluginHostInfo;
  plugins: PluginManifest[];
  contributions: RegisteredContribution[];
}

const HOOK_NAMES: readonly PluginHookName[] = [
  'beforeFormLoad',
  'afterFormLoad',
  'beforeFormSave',
  'afterFormSave',
  'beforeLoad',
  'afterLoad',
  'beforeSave',
  'afterSave',
  'beforeValidate',
  'afterValidate',
  'beforeSubmit',
  'afterSubmit',
];

const extensionPointSet = new Set<string>(PLUGIN_EXTENSION_POINTS);
const permissionSet = new Set<string>(PLUGIN_PERMISSIONS);
const hookNameSet = new Set<string>(HOOK_NAMES);
export const PLUGIN_HOST_INFO: PluginHostInfo = Object.freeze({
  apiVersion: PLUGIN_API_VERSION,
  extensionPoints: Object.freeze([...PLUGIN_EXTENSION_POINTS]),
  permissions: Object.freeze([...PLUGIN_PERMISSIONS]),
});

function validateManifest(manifest: PluginManifest): void {
  if (!manifest || typeof manifest !== 'object') throw new Error('Plugin manifest is required');
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(manifest.id)) {
    throw new Error('Plugin manifest id must be a lowercase namespace identifier');
  }
  if (!manifest.name || !manifest.version) throw new Error('Plugin manifest name and version are required');
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(`Plugin API version "${PLUGIN_API_VERSION}" is required`);
  }
  if (!Array.isArray(manifest.extensionPoints) || manifest.extensionPoints.length === 0) {
    throw new Error('Plugin manifest must declare at least one extension point');
  }
  if (new Set(manifest.extensionPoints).size !== manifest.extensionPoints.length) {
    throw new Error('Plugin manifest extension points must be unique');
  }
  for (const point of manifest.extensionPoints) {
    if (!extensionPointSet.has(point)) throw new Error(`Unsupported plugin extension point: ${point}`);
  }
  for (const permission of manifest.permissions || []) {
    if (!permissionSet.has(permission)) throw new Error(`Unsupported plugin permission: ${permission}`);
  }
  if (new Set(manifest.permissions || []).size !== (manifest.permissions || []).length) {
    throw new Error('Plugin manifest permissions must be unique');
  }
}

function validateContribution(contribution: PluginContribution): void {
  if (!contribution || typeof contribution !== 'object') throw new Error('Plugin contribution is required');
  if (!extensionPointSet.has(contribution.extensionPoint)) {
    throw new Error(`Unsupported plugin extension point: ${contribution.extensionPoint}`);
  }
  if (!contribution.key || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(contribution.key)) {
    throw new Error('Plugin contribution key must be a lowercase namespace identifier');
  }
  if (contribution.extensionPoint === 'widget') {
    if (!contribution.packageId || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(contribution.packageId)) throw new Error('Widget packageId must be a lowercase namespace identifier');
    if (!contribution.label?.trim() || !Array.isArray(contribution.widgets) || contribution.widgets.length === 0) throw new Error('Widget package must declare a label and at least one widget');
    const widgetIds = new Set<string>();
    for (const widget of contribution.widgets) {
      if (!widget || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(widget.id) || widgetIds.has(widget.id)) throw new Error('Widget package widget ids must be unique lowercase namespace identifiers');
      widgetIds.add(widget.id);
      if (!widget.title?.trim() || !widget.aqlFunction?.packageName?.trim() || !widget.aqlFunction?.name?.trim()) throw new Error('Widget package widgets require a title and qualified AQL function');
      if (widget.requiredContext.length !== 1 || widget.requiredContext[0] !== 'ehrId') throw new Error('Widget package widgets must require ehrId context');
      if (!widget.columns?.value?.trim() || !widget.chart || !['line', 'area', 'bar', 'metric', 'table', 'text'].includes(widget.chart.type)) throw new Error('Widget package widgets require named columns and a supported chart type');
    }
  }
}

/** Plugins run in-process with no sandbox (see pluginRegistry.ts on the host
 * side) - there is no way to forcibly stop a plugin's code once it's
 * running, only to stop *waiting* on it. A real fix is isolating plugin
 * execution in its own process/worker, which is a bigger architectural step;
 * until then, racing a timeout at least keeps one hung plugin from stalling
 * every request or the whole server startup indefinitely. The original
 * promise is left to settle in the background - this bounds the wait, not
 * the work.
 * Default of 10s mirrors the existing script-connector timeout (see
 * scriptConnectorRegistry.ts), which is the only other place in this
 * codebase that already had to solve the same problem for plugin code. */
const DEFAULT_PLUGIN_TIMEOUT_MS = 10_000;

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, describe: () => string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${describe()} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export class PluginRegistry {
  private readonly plugins = new Map<string, FormBuilderPlugin>();
  private readonly contributions = new Map<string, RegisteredContribution>();
  private readonly hooks = new Map<PluginHookName, Array<{ pluginId: string; handler: PluginHook }>>();
  private readonly actions = new Map<string, { pluginId: string; handler: PluginAction }>();
  private readonly dataProviders = new Map<string, { pluginId: string; provider: FormDataProvider }>();
  private readonly terminologyProviders = new Map<string, { pluginId: string; provider: TerminologyProvider }>();

  public constructor(
    private readonly logger: PluginLogger = console,
    private readonly pluginTimeoutMs: number = DEFAULT_PLUGIN_TIMEOUT_MS,
    /** Reads one plugin's own persisted settings by id - backs
     * `PluginActivationContext.getSettings()`. Optional so a host that has
     * no persisted-settings concept at all (e.g. a test harness) can still
     * construct a registry; `getSettings()` then just returns `{}`. */
    private readonly getPluginSettingsFn?: (pluginId: string) => Record<string, unknown>,
  ) {}

  public async register(plugin: FormBuilderPlugin): Promise<void> {
    validateManifest(plugin?.manifest);
    if (typeof plugin.activate !== 'function') throw new Error(`Plugin ${plugin.manifest.id} must export activate()`);
    if (this.plugins.has(plugin.manifest.id)) throw new Error(`Plugin ${plugin.manifest.id} is already registered`);

    const pendingContributions: PluginContribution[] = [];
    const pendingHooks: Array<{ name: PluginHookName; handler: PluginHook }> = [];
    const pendingActions: Array<{ actionId: string; handler: PluginAction }> = [];
    const pendingDataProviders: FormDataProvider[] = [];
    const pendingTerminologyProviders: TerminologyProvider[] = [];
    const context: PluginActivationContext = {
      manifest: plugin.manifest,
      host: PLUGIN_HOST_INFO,
      logger: this.logger,
      permissions: Object.freeze([...(plugin.manifest.permissions || [])]),
      hasPermission: (permission) => (plugin.manifest.permissions || []).includes(permission),
      requirePermission: (permission) => {
        if (!(plugin.manifest.permissions || []).includes(permission)) throw new Error(`Plugin ${plugin.manifest.id} requires permission ${permission}`);
      },
      getSettings: () => (this.getPluginSettingsFn ? this.getPluginSettingsFn(plugin.manifest.id) : {}),
      registerContribution: (contribution) => {
        validateContribution(contribution);
        if (!plugin.manifest.extensionPoints.includes(contribution.extensionPoint)) {
          throw new Error(`Plugin ${plugin.manifest.id} has not declared ${contribution.extensionPoint}`);
        }
        if (contribution.extensionPoint === 'scripting') {
          if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(contribution.operationId)) {
            throw new Error('Scripting operation id must be a lowercase namespace identifier');
          }
          for (const permission of contribution.permissions || []) {
            if (!(plugin.manifest.permissions || []).includes(permission)) {
              throw new Error(`Plugin ${plugin.manifest.id} scripting operation requires undeclared permission ${permission}`);
            }
          }
        }
        pendingContributions.push(contribution);
      },
      registerFieldType: (contribution) => context.registerContribution({ ...contribution, extensionPoint: 'field' }),
      registerSettingsPanel: (contribution) => context.registerContribution({ ...contribution, extensionPoint: 'settings' }),
      registerFormAction: (contribution) => context.registerContribution({ ...contribution, extensionPoint: 'form' }),
      registerRenderer: (contribution) => context.registerContribution({ ...contribution, extensionPoint: 'renderer' }),
      registerDesignerPanel: (contribution) => context.registerContribution({ ...contribution, extensionPoint: 'designer' }),
      registerRuntimeAction: (contribution) => context.registerContribution({ ...contribution, extensionPoint: 'runtime' }),
      registerScriptingOperation: (contribution, handler) => {
        if (typeof handler !== 'function') throw new Error(`Scripting operation ${contribution.operationId} must have a handler`);
        const actionId = `scripting.${contribution.operationId}`;
        context.registerContribution({ ...contribution, actionId, extensionPoint: 'scripting' });
        pendingActions.push({ actionId, handler });
      },
      registerDataProvider: (contribution) => context.registerContribution({ ...contribution, extensionPoint: 'dataProvider' }),
      registerFormDataProvider: (provider) => {
        if (!provider || typeof provider.id !== 'string' || !provider.id) throw new Error(`Plugin ${plugin.manifest.id} registered a data provider with no id`);
        if (typeof provider.load !== 'function' || typeof provider.submit !== 'function') {
          throw new Error(`Plugin ${plugin.manifest.id} data provider ${provider.id} must implement load() and submit()`);
        }
        if (this.dataProviders.has(provider.id)) throw new Error(`Data provider ${provider.id} is already registered`);
        if (pendingDataProviders.some((existing) => existing.id === provider.id)) throw new Error(`Data provider ${provider.id} is already registered`);
        // Derive the metadata contribution from the provider itself - a
        // plugin author never has to declare id/displayName/capabilities
        // twice. `draft` has no DataProviderContribution equivalent (that
        // capability list predates it); load/submit are the only ones any
        // host-side listing currently needs to show.
        context.registerContribution({
          extensionPoint: 'dataProvider',
          key: provider.id,
          providerId: provider.id,
          label: provider.displayName,
          capabilities: provider.capabilities.filter((capability): capability is 'load' | 'submit' => capability === 'load' || capability === 'submit'),
        });
        pendingDataProviders.push(provider);
      },
      registerTerminologyProvider: (provider) => {
        if (!provider || typeof provider.id !== 'string' || !provider.id) throw new Error(`Plugin ${plugin.manifest.id} registered a terminology provider with no id`);
        if (typeof provider.search !== 'function' || typeof provider.lookup !== 'function' || typeof provider.validate !== 'function') {
          throw new Error(`Plugin ${plugin.manifest.id} terminology provider ${provider.id} must implement search(), lookup() and validate()`);
        }
        if (this.terminologyProviders.has(provider.id)) throw new Error(`Terminology provider ${provider.id} is already registered`);
        if (pendingTerminologyProviders.some((existing) => existing.id === provider.id)) throw new Error(`Terminology provider ${provider.id} is already registered`);
        // Same derive-the-metadata-from-the-provider pattern as
        // registerFormDataProvider just above - a plugin author never
        // declares id/displayName/capabilities twice.
        context.registerContribution({
          extensionPoint: 'terminology',
          key: provider.id,
          providerId: provider.id,
          label: provider.displayName,
          capabilities: provider.capabilities,
        });
        pendingTerminologyProviders.push(provider);
      },
      registerWidgetPackage: (contribution) => context.registerContribution({ ...contribution, extensionPoint: 'widget' }),
      registerWorkflow: (contribution) => context.registerContribution({ ...contribution, extensionPoint: 'workflow' }),
      registerUIExtension: (contribution) => context.registerContribution({ ...contribution, extensionPoint: 'ui' }),
      registerHook: (name, handler) => {
        if (!hookNameSet.has(name)) throw new Error(`Unsupported plugin hook: ${name}`);
        if (!plugin.manifest.extensionPoints.includes('lifecycle')) {
          throw new Error(`Plugin ${plugin.manifest.id} has not declared lifecycle`);
        }
        if (typeof handler !== 'function') throw new Error(`Plugin hook ${name} must be a function`);
        pendingHooks.push({ name, handler });
      },
      registerAction: (actionId, handler) => {
        if (!actionId || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(actionId)) throw new Error('Plugin action id must be a lowercase namespace identifier');
        if (typeof handler !== 'function') throw new Error(`Plugin action ${actionId} must be a function`);
        pendingActions.push({ actionId, handler });
      },
    };

    await withTimeout(
      Promise.resolve(plugin.activate(context)),
      this.pluginTimeoutMs,
      () => `Plugin ${plugin.manifest.id} activate()`,
    );
    const pendingKeys = new Set<string>();
    for (const contribution of pendingContributions) {
      const key = `${contribution.extensionPoint}:${contribution.key}`;
      if (pendingKeys.has(key)) throw new Error(`Plugin contribution ${key} is already registered`);
      if (this.contributions.has(key)) throw new Error(`Plugin contribution ${key} is already registered`);
      pendingKeys.add(key);
    }
    const pendingActionIds = new Set<string>();
    for (const action of pendingActions) {
      if (pendingActionIds.has(action.actionId) || this.actions.has(`${plugin.manifest.id}:${action.actionId}`)) throw new Error(`Plugin action ${action.actionId} is already registered`);
      pendingActionIds.add(action.actionId);
    }
    for (const contribution of pendingContributions) {
      const key = `${contribution.extensionPoint}:${contribution.key}`;
      this.contributions.set(key, { ...contribution, pluginId: plugin.manifest.id });
    }
    this.plugins.set(plugin.manifest.id, plugin);
    for (const hook of pendingHooks) {
      const handlers = this.hooks.get(hook.name) || [];
      handlers.push({ pluginId: plugin.manifest.id, handler: hook.handler });
      this.hooks.set(hook.name, handlers);
    }
    for (const action of pendingActions) {
      this.actions.set(`${plugin.manifest.id}:${action.actionId}`, { pluginId: plugin.manifest.id, handler: action.handler });
    }
    for (const provider of pendingDataProviders) {
      this.dataProviders.set(provider.id, { pluginId: plugin.manifest.id, provider });
    }
    for (const provider of pendingTerminologyProviders) {
      this.terminologyProviders.set(provider.id, { pluginId: plugin.manifest.id, provider });
    }
  }

  public getDataProvider(id: string): FormDataProvider | undefined {
    return this.dataProviders.get(id)?.provider;
  }

  public listDataProviders(): FormDataProvider[] {
    return Array.from(this.dataProviders.values(), (entry) => entry.provider);
  }

  public getTerminologyProvider(id: string): TerminologyProvider | undefined {
    return this.terminologyProviders.get(id)?.provider;
  }

  public listTerminologyProviders(): TerminologyProvider[] {
    return Array.from(this.terminologyProviders.values(), (entry) => entry.provider);
  }

  public unregister(pluginId: string): boolean {
    if (!this.plugins.delete(pluginId)) return false;
    for (const [id, entry] of this.dataProviders.entries()) {
      if (entry.pluginId === pluginId) this.dataProviders.delete(id);
    }
    for (const [id, entry] of this.terminologyProviders.entries()) {
      if (entry.pluginId === pluginId) this.terminologyProviders.delete(id);
    }
    for (const [key, contribution] of this.contributions.entries()) {
      if (contribution.pluginId === pluginId) this.contributions.delete(key);
    }
    for (const [name, handlers] of this.hooks.entries()) {
      const remaining = handlers.filter((handler) => handler.pluginId !== pluginId);
      if (remaining.length === 0) this.hooks.delete(name);
      else this.hooks.set(name, remaining);
    }
    for (const [key, action] of this.actions.entries()) {
      if (action.pluginId === pluginId) this.actions.delete(key);
    }
    return true;
  }

  public getManifests(): PluginManifest[] {
    return Array.from(this.plugins.values(), (plugin) => ({ ...plugin.manifest }));
  }

  public getContributions(): RegisteredContribution[] {
    return Array.from(this.contributions.values(), (contribution) => ({ ...contribution }));
  }

  public snapshot(): PluginSnapshot {
    return { apiVersion: PLUGIN_API_VERSION, host: PLUGIN_HOST_INFO, plugins: this.getManifests(), contributions: this.getContributions() };
  }

  public async runHook(name: PluginHookName, context: PluginHookContext): Promise<PluginHookResult> {
    let data = context.data;
    const errors: PluginValidationError[] = [];
    const notices: PluginNotice[] = [];
    let stop = false;
    let stopMessage: string | undefined;
    for (const registered of this.hooks.get(name) || []) {
      try {
        const result = await withTimeout(
          Promise.resolve(registered.handler({ ...context, data })),
          this.pluginTimeoutMs,
          () => `Plugin ${registered.pluginId} hook ${name}`,
        );
        if (result?.data) data = result.data;
        if (result?.errors) errors.push(...result.errors);
        if (result?.errors) notices.push(...result.errors.map((error) => ({ severity: 'error' as const, path: error.path, message: error.message })));
        if (result?.warnings) notices.push(...result.warnings);
        if (result?.notices) notices.push(...result.notices);
        if (result?.stop) {
          stop = true;
          stopMessage = result.stopMessage;
          break;
        }
      } catch (error) {
        this.logger.error('Plugin lifecycle hook failed', { pluginId: registered.pluginId, hook: name, error: error instanceof Error ? error.message : String(error) });
        const message = `Plugin ${registered.pluginId} failed during ${name}`;
        errors.push({ path: `plugin:${registered.pluginId}`, message });
        notices.push({ severity: 'error', path: `plugin:${registered.pluginId}`, message });
      }
    }
    return { data, errors, notices, stop, ...(stopMessage ? { stopMessage } : {}) };
  }
  public async runAction(pluginId: string, actionId: string, context: PluginActionContext): Promise<PluginActionResult> {
    const action = this.actions.get(`${pluginId}:${actionId}`);
    if (!action) throw new Error(`Plugin action ${pluginId}:${actionId} is not registered`);
    try {
      return (await withTimeout(
        Promise.resolve(action.handler(context)),
        this.pluginTimeoutMs,
        () => `Plugin ${pluginId} action ${actionId}`,
      )) || {};
    } catch (error) {
      this.logger.error('Plugin action failed', { pluginId, actionId, error: error instanceof Error ? error.message : String(error) });
      return { errors: [{ path: `plugin:${pluginId}`, message: `Plugin ${pluginId} failed during action ${actionId}` }] };
    }
  }
}
