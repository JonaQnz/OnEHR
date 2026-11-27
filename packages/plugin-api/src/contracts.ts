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
import type { PLUGIN_API_VERSION, PluginHostInfo, PluginManifest, PluginPermission } from './manifest';

export type { FormDataProvider, TerminologyProvider } from 'core';

export type JsonPrimitive = CoreJsonPrimitive;
export type JsonValue = CoreJsonValue;
export type JsonObject = CoreJsonObject;
export type ValidationIssue = CoreValidationIssue;

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
  /** Optional read-only action (typically a hidden `registerRuntimeAction`,
   * so it's dispatchable via POST /plugins/actions but never rendered as
   * its own button) whose `{ data: { active: boolean } }` result reflects
   * whether `actionId`'s own provisioned resource still genuinely exists on
   * the remote side - not just whether this form's settings still
   * *reference* one. Lets the host render `actionId`'s button as a live
   * toggle instead of a static "configure" button (P0.x, 2026-09-09):
   * without this, deleting a provisioned resource out-of-band (e.g. an
   * n8n workflow removed directly in n8n) left the Form Builder side none
   * the wiser - the button still claimed the integration was configured,
   * and re-running `actionId` failed trying to update a resource that no
   * longer existed, instead of transparently provisioning a fresh one. */
  statusActionId?: string;
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

export interface PluginSnapshot {
  apiVersion: typeof PLUGIN_API_VERSION;
  host: PluginHostInfo;
  plugins: PluginManifest[];
  contributions: RegisteredContribution[];
}
