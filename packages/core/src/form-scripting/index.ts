import { NON_FIELD_LAYOUT_TYPES, type CanonicalForm, type FormElementLayout } from '../canonical';

export const FORM_SCRIPT_LANGUAGE = 'typescript' as const;

export type FormScriptDiagnosticSeverity = 'error' | 'warning';

export interface FormScriptDiagnostic {
  code: string | number;
  severity: FormScriptDiagnosticSeverity;
  message: string;
  line?: number;
  column?: number;
  length?: number;
}

export interface FormScriptDocument {
  language: typeof FORM_SCRIPT_LANGUAGE;
  source: string;
  compiled: string;
  generatedTypes: string;
  diagnostics: FormScriptDiagnostic[];
  compiledAt?: string;
}

export const FORM_SCRIPTING_EXTENSION_KEY = 'formbuilder.scripting' as const;
export const FORM_FUNCTION_IMPORTS_EXTENSION_KEY = 'formbuilder.function-imports' as const;

export interface FormScriptJsonSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
  description?: string;
  enum?: Array<string | number | boolean | null>;
  properties?: Record<string, FormScriptJsonSchema>;
  required?: string[];
  items?: FormScriptJsonSchema;
  additionalProperties?: boolean | FormScriptJsonSchema;
}

export interface FormScriptConnectorOperationDefinition {
  id: string;
  label: string;
  description?: string;
  permissions: string[];
  inputSchema: FormScriptJsonSchema;
  outputSchema: FormScriptJsonSchema;
}

export interface FormScriptConnectorConfiguration {
  allowedOperations: string[];
  operations: FormScriptConnectorOperationDefinition[];
}

export interface FormFunctionImportConfiguration {
  codePackages: string[];
  aqlFunctionIds: string[];
}

export const DEFAULT_FORM_SCRIPT_SOURCE = `import { defineFormScript } from "@formbuilder/runtime";

export default defineFormScript(({ form, ui, events, logger }) => {
  // Formularspezifische Logik
});
`;

export type FormScriptEventName =
  | 'beforeLoad'
  | 'afterLoad'
  | 'beforeSave'
  | 'afterSave'
  | 'beforeSubmit'
  | 'afterSubmit'
  | 'onInit'
  | 'onReset'
  | 'onValidation'
  | 'onDestroy';

export type FormScriptChangeSource = 'user' | 'script' | 'load' | 'api' | 'computed';

export interface FormScriptLogEntry {
  id: string;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  event?: string;
  componentId?: string;
  message: string;
  error?: string;
  durationMs?: number;
}

const quote = (value: string): string => JSON.stringify(value);

function walk(node: FormElementLayout, visit: (node: FormElementLayout) => void): void {
  visit(node);
  node.children?.forEach((child) => walk(child, visit));
}

function nodeId(node: FormElementLayout): string | undefined {
  // Must match form-runtime/index.ts's own nodeId() exactly: `id || name`,
  // not `name || id`. This file only generates the FieldId/GroupId type
  // union a designer sees in the Script Editor - but the *runtime* values
  // object (and the DOM inputs bound to it) are keyed by whatever
  // form-runtime's nodeId() picks. Any field whose canonical `id` and
  // `name` differ (the norm for openEHR-bound fields, e.g. id "test_name"
  // vs name "vg_observationlab.v1.2.0_test_name") used to get offered the
  // `name` as its FieldId - a key the runtime never reads, so
  // field(id).setValue()/.prefill() silently no-op'd on script-set fields:
  // the change event log showed the value "changing", but no DOM input
  // ever re-rendered with it. Found live 2026-09-03 verifying AQL prefill
  // against vg_ObservationLab.v1.2.0. See docs/features/aql-prefill.md.
  return node.id || node.name;
}

function union(values: readonly string[]): string {
  return values.length > 0 ? [...new Set(values)].map(quote).join(' | ') : 'never';
}

