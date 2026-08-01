import type {
  FormScriptChangeSource,
  FormScriptEventName,
  FormScriptLogEntry,
  FormScriptSchemaIds,
  RuntimeValues,
} from 'core';
import { appendScriptLog } from './scriptLogStore';

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

export interface FormScriptLifecycleResult {
  cancelled: boolean;
  message?: string;
}

interface FormScriptClientOptions {
  formId: string;
  compiled: string;
  values: RuntimeValues;
  ids: FormScriptSchemaIds;
  groupFields: Record<string, string[]>;
  requiredFields: string[];
  context: Record<string, unknown>;
  runtimeFunctions?: Array<{ packageName: string; name: string; source: string }>;
  onSetValue(id: string, value: unknown, persist: boolean): void;
  onUpdateValues(values: RuntimeValues, persist: boolean): void;
  onValidationErrors(errors: Record<string, string>): void;
  onUiState(kind: string, id: string, state: FormScriptUiState): void;
  onToast(level: string, message: string): void;
  onLog?(entry: FormScriptLogEntry): void;
}

interface PendingRequest {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class FormScriptClient {
  private readonly worker: Worker;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly apiControllers = new Map<string, AbortController>();
  private readonly readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private requestSequence = 0;
  private terminated = false;
  private readonly initializationTimer: ReturnType<typeof setTimeout>;

  constructor(private readonly options: FormScriptClientOptions) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.worker = new Worker(new URL('./formScript.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => this.handleMessage(event.data);
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'Form Script Worker ist fehlgeschlagen.');
      clearTimeout(this.initializationTimer);
      this.readyReject(error);
      this.addHostLog('error', error.message, error.stack);
      this.abortApiRequests();
    };
    this.worker.postMessage({
      type: 'init',
      compiled: options.compiled,
      values: options.values,
      ids: { ...options.ids, groupFields: options.groupFields },
      requiredFields: options.requiredFields,
      context: options.context,
      runtimeFunctions: options.runtimeFunctions || [],
    });
    this.initializationTimer = setTimeout(() => {
      if (this.terminated) return;
      this.terminated = true;
      this.abortApiRequests();
      this.worker.terminate();
      const error = new Error('Die Initialisierung des Form Scripts hat das Zeitlimit von 5 Sekunden überschritten.');
      this.readyReject(error);
      this.addHostLog('error', error.message);
    }, 5_000);
  }

