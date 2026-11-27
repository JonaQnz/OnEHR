export interface CompositionScriptStatus { currentPage: string; completedBlocks: string[]; pendingBlocks: string[]; state: 'draft' | 'in_progress' | 'completed' | 'submitted'; }

/** Host callbacks the composition worker messages are dispatched to. */
export interface CompositionHostOperations {
  onPageVisibility(id: string, visible: boolean): void; onBlockVisibility(id: string, visible: boolean): void; onRefreshData(id?: string): void; onDataLoading(id: string, loading: boolean): void; onNavigate(id: string): void; onNext(): void; onPrevious(): void; onError(message: string): void;
  /** `forms.field(blockId, fieldName).setValue(value)` from within the
   * script - the host (CompositionRuntime) applies this to the matching
   * embedded form iframe. */
  onSetFormField(blockId: string, fieldName: string, value: unknown): void;
}

/** Messages `compositionScript.worker.ts` posts to the host. */
export type CompositionWorkerToHostMessage =
  | { type: 'page:visibility'; id: string; visible: boolean }
  | { type: 'block:visibility'; id: string; visible: boolean }
  | { type: 'data:refresh'; id?: string }
  | { type: 'data:loading'; id: string; loading: boolean }
  | { type: 'navigation:go-to'; id: string }
  | { type: 'navigation:next' }
  | { type: 'navigation:previous' }
  | { type: 'form:set-field'; blockId: string; fieldName: string; value: unknown }
  | { type: 'error'; message: string };

/** Messages the host posts to `compositionScript.worker.ts`. */
export type CompositionHostToWorkerMessage =
  | { type: 'init'; compiled: string; pageIds: string[]; blockIds: string[]; dataBlockIds: string[]; status: CompositionScriptStatus }
  | { type: 'status'; status: CompositionScriptStatus }
  | { type: 'data:pick'; id: string; row: Record<string, unknown> }
  | { type: 'destroy' };

/** Routes one worker message to the matching host operation. Returns false for unknown or non-object messages. */
export function dispatchCompositionWorkerMessage(message: unknown, ops: CompositionHostOperations): boolean {
  if (!message || typeof message !== 'object') return false;
  const data = message as Record<string, unknown>;
  const id = typeof data.id === 'string' ? data.id : '';
  switch (data.type) {
    case 'page:visibility': ops.onPageVisibility(id, data.visible === true); return true;
    case 'block:visibility': ops.onBlockVisibility(id, data.visible === true); return true;
    case 'data:refresh': ops.onRefreshData(id || undefined); return true;
    case 'data:loading': ops.onDataLoading(id, data.loading === true); return true;
    case 'navigation:go-to': ops.onNavigate(id); return true;
    case 'navigation:next': ops.onNext(); return true;
    case 'navigation:previous': ops.onPrevious(); return true;
    case 'form:set-field': ops.onSetFormField(String(data.blockId || ''), String(data.fieldName || ''), data.value); return true;
    case 'error': ops.onError(String(data.message || 'Composition Script fehlgeschlagen.')); return true;
    default: return false;
  }
}
