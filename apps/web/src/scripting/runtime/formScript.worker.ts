import { buildGlobalFunctionsObject } from './registeredFunctions';

export interface FormScriptUiState {
  visible?: boolean;
  enabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  loading?: boolean;
  label?: string;
  placeholder?: string;
  helpText?: string;
  options?: Array<{ value: string; label: string }>;
}

type ChangeSource = 'user' | 'script' | 'load' | 'api' | 'computed';
type LifecycleName =
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

interface ChangePayload {
  id: string;
  value: unknown;
  previousValue: unknown;
  source: ChangeSource;
  initialLoad: boolean;
}

interface GroupChangePayload {
  groupId: string;
  index: number;
  fieldId: string;
  field?: string;
  value: unknown;
  previousValue: unknown;
  source: ChangeSource;
}

interface InitMessage {
  type: 'init';
  compiled: string;
  values: Record<string, unknown>;
  ids: {
    fields: string[];
    groups: string[];
    repeatableGroups: string[];
    groupFields: Record<string, string[]>;
    sections: string[];
    tabs: string[];
    buttons: string[];
  };
  requiredFields: string[];
  context: Record<string, unknown>;
  runtimeFunctions: Array<{ packageName: string; name: string; source: string }>;
}

type HostMessage =
  | InitMessage
  | { type: 'change'; change: ChangePayload }
  | { type: 'group-change'; change: GroupChangePayload }
  | { type: 'group-add'; groupId: string; index: number; item: Record<string, unknown> }
  | { type: 'group-remove'; groupId: string; index: number; item: Record<string, unknown> }
  | { type: 'values'; values: Record<string, unknown>; source: ChangeSource; emitChanges: boolean }
  | { type: 'lifecycle'; name: LifecycleName; requestId: string; values: Record<string, unknown> }
  | { type: 'validate'; requestId: string; values: Record<string, unknown> }
  | { type: 'api:response'; requestId: string; result?: unknown; error?: string; code?: string; durationMs?: number }
  | { type: 'ui-event'; event: 'focus' | 'blur'; id: string }
  | { type: 'button'; id: string }
  | { type: 'destroy'; requestId: string };

type Handler<T = unknown> = (event: T) => void | Promise<void>;
type LifecycleHandler = Handler<{ cancel(message?: string): void }>;
type Validator = (value: unknown, context: { form: unknown }) =>
  string | null | undefined | Promise<string | null | undefined>;
interface ComputedDefinition {
  id: string;
  dependsOn: string[];
  persist: boolean;
  calculate: (values: Record<string, unknown>) => unknown | Promise<unknown>;
  lastDependencies?: Record<string, unknown>;
}
interface ChangeHandlerRegistration {
  handler: Handler<ChangePayload & { signal: AbortSignal }>;
  debounce: number;
  cancelPrevious: boolean;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
}
interface PendingApiRequest {
  operation: string;
  startedAt: number;
  event?: string;
  componentId?: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

const workerScope = self as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<HostMessage>) => void) | null;
};

const EMPTY_IDS: InitMessage['ids'] = {
  fields: [],
  groups: [],
  repeatableGroups: [],
  groupFields: {},
  sections: [],
  tabs: [],
  buttons: [],
};

let values: Record<string, unknown> = {};
let context: Record<string, unknown> = {};
let knownIds: InitMessage['ids'] = EMPTY_IDS;
let requiredFields = new Set<string>();
let uiRequiredFields = new Map<string, boolean>();
let activeEvent: string | undefined;
let activeComponentId: string | undefined;
const stateValues = new Map<string, unknown>();
const changeHandlers = new Map<string, ChangeHandlerRegistration[]>();
const groupAddHandlers = new Map<string, Handler<{ index: number; item: Record<string, unknown> }>[]>();
const groupRemoveHandlers = new Map<string, Handler<{ index: number; item: Record<string, unknown> }>[]>();
const groupChangeHandlers = new Map<string, Handler<GroupChangePayload>[]>();
const uiHandlers = new Map<string, Handler[]>();
const lifecycleHandlers = new Map<LifecycleName, LifecycleHandler[]>();
const validators = new Map<string, Validator[]>();
const computedDefinitions = new Map<string, ComputedDefinition>();
const manualErrors = new Map<string, string>();
const validatorErrors = new Map<string, string>();
const pendingChanges: ChangePayload[] = [];
const pendingApiRequests = new Map<string, PendingApiRequest>();
const apiButtonPending = new Map<string, number>();
let changePump: Promise<void> | undefined;
let changePumpSuspended = 0;
let logSequence = 0;
let apiSequence = 0;
let lastPostedErrors = '';

const equal = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

const printable = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const asRows = (value: unknown): Record<string, unknown>[] => (
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : []
);