  private addHostLog(level: FormScriptLogEntry['level'], message: string, error?: string): void {
    const entry: FormScriptLogEntry = {
      id: `host-log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(error ? { error } : {}),
    };
    appendScriptLog(this.options.formId, entry);
    this.options.onLog?.(entry);
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (message.type === 'ready') {
      clearTimeout(this.initializationTimer);
      this.readyResolve();
      return;
    }
    if (message.type === 'init-error') {
      clearTimeout(this.initializationTimer);
      this.readyReject(new Error(String(message.message || 'Form Script konnte nicht initialisiert werden.')));
      return;
    }
    if (message.type === 'log') {
      const entry = message.entry as unknown as FormScriptLogEntry;
      appendScriptLog(this.options.formId, entry);
      this.options.onLog?.(entry);
      return;
    }
    if (message.type === 'form:set-value') {
      this.options.onSetValue(String(message.id), message.value, message.persist !== false);
      return;
    }
    if (message.type === 'form:update-values') {
      this.options.onUpdateValues(message.values as RuntimeValues, message.persist !== false);
      return;
    }
    if (message.type === 'validation:errors') {
      this.options.onValidationErrors(message.errors as Record<string, string>);
      return;
    }
    if (message.type === 'api:call') {
      void this.handleApiCall(message);
      return;
    }
    if (message.type === 'api:cancel') {
      const requestId = String(message.requestId);
      this.apiControllers.get(requestId)?.abort();
      this.apiControllers.delete(requestId);
      return;
    }
    if (message.type === 'ui:set-state') {
      this.options.onUiState(String(message.kind), String(message.id), message.state as FormScriptUiState);
      return;
    }
    if (message.type === 'ui:toast') {
      this.options.onToast(String(message.level), String(message.message));
      return;
    }
    if (message.type === 'response') {
      const requestId = String(message.requestId);
      const request = this.pending.get(requestId);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(requestId);
      request.resolve(message.result);
    }
  }

  private abortApiRequests(): void {
    this.apiControllers.forEach((controller) => controller.abort());
    this.apiControllers.clear();
  }

  private async handleApiCall(message: Record<string, unknown>): Promise<void> {
    if (this.terminated) return;
    const requestId = String(message.requestId);
    const operation = String(message.operation || '');
    const controller = new AbortController();
    this.apiControllers.set(requestId, controller);
    const startedAt = performance.now();
    try {
      const response = await fetch(
        `http://localhost:3001/api/script-connectors/forms/${encodeURIComponent(this.options.formId)}/call`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            requestId,
            operation,
            input: message.input,
            context: this.options.context,
            ...(typeof message.timeoutMs === 'number' ? { timeoutMs: message.timeoutMs } : {}),
          }),
        },
      );
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (controller.signal.aborted || this.terminated) return;
      this.worker.postMessage(response.ok
        ? {
          type: 'api:response',
          requestId,
          result: body.result,
          durationMs: body.durationMs,
        }
        : {
          type: 'api:response',
          requestId,
          error: String(body.error || `Connector request failed (${response.status}).`),
          code: String(body.code || 'SCRIPT_CONNECTOR_FAILED'),
          durationMs: body.durationMs,
        });
    } catch (error) {
      if (controller.signal.aborted || this.terminated) return;
      this.worker.postMessage({
        type: 'api:response',
        requestId,
        error: error instanceof Error ? error.message : 'Connector request failed.',
        code: 'SCRIPT_CONNECTOR_NETWORK_ERROR',
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      });
    } finally {
      this.apiControllers.delete(requestId);
    }
  }

  async ready(): Promise<void> {
    return this.readyPromise;
  }

  dispatchChange(
    id: string,
    value: unknown,
    previousValue: unknown,
    source: FormScriptChangeSource,
    initialLoad = false,
  ): void {
    if (this.terminated) return;
    this.worker.postMessage({
      type: 'change',
      change: { id, value, previousValue, source, initialLoad },
    });
  }

  dispatchGroupChange(
    groupId: string,
    index: number,
    fieldId: string,
    value: unknown,
    previousValue: unknown,
    source: FormScriptChangeSource,
  ): void {
    if (this.terminated) return;
    this.worker.postMessage({
      type: 'group-change',
      change: { groupId, index, fieldId, value, previousValue, source },
    });
  }

  addGroupItem(groupId: string, index: number, item: Record<string, unknown>): void {
    if (!this.terminated) this.worker.postMessage({ type: 'group-add', groupId, index, item });
  }

  removeGroupItem(groupId: string, index: number, item: Record<string, unknown>): void {
    if (!this.terminated) this.worker.postMessage({ type: 'group-remove', groupId, index, item });
  }

  syncValues(values: RuntimeValues, source: FormScriptChangeSource, emitChanges: boolean): void {
    if (this.terminated) return;
    this.worker.postMessage({ type: 'values', values, source, emitChanges });
  }

  uiEvent(id: string, event: 'focus' | 'blur'): void {
    if (!this.terminated) this.worker.postMessage({ type: 'ui-event', id, event });
  }

  clickButton(id: string): void {
    if (!this.terminated) this.worker.postMessage({ type: 'button', id });
  }

  async runLifecycle(name: FormScriptEventName, values: RuntimeValues): Promise<FormScriptLifecycleResult> {
    if (this.terminated) return { cancelled: false };
    await this.ready();
    const requestId = `script-request-${++this.requestSequence}`;
    return new Promise<FormScriptLifecycleResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error(`${name} hat das Zeitlimit von 5 Sekunden überschritten.`);
        this.addHostLog('error', error.message);
        this.terminated = true;
        this.worker.terminate();
        resolve({ cancelled: true, message: error.message });
      }, 5_000);
      this.pending.set(requestId, {
        resolve: (result) => resolve(result as FormScriptLifecycleResult),
        reject,
        timer,
      });
      this.worker.postMessage({ type: 'lifecycle', name, requestId, values });
    });
  }

  async validate(values: RuntimeValues): Promise<Record<string, string>> {
    if (this.terminated) return {};
    await this.ready();
    const requestId = `script-request-${++this.requestSequence}`;
    return new Promise<Record<string, string>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error('Die Script-Validierung hat das Zeitlimit von 5 Sekunden überschritten.');
        this.addHostLog('error', error.message);
        resolve({ __script: error.message });
      }, 5_000);
      this.pending.set(requestId, {
        resolve: (result) => {
          const response = result as { errors?: Record<string, string> };
          resolve(response.errors || {});
        },
        reject,
        timer,
      });
      this.worker.postMessage({ type: 'validate', requestId, values });
    });
  }

  async destroy(values: RuntimeValues): Promise<void> {
    if (this.terminated) return;
    try {
      await this.runLifecycle('onDestroy', values);
    } finally {
      this.terminated = true;
      this.abortApiRequests();
      this.pending.forEach((request) => {
        clearTimeout(request.timer);
        request.reject(new Error('Form Script Runtime wurde beendet.'));
      });
      this.pending.clear();
      this.worker.terminate();
    }
  }
}
