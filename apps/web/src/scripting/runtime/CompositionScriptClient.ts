export interface CompositionScriptStatus { currentPage: string; completedBlocks: string[]; pendingBlocks: string[]; state: 'draft' | 'in_progress' | 'completed' | 'submitted'; }
export interface CompositionScriptClientOptions {
  compiled: string; pageIds: string[]; blockIds: string[]; dataBlockIds: string[]; status: CompositionScriptStatus;
  onPageVisibility(id: string, visible: boolean): void; onBlockVisibility(id: string, visible: boolean): void; onRefreshData(id?: string): void; onDataLoading(id: string, loading: boolean): void; onNavigate(id: string): void; onNext(): void; onPrevious(): void; onError(message: string): void;
}
export class CompositionScriptClient {
  private readonly worker = new Worker(new URL('./compositionScript.worker.ts', import.meta.url), { type: 'module' });
  constructor(private readonly options: CompositionScriptClientOptions) {
    this.worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => this.message(event.data);
    this.worker.onerror = (event) => this.options.onError(event.message || 'Composition Script Worker fehlgeschlagen.');
    this.worker.postMessage({ type: 'init', compiled: options.compiled, pageIds: options.pageIds, blockIds: options.blockIds, dataBlockIds: options.dataBlockIds, status: options.status });
  }
  private message(message: Record<string, unknown>) { const id = typeof message.id === 'string' ? message.id : ''; if (message.type === 'page:visibility') this.options.onPageVisibility(id, message.visible === true); else if (message.type === 'block:visibility') this.options.onBlockVisibility(id, message.visible === true); else if (message.type === 'data:refresh') this.options.onRefreshData(id || undefined); else if (message.type === 'data:loading') this.options.onDataLoading(id, message.loading === true); else if (message.type === 'navigation:go-to') this.options.onNavigate(id); else if (message.type === 'navigation:next') this.options.onNext(); else if (message.type === 'navigation:previous') this.options.onPrevious(); else if (message.type === 'error') this.options.onError(String(message.message || 'Composition Script fehlgeschlagen.')); }
  updateStatus(status: CompositionScriptStatus) { this.worker.postMessage({ type: 'status', status }); }
  destroy() { this.worker.postMessage({ type: 'destroy' }); this.worker.terminate(); }
}