function schemaType(schema: FormScriptJsonSchema | undefined): string {
  if (!schema) return 'unknown';
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  }
  if (schema.type === 'string') return 'string';
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'boolean') return 'boolean';
  if (schema.type === 'null') return 'null';
  if (schema.type === 'array') return `Array<${schemaType(schema.items)}>`;
  if (schema.type === 'object' || schema.properties) {
    const required = new Set(schema.required || []);
    const properties = Object.entries(schema.properties || {}).map(([key, value]) => (
      `${quote(key)}${required.has(key) ? '' : '?'}: ${schemaType(value)};`
    ));
    const additional = schema.additionalProperties === true
      ? '[key: string]: unknown;'
      : schema.additionalProperties && typeof schema.additionalProperties === 'object'
        ? `[key: string]: ${schemaType(schema.additionalProperties)};`
        : '';
    return `{ ${[...properties, additional].filter(Boolean).join(' ')} }`;
  }
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getFormScriptConnectorConfiguration(
  form: Pick<CanonicalForm, 'layout'> & { extensions?: Record<string, unknown> },
): FormScriptConnectorConfiguration {
  const raw = form.extensions?.[FORM_SCRIPTING_EXTENSION_KEY];
  if (!isRecord(raw)) return { allowedOperations: [], operations: [] };
  const allowedOperations = Array.isArray(raw.allowedOperations)
    ? [...new Set(raw.allowedOperations.filter((item): item is string => typeof item === 'string'))].sort()
    : [];
  const operations = Array.isArray(raw.operations)
    ? raw.operations.filter((item): item is FormScriptConnectorOperationDefinition => Boolean(
      isRecord(item)
      && typeof item.id === 'string'
      && typeof item.label === 'string'
      && Array.isArray(item.permissions)
      && isRecord(item.inputSchema)
      && isRecord(item.outputSchema),
    ))
    : [];
  return {
    allowedOperations,
    operations: operations.filter((operation) => allowedOperations.includes(operation.id)),
  };
}

export function getFormFunctionImportConfiguration(
  form: Pick<CanonicalForm, 'layout'> & { extensions?: Record<string, unknown> },
): FormFunctionImportConfiguration {
  const raw = form.extensions?.[FORM_FUNCTION_IMPORTS_EXTENSION_KEY];
  if (!isRecord(raw)) return { codePackages: [], aqlFunctionIds: [] };
  return {
    codePackages: Array.isArray(raw.codePackages)
      ? [...new Set(raw.codePackages.filter((item): item is string => typeof item === 'string'))].sort()
      : [],
    aqlFunctionIds: Array.isArray(raw.aqlFunctionIds)
      ? [...new Set(raw.aqlFunctionIds.filter((item): item is string => typeof item === 'string'))].sort()
      : [],
  };
}

function optionType(node: FormElementLayout): string {
  // Must match form-runtime's validateOne(), which checks the submitted
  // value against each option's `value` (the openEHR code), never `text`
  // (the human-readable label) - otherwise the generated type promises a
  // shape validate_form_session/submit_form_session_to_provider rejects.
  const values = (node.options || []).map((option) => option.value || option.text);
  return values.length > 0 ? `${union(values)} | null` : 'string | null';
}

// Mirrors packages/core/canonical's CodeMappingValue exactly - kept inline
// (not imported) because generated Form Script types are a standalone
// snippet compiled on its own, see typeScriptDiagnostics() below.
const CODE_MAPPING_VALUE_TYPE = "{ terminologyId: string; code: string; match?: '>' | '=' | '<' | '?'; version?: string; display?: string }";