function post(type: string, payload: Record<string, unknown> = {}): void {
  workerScope.postMessage({ type, ...payload });
}

function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: unknown,
  error?: unknown,
  durationMs?: number,
): void {
  logSequence += 1;
  post('log', {
    entry: {
      id: `script-log-${Date.now()}-${logSequence}`,
      timestamp: new Date().toISOString(),
      level,
      ...(activeEvent ? { event: activeEvent } : {}),
      ...(activeComponentId ? { componentId: activeComponentId } : {}),
      message: printable(message) || '',
      ...(error !== undefined ? { error: printable(error) } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
  });
}

async function safeHandler<T>(handler: Handler<T>, event: T, label: string): Promise<void> {
  const started = performance.now();
  try {
    await handler(event);
    log('debug', label, undefined, Math.round((performance.now() - started) * 100) / 100);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      log('debug', `${label} abgebrochen.`, undefined, Math.round((performance.now() - started) * 100) / 100);
      return;
    }
    log('error', `Fehler in ${label}`, error, Math.round((performance.now() - started) * 100) / 100);
  }
}

function assertKnown(kind: keyof InitMessage['ids'], id: string): void {
  const ids = knownIds[kind];
  if (!Array.isArray(ids) || !ids.includes(id)) {
    throw new Error(`Unbekannte ${kind}-ID "${id}".`);
  }
}

function groupForField(id: string): string | undefined {
  return Object.entries(knownIds.groupFields).find(([, fieldIds]) => fieldIds.includes(id))?.[0];
}

function allErrors(): Record<string, string> {
  return { ...Object.fromEntries(manualErrors), ...Object.fromEntries(validatorErrors) };
}

function postErrors(): void {
  const errors = allErrors();
  const serialized = JSON.stringify(errors);
  if (serialized === lastPostedErrors) return;
  lastPostedErrors = serialized;
  post('validation:errors', { errors });
}

function setManualErrors(errors: Record<string, unknown>): void {
  Object.entries(errors).forEach(([path, message]) => {
    if (typeof message === 'string' && message.trim()) manualErrors.set(path, message);
    else manualErrors.delete(path);
  });
  postErrors();
}

function dependencySnapshot(definition: ComputedDefinition): Record<string, unknown> {
  return Object.fromEntries(definition.dependsOn.map((id) => [id, values[id]]));
}

function assertNoComputedCycle(): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (id: string): void => {
    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id);
      const cycle = [...path.slice(cycleStart), id].join(' -> ');
      throw new Error(`Zyklus in berechneten Feldern erkannt: ${cycle}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    path.push(id);
    const definition = computedDefinitions.get(id);
    definition?.dependsOn.filter((dependency) => computedDefinitions.has(dependency)).forEach(visit);
    path.pop();
    visiting.delete(id);
    visited.add(id);
  };

  computedDefinitions.forEach((_, id) => visit(id));
}

function registerComputed(id: string, config: Record<string, unknown>): void {
  assertKnown('fields', id);
  if (computedDefinitions.has(id)) throw new Error(`Das berechnete Feld "${id}" wurde mehrfach registriert.`);
  if (!Array.isArray(config.dependsOn) || config.dependsOn.some((dependency) => typeof dependency !== 'string')) {
    throw new Error(`form.computed("${id}") benötigt ein dependsOn-Array.`);
  }
  const dependsOn = [...new Set(config.dependsOn as string[])];
  dependsOn.forEach((dependency) => assertKnown('fields', dependency));
  if (typeof config.calculate !== 'function') {
    throw new Error(`form.computed("${id}") benötigt eine calculate-Funktion.`);
  }
  const definition: ComputedDefinition = {
    id,
    dependsOn,
    persist: config.persist !== false,
    calculate: config.calculate as ComputedDefinition['calculate'],
  };
  computedDefinitions.set(id, definition);
  try {
    assertNoComputedCycle();
  } catch (error) {
    computedDefinitions.delete(id);
    throw error;
  }
}

async function runComputed(definition: ComputedDefinition, force = false): Promise<void> {
  const dependencies = dependencySnapshot(definition);
  if (!force && definition.lastDependencies && equal(definition.lastDependencies, dependencies)) return;
  definition.lastDependencies = dependencies;
  const previousEvent = activeEvent;
  const previousComponent = activeComponentId;
  activeEvent = `${definition.id}.computed`;
  activeComponentId = definition.id;
  const started = performance.now();
  try {
    const nextValue = await definition.calculate({ ...dependencies });
    setFieldValue(definition.id, nextValue, { emitChange: true }, 'computed', definition.persist);
    log(
      'debug',
      `${definition.id} neu berechnet${definition.persist ? '' : ' (nicht persistent)'}.`,
      undefined,
      Math.round((performance.now() - started) * 100) / 100,
    );
  } catch (error) {
    log('error', `Berechnung für "${definition.id}" fehlgeschlagen.`, error);
  } finally {
    activeEvent = previousEvent;
    activeComponentId = previousComponent;
  }
}

async function recomputeDependents(dependencyId: string): Promise<void> {
  for (const definition of computedDefinitions.values()) {
    if (definition.dependsOn.includes(dependencyId)) await runComputed(definition);
  }
}

async function runAllComputed(): Promise<void> {
  const visited = new Set<string>();
  const run = async (id: string): Promise<void> => {
    if (visited.has(id)) return;
    const definition = computedDefinitions.get(id);
    if (!definition) return;
    for (const dependency of definition.dependsOn) await run(dependency);
    await runComputed(definition, true);
    visited.add(id);
  };
  changePumpSuspended += 1;
  try {
    for (const id of computedDefinitions.keys()) await run(id);
  } finally {
    changePumpSuspended -= 1;
    if (pendingChanges.length > 0) void ensureChangePump();
  }
}

async function runValidatorHandlers(path: string, value: unknown, fieldId: string): Promise<void> {
  validatorErrors.delete(path);
  const fieldValidators = validators.get(fieldId) || [];
  for (const validator of fieldValidators) {
    try {
      const result = await validator(value, { form: createSdk().form });
      if (typeof result === 'string' && result.trim()) {
        validatorErrors.set(path, result);
        break;
      }
    } catch (error) {
      log('error', `Validierung für "${path}" fehlgeschlagen.`, error);
      validatorErrors.set(path, 'Die Script-Validierung konnte nicht ausgeführt werden.');
      break;
    }
  }
}

async function runValidatorsForField(fieldId: string): Promise<void> {
  const groupId = groupForField(fieldId);
  if (groupId) {
    [...validatorErrors.keys()]
      .filter((path) => path.startsWith(`${groupId}[`) && path.endsWith(`.${fieldId}`))
      .forEach((path) => validatorErrors.delete(path));
    const rows = asRows(values[groupId]);
    for (let index = 0; index < rows.length; index += 1) {
      await runValidatorHandlers(`${groupId}[${index}].${fieldId}`, rows[index][fieldId], fieldId);
    }
  } else {
    await runValidatorHandlers(fieldId, values[fieldId], fieldId);
  }
  postErrors();
}

async function runAllValidators(): Promise<Record<string, string>> {
  for (const fieldId of validators.keys()) await runValidatorsForField(fieldId);
  postErrors();
  return allErrors();
}

async function dispatchChangeHandler(
  registration: ChangeHandlerRegistration,
  change: ChangePayload,
): Promise<void> {
  if (registration.timer) {
    clearTimeout(registration.timer);
    registration.timer = undefined;
  }
  if (registration.cancelPrevious) {
    registration.controller?.abort();
    registration.controller = undefined;
  }

  const invoke = async () => {
    const controller = new AbortController();
    if (registration.cancelPrevious) registration.controller = controller;
    const previousEvent = activeEvent;
    const previousComponent = activeComponentId;
    activeEvent = `${change.id}.onChange`;
    activeComponentId = change.id;
    try {
      await safeHandler(
        registration.handler,
        { ...change, signal: controller.signal },
        `${change.id}.onChange`,
      );
    } finally {
      if (registration.controller === controller) registration.controller = undefined;
      activeEvent = previousEvent;
      activeComponentId = previousComponent;
    }
  };

  if (registration.debounce > 0) {
    registration.timer = setTimeout(() => {
      registration.timer = undefined;
      void invoke();
    }, registration.debounce);
    return;
  }
  await invoke();
}

async function drainChanges(): Promise<void> {
  const repeated = new Map<string, number>();
  let processed = 0;
  while (pendingChanges.length > 0) {
    const change = pendingChanges.shift() as ChangePayload;
    processed += 1;
    if (processed > 100) {
      log('error', 'Event-Loop-Schutz: Mehr als 100 Feldänderungen in einer Transaktion.');
      pendingChanges.length = 0;
      break;
    }
    const signature = `${change.id}:${printable(change.value)}`;
    const count = (repeated.get(signature) || 0) + 1;
    repeated.set(signature, count);
    if (count > 2) {
      log('error', `Event-Loop-Schutz: Wiederholte identische Änderung für "${change.id}".`);
      continue;
    }

    const previousEvent = activeEvent;
    const previousComponent = activeComponentId;
    activeEvent = `${change.id}.onChange`;
    activeComponentId = change.id;
    log('debug', `${change.id} geändert (${change.source}).`);
    for (const registration of changeHandlers.get(change.id) || []) {
      await dispatchChangeHandler(registration, change);
    }
    await recomputeDependents(change.id);
    await runValidatorsForField(change.id);
    activeEvent = previousEvent;
    activeComponentId = previousComponent;
  }
}

function ensureChangePump(): Promise<void> {
  if (changePumpSuspended > 0) return Promise.resolve();
  if (!changePump) {
    changePump = drainChanges()
      .catch((error) => log('error', 'Transaktion fehlgeschlagen.', error))
      .finally(() => {
        changePump = undefined;
        if (pendingChanges.length > 0) void ensureChangePump();
      });
  }
  return changePump;
}

function enqueueChange(change: ChangePayload): void {
  pendingChanges.push(change);
  if (changePumpSuspended === 0) void ensureChangePump();
}

function enqueueChanges(changes: ChangePayload[]): void {
  if (changes.length === 0) return;
  pendingChanges.push(...changes);
  if (changePumpSuspended === 0) void ensureChangePump();
}

async function waitForIdle(): Promise<void> {
  while (changePump || pendingChanges.length > 0) {
    await (changePump || ensureChangePump());
  }
}

function setFieldValue(
  id: string,
  value: unknown,
  options: { emitChange?: boolean } = {},
  source: ChangeSource = 'script',
  persist = true,
): void {
  assertKnown('fields', id);
  const previousValue = values[id];
  if (equal(previousValue, value)) return;
  values[id] = value;
  post('form:set-value', { id, value, persist });
  if (options.emitChange !== false) {
    enqueueChange({ id, value, previousValue, source, initialLoad: false });
  }
}

function setGroupItems(id: string, items: readonly Record<string, unknown>[]): void {
  assertKnown('repeatableGroups', id);
  values[id] = items.map((item) => ({ ...item }));
  post('form:set-value', { id, value: values[id], persist: true });
}

function updateValues(nextValues: Record<string, unknown>, source: ChangeSource = 'script'): void {
  const changes: ChangePayload[] = [];
  const changedValues: Record<string, unknown> = {};
  Object.entries(nextValues).forEach(([id, value]) => {
    const isField = knownIds.fields.includes(id);
    const isGroup = knownIds.repeatableGroups.includes(id);
    if (!isField && !isGroup) throw new Error(`Unbekannte Formularwert-ID "${id}".`);
    const previousValue = values[id];
    if (equal(previousValue, value)) return;
    values[id] = value;
    changedValues[id] = value;
    if (isField) changes.push({ id, value, previousValue, source, initialLoad: false });
  });
  if (Object.keys(changedValues).length === 0) return;
  post('form:update-values', { values: changedValues, persist: true });
  enqueueChanges(changes);
}

function uiComponent(kind: 'fields' | 'groups' | 'sections' | 'tabs' | 'buttons', id: string) {
  assertKnown(kind, id);
  const patch = (state: Record<string, unknown>) => {
    if (kind === 'fields' && typeof state.required === 'boolean') uiRequiredFields.set(id, state.required);
    post('ui:set-state', { kind, id, state });
  };
  return {
    show: () => patch({ visible: true }),
    hide: () => patch({ visible: false }),
    enable: () => patch({ enabled: true }),
    disable: () => patch({ enabled: false }),
    setVisible: (visible: boolean) => patch({ visible }),
    setEnabled: (enabled: boolean) => patch({ enabled }),
    setReadonly: (readonly: boolean) => patch({ readonly }),
    setRequired: (required: boolean) => patch({ required }),
    setState: (state: Record<string, unknown>) => patch(state),
  };
}

function registerUiHandler(id: string, event: 'focus' | 'blur', handler: Handler): void {
  const key = `${id}:${event}`;
  uiHandlers.set(key, [...(uiHandlers.get(key) || []), handler]);
}

function lifecycleRegistrar(name: LifecycleName) {
  return (handler: LifecycleHandler) => {
    lifecycleHandlers.set(name, [...(lifecycleHandlers.get(name) || []), handler]);
  };
}

function isEmpty(value: unknown): boolean {
  return value === undefined
    || value === null
    || value === ''
    || (Array.isArray(value) && value.length === 0);
}

function callApi(
  operation: string,
  input: unknown,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<unknown> {
  if (typeof operation !== 'string' || !operation.trim()) {
    return Promise.reject(new Error('API operation must be a non-empty string.'));
  }
  const requestId = `script-api-${Date.now()}-${++apiSequence}`;
  const loadingButtonId = activeComponentId && knownIds.buttons.includes(activeComponentId)
    ? activeComponentId
    : undefined;
  if (loadingButtonId) {
    const pendingCount = (apiButtonPending.get(loadingButtonId) || 0) + 1;
    apiButtonPending.set(loadingButtonId, pendingCount);
    post('ui:set-state', { kind: 'buttons', id: loadingButtonId, state: { loading: true } });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let cleaned = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      pendingApiRequests.delete(requestId);
      post('api:cancel', { requestId });
      const error = new DOMException(`API-Aufruf ${operation} wurde abgebrochen.`, 'AbortError');
      log('debug', `API ${operation} abgebrochen.`);
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      options.signal?.removeEventListener('abort', abort);
      if (loadingButtonId) {
        const pendingCount = Math.max((apiButtonPending.get(loadingButtonId) || 1) - 1, 0);
        if (pendingCount === 0) {
          apiButtonPending.delete(loadingButtonId);
          post('ui:set-state', { kind: 'buttons', id: loadingButtonId, state: { loading: false } });
        } else {
          apiButtonPending.set(loadingButtonId, pendingCount);
        }
      }
    };
    if (options.signal?.aborted) {
      abort();
      cleanup();
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    pendingApiRequests.set(requestId, {
      operation,
      startedAt: performance.now(),
      event: activeEvent,
      componentId: activeComponentId,
      resolve: (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
      cleanup,
    });
    log('info', `API ${operation} gestartet.`);
    try {
      post('api:call', {
        requestId,
        operation,
        input,
        ...(typeof options.timeoutMs === 'number' ? { timeoutMs: options.timeoutMs } : {}),
      });
    } catch (error) {
      pendingApiRequests.delete(requestId);
      cleanup();
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function completeApiRequest(message: Extract<HostMessage, { type: 'api:response' }>): void {
  const pending = pendingApiRequests.get(message.requestId);
  if (!pending) return;
  pendingApiRequests.delete(message.requestId);
  const previousEvent = activeEvent;
  const previousComponent = activeComponentId;
  activeEvent = pending.event;
  activeComponentId = pending.componentId;
  const durationMs = message.durationMs
    ?? Math.round((performance.now() - pending.startedAt) * 100) / 100;
  try {
    if (message.error) {
      const error = new Error(message.error);
      error.name = message.code || 'ScriptConnectorError';
      log('error', `API ${pending.operation} fehlgeschlagen.`, error, durationMs);
      pending.reject(error);
      return;
    }
    log('info', `API ${pending.operation} abgeschlossen.`, undefined, durationMs);
    pending.resolve(message.result);
  } finally {
    pending.cleanup();
    activeEvent = previousEvent;
    activeComponentId = previousComponent;
  }
}

function createSdk(functions: Record<string, any> = buildGlobalFunctionsObject()) {
  const form = {
    get values() {
      return { ...values };
    },
    get errors() {
      return allErrors();
    },
    field(id: string) {
      assertKnown('fields', id);
      return {
        get value() {
          return values[id];
        },
        setValue: (value: unknown, options?: { emitChange?: boolean }) => setFieldValue(id, value, options),
        clear: (options?: { emitChange?: boolean }) => setFieldValue(id, null, options),
        onChange: (
          handler: Handler<ChangePayload & { signal: AbortSignal }>,
          options: { debounce?: number; cancelPrevious?: boolean } = {},
        ) => {
          const debounce = options.debounce === undefined ? 0 : Number(options.debounce);
          if (!Number.isFinite(debounce) || debounce < 0 || debounce > 10_000) {
            throw new Error(`onChange debounce für "${id}" muss zwischen 0 und 10000 ms liegen.`);
          }
          changeHandlers.set(id, [
            ...(changeHandlers.get(id) || []),
            {
              handler,
              debounce: Math.round(debounce),
              cancelPrevious: options.cancelPrevious === true,
            },
          ]);
        },
        validate: (handler: Validator) => {
          validators.set(id, [...(validators.get(id) || []), handler]);
        },
      };
    },
    group(id: string) {
      assertKnown('repeatableGroups', id);
      return {
        get items() {
          return asRows(values[id]).map((item) => ({ ...item }));
        },
        addItem(initial: Record<string, unknown> = {}) {
          const rows = asRows(values[id]);
          const index = rows.length;
          const item = { ...initial };
          setGroupItems(id, [...rows, item]);
          for (const handler of groupAddHandlers.get(id) || []) {
            void safeHandler(handler, { index, item }, `${id}.onAddItem`);
          }
          return index;
        },
        removeItem(index: number) {
          const rows = asRows(values[id]);
          if (!Number.isInteger(index) || index < 0 || index >= rows.length) {
            throw new Error(`Ungültiger Index ${index} für Gruppe "${id}".`);
          }
          const item = rows[index];
          setGroupItems(id, rows.filter((_, itemIndex) => itemIndex !== index));
          for (const handler of groupRemoveHandlers.get(id) || []) {
            void safeHandler(handler, { index, item }, `${id}.onRemoveItem`);
          }
        },
        replaceItems(items: readonly Record<string, unknown>[]) {
          if (!Array.isArray(items)) throw new Error(`replaceItems für "${id}" erwartet ein Array.`);
          setGroupItems(id, items);
        },
        onAddItem(handler: Handler<{ index: number; item: Record<string, unknown> }>) {
          groupAddHandlers.set(id, [...(groupAddHandlers.get(id) || []), handler]);
        },
        onRemoveItem(handler: Handler<{ index: number; item: Record<string, unknown> }>) {
          groupRemoveHandlers.set(id, [...(groupRemoveHandlers.get(id) || []), handler]);
        },
        onItemChange(handler: Handler<GroupChangePayload>) {
          groupChangeHandlers.set(id, [...(groupChangeHandlers.get(id) || []), handler]);
        },
      };
    },
    updateValues: (nextValues: Record<string, unknown>) => updateValues(nextValues),
    computed: (id: string, config: Record<string, unknown>) => registerComputed(id, config),
    setErrors: (errors: Record<string, unknown>) => setManualErrors(errors),
    isValid: () => {
      const allRequired = new Set(requiredFields);
      uiRequiredFields.forEach((required, id) => {
        if (required) allRequired.add(id);
        else allRequired.delete(id);
      });
      const requiredValid = [...allRequired].every((id) => {
        const groupId = groupForField(id);
        return groupId
          ? asRows(values[groupId]).every((row) => !isEmpty(row[id]))
          : !isEmpty(values[id]);
      });
      return requiredValid && Object.keys(allErrors()).length === 0;
    },
  };

  const ui = {
    field(id: string) {
      const base = uiComponent('fields', id);
      return {
        ...base,
        setLabel: (label: string) => post('ui:set-state', { kind: 'fields', id, state: { label } }),
        setPlaceholder: (placeholder: string) => post('ui:set-state', { kind: 'fields', id, state: { placeholder } }),
        setHelpText: (helpText: string) => post('ui:set-state', { kind: 'fields', id, state: { helpText } }),
        setOptions: (options: readonly { value: string; label: string }[]) => {
          if (!Array.isArray(options) || options.some((option) => (
            !option || typeof option.value !== 'string' || typeof option.label !== 'string'
          ))) {
            throw new Error(`setOptions für "${id}" erwartet { value, label }-Einträge.`);
          }
          post('ui:set-state', { kind: 'fields', id, state: { options: options.map((option) => ({ ...option })) } });
        },
        onFocus: (handler: Handler) => registerUiHandler(id, 'focus', handler),
        onBlur: (handler: Handler) => registerUiHandler(id, 'blur', handler),
      };
    },
    group: (id: string) => uiComponent('groups', id),
    section: (id: string) => uiComponent('sections', id),
    tab: (id: string) => uiComponent('tabs', id),
    button(id: string) {
      const base = uiComponent('buttons', id);
      return {
        ...base,
        onClick: (handler: Handler) => {
          uiHandlers.set(`${id}:click`, [...(uiHandlers.get(`${id}:click`) || []), handler]);
        },
        setLoading: (loading: boolean) => post('ui:set-state', { kind: 'buttons', id, state: { loading } }),
      };
    },
    toast: {
      success: (message: string) => post('ui:toast', { level: 'success', message }),
      error: (message: string) => post('ui:toast', { level: 'error', message }),
      info: (message: string) => post('ui:toast', { level: 'info', message }),
      warning: (message: string) => post('ui:toast', { level: 'warning', message }),
    },
  };

  const events = {
    beforeLoad: lifecycleRegistrar('beforeLoad'),
    afterLoad: lifecycleRegistrar('afterLoad'),
    beforeSave: lifecycleRegistrar('beforeSave'),
    afterSave: lifecycleRegistrar('afterSave'),
    beforeSubmit: lifecycleRegistrar('beforeSubmit'),
    afterSubmit: lifecycleRegistrar('afterSubmit'),
    onInit: lifecycleRegistrar('onInit'),
    onReset: lifecycleRegistrar('onReset'),
    onValidation: lifecycleRegistrar('onValidation'),
    onDestroy: lifecycleRegistrar('onDestroy'),
  };

  return {
    form,
    ui,
    events,
    context,
    functions,
    state: {
      get: (key: string) => stateValues.get(key),
      set: (key: string, value: unknown) => stateValues.set(key, value),
      delete: (key: string) => stateValues.delete(key),
    },
    logger: {
      debug: (message: string, details?: unknown) => log('debug', message, details),
      info: (message: string, details?: unknown) => log('info', message, details),
      warn: (message: string, details?: unknown) => log('warn', message, details),
      error: (message: unknown, error?: unknown) => log('error', message, error),
    },
    api: {
      call: (
        operation: string,
        input: unknown,
        options?: { signal?: AbortSignal; timeoutMs?: number },
      ) => callApi(operation, input, options),
      request: (
        request: { connector: string; operation: string; input: unknown },
        options?: { signal?: AbortSignal; timeoutMs?: number },
      ) => {
        if (!request || typeof request.connector !== 'string' || typeof request.operation !== 'string') {
          return Promise.reject(new Error('api.request requires connector and operation.'));
        }
        return callApi(`${request.connector}.${request.operation}`, request.input, options);
      },
    },
  };
}

function setNestedFunction(target: Record<string, any>, packageName: string, name: string, fn: unknown): void {
  if (typeof fn !== 'function') throw new Error(`Custom function ${packageName}.${name} does not export a function.`);
  if (!target[packageName]) target[packageName] = {};
  target[packageName][name] = fn;
}

async function loadRuntimeFunctions(definitions: InitMessage['runtimeFunctions']): Promise<Record<string, any>> {
  const functions = buildGlobalFunctionsObject();
  for (const definition of definitions) {
    const moduleUrl = URL.createObjectURL(new Blob([definition.source], { type: 'text/javascript' }));
    try {
      const module = await import(/* @vite-ignore */ moduleUrl);
      setNestedFunction(functions, definition.packageName, definition.name, module[definition.name]);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  }
  return functions;
}

async function runLifecycle(name: LifecycleName): Promise<{ cancelled: boolean; message?: string }> {
  const previousEvent = activeEvent;
  activeEvent = name;
  const started = performance.now();
  let cancelled = false;
  let message: string | undefined;
  const lifecycleEvent = {
    cancel(reason?: string) {
      cancelled = true;
      message = reason;
    },
  };
  log('debug', name);
  for (const handler of lifecycleHandlers.get(name) || []) {
    await safeHandler(handler, lifecycleEvent, name);
    if (cancelled) break;
  }
  await waitForIdle();
  log('debug', `${name} abgeschlossen.`, undefined, Math.round((performance.now() - started) * 100) / 100);
  activeEvent = previousEvent;
  return { cancelled, ...(message ? { message } : {}) };
}

async function loadScript(message: InitMessage): Promise<void> {
  values = { ...message.values };
  context = { ...message.context };
  knownIds = {
    ...EMPTY_IDS,
    ...message.ids,
    repeatableGroups: message.ids.repeatableGroups || [],
    groupFields: message.ids.groupFields || {},
  };
  requiredFields = new Set(message.requiredFields);
  const prelude = `
const defineFormScript = (setup) => setup;
for (const key of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "eval", "Function", "localStorage", "sessionStorage", "indexedDB", "caches"]) {
  try { Object.defineProperty(globalThis, key, { value: undefined, configurable: false, writable: false }); } catch {}
}
`;
  const functions = await loadRuntimeFunctions(message.runtimeFunctions || []);
  const moduleUrl = URL.createObjectURL(new Blob([prelude, '\n', message.compiled], { type: 'text/javascript' }));
  try {
    const loaded = await import(/* @vite-ignore */ moduleUrl);
    if (typeof loaded.default !== 'function') {
      throw new Error('Das Form Script muss defineFormScript(...) als Default Export bereitstellen.');
    }
    await loaded.default(createSdk(functions));
    assertNoComputedCycle();
    await runAllComputed();
    await waitForIdle();
    await runAllValidators();
    await runLifecycle('onInit');
    post('ready');
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

async function dispatchUiEvent(id: string, event: 'focus' | 'blur' | 'click'): Promise<void> {
  const previousEvent = activeEvent;
  const previousComponent = activeComponentId;
  activeEvent = `${id}.${event}`;
  activeComponentId = id;
  for (const handler of uiHandlers.get(`${id}:${event}`) || []) {
    await safeHandler(handler, undefined, `${id}.${event}`);
  }
  await waitForIdle();
  activeEvent = previousEvent;
  activeComponentId = previousComponent;
}

async function dispatchGroupChange(change: GroupChangePayload): Promise<void> {
  assertKnown('repeatableGroups', change.groupId);
  const rows = asRows(values[change.groupId]);
  const row = rows[change.index];
  if (!row) throw new Error(`Ungültiger Index ${change.index} für Gruppe "${change.groupId}".`);
  rows[change.index] = { ...row, [change.fieldId]: change.value };
  values[change.groupId] = rows;
  const previousEvent = activeEvent;
  const previousComponent = activeComponentId;
  activeEvent = `${change.groupId}.onItemChange`;
  activeComponentId = change.fieldId;
  for (const handler of groupChangeHandlers.get(change.groupId) || []) {
    await safeHandler(handler, { ...change, field: change.fieldId }, `${change.groupId}.onItemChange`);
  }
  await runValidatorsForField(change.fieldId);
  await waitForIdle();
  activeEvent = previousEvent;
  activeComponentId = previousComponent;
}

async function dispatchGroupAdd(
  groupId: string,
  index: number,
  item: Record<string, unknown>,
): Promise<void> {
  assertKnown('repeatableGroups', groupId);
  const rows = asRows(values[groupId]);
  rows.splice(Math.min(Math.max(index, 0), rows.length), 0, { ...item });
  values[groupId] = rows;
  const previousEvent = activeEvent;
  const previousComponent = activeComponentId;
  activeEvent = `${groupId}.onAddItem`;
  activeComponentId = groupId;
  for (const handler of groupAddHandlers.get(groupId) || []) {
    await safeHandler(handler, { index, item }, `${groupId}.onAddItem`);
  }
  for (const fieldId of knownIds.groupFields[groupId] || []) await runValidatorsForField(fieldId);
  await waitForIdle();
  activeEvent = previousEvent;
  activeComponentId = previousComponent;
}

async function dispatchGroupRemove(
  groupId: string,
  index: number,
  fallbackItem: Record<string, unknown>,
): Promise<void> {
  assertKnown('repeatableGroups', groupId);
  const rows = asRows(values[groupId]);
  const [removedItem] = rows.splice(index, 1);
  values[groupId] = rows;
  const item = removedItem || fallbackItem;
  const previousEvent = activeEvent;
  const previousComponent = activeComponentId;
  activeEvent = `${groupId}.onRemoveItem`;
  activeComponentId = groupId;
  for (const handler of groupRemoveHandlers.get(groupId) || []) {
    await safeHandler(handler, { index, item }, `${groupId}.onRemoveItem`);
  }
  for (const fieldId of knownIds.groupFields[groupId] || []) await runValidatorsForField(fieldId);
  await waitForIdle();
  activeEvent = previousEvent;
  activeComponentId = previousComponent;
}

function cancelRuntimeTasks(): void {
  changeHandlers.forEach((registrations) => registrations.forEach((registration) => {
    if (registration.timer) clearTimeout(registration.timer);
    registration.controller?.abort();
  }));
  pendingApiRequests.forEach((pending, requestId) => {
    post('api:cancel', { requestId });
    pending.reject(new DOMException('Form Script Runtime wurde beendet.', 'AbortError'));
    pending.cleanup();
  });
  pendingApiRequests.clear();
}

workerScope.onmessage = (event) => {
  const message = event.data;
  void (async () => {
    try {
      if (message.type === 'init') {
        await loadScript(message);
        return;
      }
      if (message.type === 'api:response') {
        completeApiRequest(message);
        return;
      }
      if (message.type === 'change') {
        values[message.change.id] = message.change.value;
        enqueueChange(message.change);
        return;
      }
      if (message.type === 'group-change') {
        await dispatchGroupChange(message.change);
        return;
      }
      if (message.type === 'group-add') {
        await dispatchGroupAdd(message.groupId, message.index, message.item);
        return;
      }
      if (message.type === 'group-remove') {
        await dispatchGroupRemove(message.groupId, message.index, message.item);
        return;
      }
      if (message.type === 'values') {
        const changes: ChangePayload[] = [];
        Object.entries(message.values).forEach(([id, value]) => {
          const previousValue = values[id];
          values[id] = value;
          if (message.emitChanges && knownIds.fields.includes(id) && !equal(previousValue, value)) {
            changes.push({ id, value, previousValue, source: message.source, initialLoad: message.source === 'load' });
          }
        });
        enqueueChanges(changes);
        return;
      }
      if (message.type === 'lifecycle') {
        values = { ...message.values };
        await waitForIdle();
        post('response', { requestId: message.requestId, result: await runLifecycle(message.name) });
        return;
      }
      if (message.type === 'validate') {
        values = { ...message.values };
        await waitForIdle();
        post('response', { requestId: message.requestId, result: { errors: await runAllValidators() } });
        return;
      }
      if (message.type === 'ui-event') {
        await dispatchUiEvent(message.id, message.event);
        return;
      }
      if (message.type === 'button') {
        await dispatchUiEvent(message.id, 'click');
        return;
      }
      if (message.type === 'destroy') {
        const result = await runLifecycle('onDestroy');
        cancelRuntimeTasks();
        post('response', { requestId: message.requestId, result });
      }
    } catch (error) {
      log('error', 'Form Script Runtime-Fehler', error);
      if ('requestId' in message) {
        post('response', {
          requestId: message.requestId,
          result: { cancelled: true, message: printable(error) || 'Form Script Runtime-Fehler' },
        });
      } else if (message.type === 'init') {
        post('init-error', { message: printable(error) || 'Form Script konnte nicht initialisiert werden.' });
      }
    }
  })();
};
