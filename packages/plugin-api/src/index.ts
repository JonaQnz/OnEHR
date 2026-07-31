import type {
  JsonObject as CoreJsonObject,
  JsonPrimitive as CoreJsonPrimitive,
  JsonValue as CoreJsonValue,
  FormIssue as CoreFormIssue,
  ValidationIssue as CoreValidationIssue,
} from 'core';

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
  'workflow',
  'lifecycle',
  'ui',
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

export type PluginContribution =
  | FieldContribution
  | SettingsContribution
  | FormContribution
  | RendererContribution
  | DesignerPanelContribution
  | RuntimeActionContribution
  | ScriptingOperationContribution
  | DataProviderContribution
  | WorkflowContribution
  | UIExtensionContribution;

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
}

export class PluginRegistry {
  private readonly plugins = new Map<string, FormBuilderPlugin>();
  private readonly contributions = new Map<string, RegisteredContribution>();
  private readonly hooks = new Map<PluginHookName, Array<{ pluginId: string; handler: PluginHook }>>();
  private readonly actions = new Map<string, { pluginId: string; handler: PluginAction }>();

  public constructor(private readonly logger: PluginLogger = console) {}

  public async register(plugin: FormBuilderPlugin): Promise<void> {
    validateManifest(plugin?.manifest);
    if (typeof plugin.activate !== 'function') throw new Error(`Plugin ${plugin.manifest.id} must export activate()`);
    if (this.plugins.has(plugin.manifest.id)) throw new Error(`Plugin ${plugin.manifest.id} is already registered`);

    const pendingContributions: PluginContribution[] = [];
    const pendingHooks: Array<{ name: PluginHookName; handler: PluginHook }> = [];
    const pendingActions: Array<{ actionId: string; handler: PluginAction }> = [];
    const context: PluginActivationContext = {
      manifest: plugin.manifest,
      host: PLUGIN_HOST_INFO,
      logger: this.logger,
      permissions: Object.freeze([...(plugin.manifest.permissions || [])]),
      hasPermission: (permission) => (plugin.manifest.permissions || []).includes(permission),
      requirePermission: (permission) => {
        if (!(plugin.manifest.permissions || []).includes(permission)) throw new Error(`Plugin ${plugin.manifest.id} requires permission ${permission}`);
      },
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

    await plugin.activate(context);
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
  }

  public unregister(pluginId: string): boolean {
    if (!this.plugins.delete(pluginId)) return false;
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
        const result = await registered.handler({ ...context, data });
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
      return (await action.handler(context)) || {};
    } catch (error) {
      this.logger.error('Plugin action failed', { pluginId, actionId, error: error instanceof Error ? error.message : String(error) });
      return { errors: [{ path: `plugin:${pluginId}`, message: `Plugin ${pluginId} failed during action ${actionId}` }] };
    }
  }
}