function valueType(node: FormElementLayout): string {
  if (node.type === 'input-boolean') return 'boolean | null';
  if (['input-number', 'input-range'].includes(node.type)) return 'number | null';
  if (node.type === 'input-quantity') return '{ magnitude: number; unit: string } | null';
  if (node.type === 'input-proportion') return '{ numerator: number; denominator?: number } | null';
  // DV_INTERVAL<DV_QUANTITY> support (P0.1 audit, 2026-09-05) - mirrors
  // FormRuntime.tsx's input-interval branch and form-runtime's own
  // validateIntervalBound: each bound is an independent, optional
  // { magnitude, unit } (an open-ended interval only sets one side).
  // Without this branch valueType() fell through to the generic
  // `string | null` default below, so a Form Script writing/reading a
  // dose-range field's actual { lower, upper } shape via
  // form.field(id).setValue(...) would have been silently mistyped.
  if (node.type === 'input-interval') return '{ lower?: { magnitude: number; unit?: string }; upper?: { magnitude: number; unit?: string } } | null';
  // DV_IDENTIFIER support (P0.1 audit, 2026-09-05) - mirrors FormRuntime.tsx's
  // input-identifier branch. A bare string is also valid (readFlatValue
  // returns one whenever issuer/assigner/type are all empty - see its own
  // comment for why this rmType is shared with a pre-existing plain
  // input-text field), so both shapes are accepted here, matching the
  // codeMappings branch below's own "string | { ... }" convention.
  if (node.type === 'input-identifier') return 'string | { id: string; issuer?: string; assigner?: string; type?: string } | null';
  if (['input-select', 'input-ordinal'].includes(node.type)) return optionType(node);
  if (node.codeMappings?.enabled) {
    // A codeMappings-enabled text field's runtime value is either a plain
    // string (no mapping attached yet) or a CodeMappedTextValue - see that
    // type's own doc comment in canonical/index.ts. Found live 2026-09-05
    // wiring the Laborpanel forms to the lab-analytes-catalog terminology:
    // a Form Script prefilling `{value, mappings}` for a codeMappings field
    // was rejected by TS2322 because this function always promised a bare
    // `string`, never the compound shape scripts actually need to write.
    return `string | { value: string; mappings?: Array<${CODE_MAPPING_VALUE_TYPE}> } | null`;
  }
  return 'string | null';
}

function isButton(node: FormElementLayout): boolean {
  return node.type === 'button' || node.uiElement === 'Button';
}

function isDataField(node: FormElementLayout): boolean {
  return Boolean(nodeId(node))
    && !NON_FIELD_LAYOUT_TYPES.has(node.type)
    // isButton() also catches uiElement === 'Button' on a node whose type
    // isn't literally 'button' - NON_FIELD_LAYOUT_TYPES already excludes
    // type === 'button' too, so this is a deliberately redundant extra
    // check for that case, not dead code.
    && !isButton(node);
}

export interface FormScriptSchemaIds {
  fields: string[];
  groups: string[];
  repeatableGroups: string[];
  sections: string[];
  tabs: string[];
  buttons: string[];
  texts: string[];
  alerts: string[];
}

export function collectFormScriptSchemaIds(form: Pick<CanonicalForm, 'layout'>): FormScriptSchemaIds {
  const result: FormScriptSchemaIds = {
    fields: [],
    groups: [],
    repeatableGroups: [],
    sections: [],
    tabs: [],
    buttons: [],
    texts: [],
    alerts: [],
  };

  walk(form.layout, (node) => {
    const id = nodeId(node);
    if (!id) return;
    if (isDataField(node)) result.fields.push(id);
    if (node.type === 'container') result.groups.push(id);
    if (node.type === 'container' && node.repeatable === true) result.repeatableGroups.push(id);
    if (node.type === 'section') result.sections.push(id);
    if (node.type === 'tab') result.tabs.push(id);
    if (isButton(node)) result.buttons.push(id);
    if (node.type === 'text' || node.type === 'paragraph') result.texts.push(id);
    if (node.type === 'alert') result.alerts.push(id);
  });

  Object.values(result).forEach((ids) => ids.sort());
  return result;
}

