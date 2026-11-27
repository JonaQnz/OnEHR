import type {
  FormScriptChangeSource,
  FormScriptEventName,
  FormScriptLogEntry,
  FormScriptSchemaIds,
  RuntimeValues,
} from 'core';
import { appendScriptLog } from './scriptLogStore';
import { API_BASE_URL } from '../../integration/apiBaseUrl';
import {
  isFormWorkerMessage,
  type FormHostToWorkerMessage,
  type FormScriptFieldMessage,
  type FormScriptFieldProvenance,
  type FormScriptLifecycleResult,
  type FormScriptPrefillConflict,
  type FormScriptUiState,
  type FormWorkerToHostMessage,
} from './formScriptProtocol';

// Re-exported here so existing imports from FormScriptClient keep working.
export type {
  FormScriptFieldMessage,
  FormScriptFieldProvenance,
  FormScriptLifecycleResult,
  FormScriptPrefillConflict,
  FormScriptUiState,
} from './formScriptProtocol';

interface FormScriptClientOptions {
  formId: string;
  compiled: string;
  values: RuntimeValues;
  ids: FormScriptSchemaIds;
  groupFields: Record<string, string[]>;
  requiredFields: string[];
  context: Record<string, unknown>;
  runtimeFunctions?: Array<{ packageName: string; name: string; source: string }>;
  onSetValue(id: string, value: unknown, persist: boolean, provenance: FormScriptFieldProvenance | null): void;
  onUpdateValues(values: RuntimeValues, persist: boolean): void;
  onValidationErrors(errors: Record<string, FormScriptFieldMessage>): void;
  onUiState(kind: string, id: string, state: FormScriptUiState): void;
  onToast(level: string, message: string): void;
  onPrefillConflict(conflict: FormScriptPrefillConflict): void;
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
    this.post({
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

  private post(message: FormHostToWorkerMessage): void {
    this.worker.postMessage(message);
  }

  private handleMessage(message: unknown): void {
    if (this.terminated) return;
    if (!isFormWorkerMessage(message)) return;
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
      appendScriptLog(this.options.formId, message.entry);
      this.options.onLog?.(message.entry);
      return;
    }
    if (message.type === 'form:set-value') {
      this.options.onSetValue(message.id, message.value, message.persist !== false, message.provenance ?? null);
      return;
    }
    if (message.type === 'prefill:conflict') {
      this.options.onPrefillConflict({
        requestId: message.requestId,
        fieldId: message.fieldId,
        currentValue: message.currentValue,
        prefillValue: message.prefillValue,
        source: message.source,
        ...(typeof message.timestamp === 'string' ? { timestamp: message.timestamp } : {}),
      });
      return;
    }
    if (message.type === 'form:update-values') {
      this.options.onUpdateValues(message.values, message.persist !== false);
      return;
    }
    if (message.type === 'validation:errors') {
      this.options.onValidationErrors(message.errors);
      return;
    }
    if (message.type === 'api:call') {
      void this.handleApiCall(message);
      return;
    }
    if (message.type === 'api:cancel') {
      const requestId = message.requestId;
      this.apiControllers.get(requestId)?.abort();
      this.apiControllers.delete(requestId);
      return;
    }
    if (message.type === 'ui:set-state') {
      this.options.onUiState(message.kind, message.id, message.state);
      return;
    }
    if (message.type === 'ui:toast') {
      this.options.onToast(message.level, message.message);
      return;
    }
    if (message.type === 'response') {
      const requestId = message.requestId;
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

  private async handleApiCall(message: Extract<FormWorkerToHostMessage, { type: 'api:call' }>): Promise<void> {
    if (this.terminated) return;
    const requestId = message.requestId;
    const operation = String(message.operation || '');
    const controller = new AbortController();
    this.apiControllers.set(requestId, controller);
    const startedAt = performance.now();
    try {
      const response = await fetch(
        `${API_BASE_URL}/script-connectors/forms/${encodeURIComponent(this.options.formId)}/call`,
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
      this.post(response.ok
        ? {
          type: 'api:response',
          requestId,
          result: body.result,
          durationMs: body.durationMs as number | undefined,
        }
        : {
          type: 'api:response',
          requestId,
          error: String(body.error || `Connector request failed (${response.status}).`),
          code: String(body.code || 'SCRIPT_CONNECTOR_FAILED'),
          durationMs: body.durationMs as number | undefined,
        });
    } catch (error) {
      if (controller.signal.aborted || this.terminated) return;
      this.post({
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
    this.post({
      type: 'change',
      change: { id, value, previousValue, source, initialLoad },
    });
  }

  /** Answers a pending FormScriptPrefillConflict raised via onPrefillConflict -
   * `apply: true` overwrites the field with the prefill value, `false`
   * keeps the clinician's own entry. The worker's field(id).prefill(...)
   * call is awaiting exactly this response. */
  resolvePrefillConflict(requestId: string, apply: boolean): void {
    if (this.terminated) return;
    this.post({ type: 'prefill:resolve', requestId, apply });
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
    this.post({
      type: 'group-change',
      change: { groupId, index, fieldId, value, previousValue, source },
    });
  }

  addGroupItem(groupId: string, index: number, item: Record<string, unknown>): void {
    if (!this.terminated) this.post({ type: 'group-add', groupId, index, item });
  }

  removeGroupItem(groupId: string, index: number, item: Record<string, unknown>): void {
    if (!this.terminated) this.post({ type: 'group-remove', groupId, index, item });
  }

  syncValues(values: RuntimeValues, source: FormScriptChangeSource, emitChanges: boolean): void {
    if (this.terminated) return;
    this.post({ type: 'values', values, source, emitChanges });
  }

  uiEvent(id: string, event: 'focus' | 'blur'): void {
    if (!this.terminated) this.post({ type: 'ui-event', id, event });
  }

  clickButton(id: string): void {
    if (!this.terminated) this.post({ type: 'button', id });
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
      this.post({ type: 'lifecycle', name, requestId, values });
    });
  }

  async validate(values: RuntimeValues): Promise<Record<string, FormScriptFieldMessage>> {
    if (this.terminated) return {};
    await this.ready();
    const requestId = `script-request-${++this.requestSequence}`;
    return new Promise<Record<string, FormScriptFieldMessage>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error('Die Script-Validierung hat das Zeitlimit von 5 Sekunden überschritten.');
        this.addHostLog('error', error.message);
        resolve({ __script: { message: error.message, severity: 'error', source: 'script' } });
      }, 5_000);
      this.pending.set(requestId, {
        resolve: (result) => {
          const response = result as { errors?: Record<string, FormScriptFieldMessage> };
          resolve(response.errors || {});
        },
        reject,
        timer,
      });
      this.post({ type: 'validate', requestId, values });
    });
  }

  async destroy(values: RuntimeValues): Promise<void> {
    if (this.terminated) return;
    try {
      await this.runLifecycle('onDestroy', values);
    } finally {
      this.terminated = true;
      this.abortApiRequests();
      // Any request still pending here (most commonly the initial
      // ready()/beforeLoad/afterLoad chain, cut short by a fast unmount -
      // React StrictMode's dev-mode mount/cleanup/mount replay is the most
      // common trigger) is being cut off by intentional teardown, not a
      // script failure. Reject with an AbortError, matching the same
      // convention formScript.worker.ts already uses for its own
      // teardown-cancelled requests, so callers can tell "we tore this down
      // on purpose" apart from "the script actually errored" and skip
      // surfacing a toast for the former.
      this.pending.forEach((request) => {
        clearTimeout(request.timer);
        request.reject(new DOMException('Form Script Runtime wurde beendet.', 'AbortError'));
      });
      this.pending.clear();
      this.worker.terminate();
    }
  }
}
