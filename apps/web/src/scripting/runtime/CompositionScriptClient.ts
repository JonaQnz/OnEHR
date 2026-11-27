import { dispatchCompositionWorkerMessage, type CompositionHostOperations, type CompositionScriptStatus } from './compositionScriptProtocol';

export type { CompositionScriptStatus } from './compositionScriptProtocol';

export interface CompositionScriptClientOptions extends CompositionHostOperations {
  compiled: string; pageIds: string[]; blockIds: string[]; dataBlockIds: string[]; status: CompositionScriptStatus;
}
export class CompositionScriptClient {
  private readonly worker = new Worker(new URL('./compositionScript.worker.ts', import.meta.url), { type: 'module' });
  private destroyed = false;
  constructor(private readonly options: CompositionScriptClientOptions) {
    this.worker.onmessage = (event: MessageEvent<unknown>) => { if (!this.destroyed) dispatchCompositionWorkerMessage(event.data, this.options); };
    this.worker.onerror = (event) => { if (!this.destroyed) this.options.onError(event.message || 'Composition Script Worker fehlgeschlagen.'); };
    this.worker.postMessage({ type: 'init', compiled: options.compiled, pageIds: options.pageIds, blockIds: options.blockIds, dataBlockIds: options.dataBlockIds, status: options.status });
  }
  updateStatus(status: CompositionScriptStatus) { if (this.destroyed) return; this.worker.postMessage({ type: 'status', status }); }
  /** Delivers a doctor's click on a data card row/point to the script's
   * `data.onPick(blockId, handler)` registration for that block, if any. */
  pickData(blockId: string, row: Record<string, unknown>) { if (this.destroyed) return; this.worker.postMessage({ type: 'data:pick', id: blockId, row }); }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.worker.postMessage({ type: 'destroy' }); this.worker.terminate(); }
}