export function generateFormScriptTypes(form: Pick<CanonicalForm, 'layout'>): string {
  const ids = collectFormScriptSchemaIds(form);
  const connectorConfiguration = getFormScriptConnectorConfiguration(form);
  const connectorOperations = connectorConfiguration.operations;
  const fields: Array<{ id: string; type: string }> = [];
  const groupFields = new Map<string, Array<{ id: string; type: string }>>();
  const collectFields = (node: FormElementLayout, repeatableGroupId?: string): void => {
    const id = nodeId(node);
    if (id && isDataField(node)) fields.push({ id, type: valueType(node) });
    if (id && isDataField(node) && repeatableGroupId) {
      const current = groupFields.get(repeatableGroupId) || [];
      current.push({ id, type: valueType(node) });
      groupFields.set(repeatableGroupId, current);
    }
    const childGroupId = node.type === 'container' && node.repeatable === true && id
      ? id
      : repeatableGroupId;
    node.children?.forEach((child) => collectFields(child, childGroupId));
  };
  collectFields(form.layout);

  const fieldValueProperties = fields.length > 0
    ? fields.map((field) => `    ${quote(field.id)}: ${field.type};`).join('\n')
    : '    [fieldId: string]: never;';
  const groupValueProperties = ids.repeatableGroups
    .map((id) => `    ${quote(id)}: GroupItems[${quote(id)}][];`)
    .join('\n');
  const groupItemProperties = ids.repeatableGroups.length > 0
    ? ids.repeatableGroups.map((id) => {
      const properties = (groupFields.get(id) || [])
        .map((field) => `      ${quote(field.id)}: ${field.type};`)
        .join('\n');
      return `    ${quote(id)}: {\n${properties || '      [fieldId: string]: never;'}\n    };`;
    }).join('\n')
    : '    [groupId: string]: never;';
  const connectorInputProperties = connectorOperations.length > 0
    ? connectorOperations.map((operation) => `    ${quote(operation.id)}: ${schemaType(operation.inputSchema)};`).join('\n')
    : '    [operation: string]: never;';
  const connectorOutputProperties = connectorOperations.length > 0
    ? connectorOperations.map((operation) => `    ${quote(operation.id)}: ${schemaType(operation.outputSchema)};`).join('\n')
    : '    [operation: string]: never;';
  const connectorCatalog = new Map<string, Array<{ operation: string; definition: FormScriptConnectorOperationDefinition }>>();
  connectorOperations.forEach((definition) => {
    const separator = definition.id.lastIndexOf('.');
    const connector = separator > 0 ? definition.id.slice(0, separator) : definition.id;
    const operation = separator > 0 ? definition.id.slice(separator + 1) : definition.id;
    connectorCatalog.set(connector, [...(connectorCatalog.get(connector) || []), { operation, definition }]);
  });
  const connectorCatalogProperties = connectorCatalog.size > 0
    ? [...connectorCatalog.entries()].map(([connector, operations]) => `    ${quote(connector)}: {
${operations.map(({ operation, definition }) => `      ${quote(operation)}: { input: ${schemaType(definition.inputSchema)}; output: ${schemaType(definition.outputSchema)}; };`).join('\n')}
    };`).join('\n')
    : '    [connector: string]: never;';

  return `declare module "@formbuilder/runtime" {
  export type MaybePromise<T> = T | Promise<T>;
  export type ChangeSource = "user" | "script" | "load" | "api" | "computed";
  export type FieldId = ${union(ids.fields)};
  export type GroupId = ${union(ids.groups)};
  export type RepeatableGroupId = ${union(ids.repeatableGroups)};
  export type SectionId = ${union(ids.sections)};
  export type TabId = ${union(ids.tabs)};
  export type ButtonId = ${union(ids.buttons)};
  export type TextId = ${union(ids.texts)};
  export type AlertId = ${union(ids.alerts)};
  export type ConnectorOperation = ${union(connectorOperations.map((operation) => operation.id))};

  export interface GroupItems {
${groupItemProperties}
  }

  export interface FormValues {
${fieldValueProperties}
${groupValueProperties ? `\n${groupValueProperties}` : ''}
  }

  export interface ConnectorInputs {
${connectorInputProperties}
  }

  export interface ConnectorOutputs {
${connectorOutputProperties}
  }

  export interface ConnectorCatalog {
${connectorCatalogProperties}
  }

  export interface ChangeEvent<T> {
    value: T;
    previousValue: T;
    source: ChangeSource;
    initialLoad: boolean;
    signal: AbortSignal;
  }

  export interface SetValueOptions { emitChange?: boolean; }
  export interface ChangeHandlerOptions { debounce?: number; cancelPrevious?: boolean; }
  export interface PrefillMeta {
    /** Shown next to the field as this value's provenance - typically the
     * imported AQL function's "package.name", but any short label works. */
    source: string;
    timestamp?: string;
  }

  /** A validator's return value. A plain string (or the old bare-string
   * return every existing script already uses) is always treated as a
   * blocking error, unchanged from before - only the object form is new,
   * for a non-blocking warning (or an explicit error with a message). */
  export type FieldValidatorResult = string | { message: string; severity?: 'error' | 'warning' } | null | undefined;

  export interface FieldApi<T> {
    readonly value: T | undefined;
    setValue(value: T, options?: SetValueOptions): void;
    clear(options?: SetValueOptions): void;
    /** Applies an AQL-sourced value, or - if the field already holds a
     * different, non-prefill value (a clinician's own entry) - asks the
     * host via a conflict dialog first. Resolves once the value actually
     * landed (or the clinician declined). See docs/features/aql-prefill.md. */
    prefill(value: T, meta: PrefillMeta): Promise<{ applied: boolean }>;
    onChange(handler: (event: ChangeEvent<T>) => MaybePromise<void>, options?: ChangeHandlerOptions): void;
    /** Return a plain string (or throw) for a blocking error, exactly as
     * before - or { message, severity: 'warning' } for a non-blocking
     * warning shown at the field without preventing submit. */
    validate(handler: (value: T | undefined, context: ValidationContext) => MaybePromise<FieldValidatorResult>): void;
  }

  export interface GroupChangeEvent<T> {
    index: number;
    field: keyof T & FieldId;
    fieldId: keyof T & FieldId;
    value: T[keyof T];
    previousValue: T[keyof T];
    source: ChangeSource;
  }

  export interface GroupApi<T extends Record<string, unknown>> {
    readonly items: readonly Readonly<T>[];
    addItem(initial?: Partial<T>): number;
    removeItem(index: number): void;
    replaceItems(items: readonly T[]): void;
    onAddItem(handler: (event: { index: number; item: Readonly<T> }) => MaybePromise<void>): void;
    onRemoveItem(handler: (event: { index: number; item: Readonly<T> }) => MaybePromise<void>): void;
    onItemChange(handler: (event: GroupChangeEvent<T>) => MaybePromise<void>): void;
  }

  export interface ComputedConfig<K extends FieldId, D extends readonly FieldId[]> {
    dependsOn: D;
    persist?: boolean;
    calculate(values: Pick<FormValues, D[number]>): MaybePromise<FormValues[K]>;
  }

  export interface ValidationContext {
    readonly form: FormApi;
  }

  export interface FormApi {
    readonly values: Partial<FormValues>;
    readonly errors: Partial<Record<FieldId, string>>;
    field<K extends FieldId>(id: K): FieldApi<FormValues[K]>;
    group<K extends RepeatableGroupId>(id: K): GroupApi<GroupItems[K]>;
    updateValues(values: Partial<FormValues>): void;
    computed<K extends FieldId, D extends readonly FieldId[]>(id: K, config: ComputedConfig<K, D>): void;
    setErrors(errors: Partial<Record<FieldId, string | null | undefined>>): void;
    isValid(): boolean;
  }

  export interface UiState {
    visible?: boolean;
    enabled?: boolean;
    readonly?: boolean;
    required?: boolean;
  }

  export interface UiComponentApi {
    show(): void;
    hide(): void;
    enable(): void;
    disable(): void;
    setVisible(value: boolean): void;
    setEnabled(value: boolean): void;
    setReadonly(value: boolean): void;
    setRequired(value: boolean): void;
    setState(state: UiState): void;
  }

  export interface UiFieldApi extends UiComponentApi {
    setLabel(value: string): void;
    setPlaceholder(value: string): void;
    setHelpText(value: string): void;
    setOptions(options: readonly { value: string; label: string }[]): void;
    onFocus(handler: () => MaybePromise<void>): void;
    onBlur(handler: () => MaybePromise<void>): void;
  }

  export interface UiButtonApi extends UiComponentApi {
    onClick(handler: () => MaybePromise<void>): void;
    setLoading(value: boolean): void;
  }

  export interface UiApi {
    field<K extends FieldId>(id: K): UiFieldApi;
    group(id: GroupId): UiComponentApi;
    section(id: SectionId): UiComponentApi;
    tab(id: TabId): UiComponentApi;
    button(id: ButtonId): UiButtonApi;
    toast: {
      success(message: string): void;
      error(message: string): void;
      info(message: string): void;
      warning(message: string): void;
    };
  }

  export interface LifecycleEvent {
    cancel(message?: string): void;
  }

  export interface EventApi {
    beforeLoad(handler: (event: LifecycleEvent) => MaybePromise<void>): void;
    afterLoad(handler: (event: LifecycleEvent) => MaybePromise<void>): void;
    beforeSave(handler: (event: LifecycleEvent) => MaybePromise<void>): void;
    afterSave(handler: (event: LifecycleEvent) => MaybePromise<void>): void;
    beforeSubmit(handler: (event: LifecycleEvent) => MaybePromise<void>): void;
    afterSubmit(handler: (event: LifecycleEvent) => MaybePromise<void>): void;
    onInit(handler: (event: LifecycleEvent) => MaybePromise<void>): void;
    onReset(handler: (event: LifecycleEvent) => MaybePromise<void>): void;
    onValidation(handler: (event: LifecycleEvent) => MaybePromise<void>): void;
    onDestroy(handler: (event: LifecycleEvent) => MaybePromise<void>): void;
  }

  export interface FormScriptContext {
    formId: string;
    formVersion: string;
    templateId?: string;
    patientId?: string;
    ehrId?: string;
    encounterId?: string;
    sessionId?: string;
    locale: string;
    mode: "create" | "edit" | "view" | "preview";
    user: { id?: string; displayName?: string; roles: string[] };
    /** Latest Flat Composition for the form template. It is read-only context, never field values. */
    composition?: {
      ehrId: string;
      templateId: string;
      reference?: string;
      flat: Record<string, unknown>;
      loadedAt: string;
    };
    /** Results of enabled, autoloaded AQL functions, keyed as "package.name". */
    aql: Record<string, unknown>;
  }

  export interface StateApi {
    get<T = unknown>(key: string): T | undefined;
    set<T = unknown>(key: string, value: T): void;
    delete(key: string): void;
  }

  export interface LoggerApi {
    debug(message: string, details?: unknown): void;
    info(message: string, details?: unknown): void;
    warn(message: string, details?: unknown): void;
    error(message: string | unknown, error?: unknown): void;
  }

  export interface ApiCallOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
  }

  export interface Api {
    call<K extends ConnectorOperation>(
      operation: K,
      input: ConnectorInputs[K],
      options?: ApiCallOptions,
    ): Promise<ConnectorOutputs[K]>;
    request<C extends keyof ConnectorCatalog & string, O extends keyof ConnectorCatalog[C] & string>(
      request: {
        connector: C;
        operation: O;
        input: ConnectorCatalog[C][O] extends { input: infer I } ? I : never;
      },
      options?: ApiCallOptions,
    ): Promise<ConnectorCatalog[C][O] extends { output: infer R } ? R : never>;
  }

  /** Built-in helper for resolving a value out of an AQL result row - see
   * context.aql above for where the row data itself comes from. Not a
   * function package (functions.*) - always available, core runtime. */
  export interface AqlApi {
    resolvePath(result: unknown, path: string): unknown;
  }

  export interface FormScriptSdk {
    form: FormApi;
    ui: UiApi;
    api: Api;
    context: FormScriptContext;
    /** Synchronous, browser-safe functions contributed by installed function packages. */
    functions: Record<string, Record<string, (...args: unknown[]) => unknown>>;
    aql: AqlApi;
    state: StateApi;
    events: EventApi;
    logger: LoggerApi;
  }

  export function defineFormScript(
    setup: (sdk: FormScriptSdk) => MaybePromise<void>,
  ): (sdk: FormScriptSdk) => MaybePromise<void>;
}
`;
}

export function createEmptyFormScript(form: Pick<CanonicalForm, 'layout'>): FormScriptDocument {
  return {
    language: FORM_SCRIPT_LANGUAGE,
    source: DEFAULT_FORM_SCRIPT_SOURCE,
    compiled: '',
    generatedTypes: generateFormScriptTypes(form),
    diagnostics: [],
  };
}

export function normalizeFormScript(
  value: unknown,
  form: Pick<CanonicalForm, 'layout'>,
): FormScriptDocument {
  const fallback = createEmptyFormScript(form);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const input = value as Record<string, unknown>;
  return {
    language: FORM_SCRIPT_LANGUAGE,
    source: typeof input.source === 'string' ? input.source : fallback.source,
    compiled: typeof input.compiled === 'string' ? input.compiled : '',
    generatedTypes: generateFormScriptTypes(form),
    diagnostics: Array.isArray(input.diagnostics)
      ? input.diagnostics.filter((item): item is FormScriptDiagnostic => Boolean(
        item
        && typeof item === 'object'
        && !Array.isArray(item)
        && typeof (item as FormScriptDiagnostic).message === 'string',
      ))
      : [],
    ...(typeof input.compiledAt === 'string' ? { compiledAt: input.compiledAt } : {}),
  };
}
