import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompositionScriptClient } from './CompositionScriptClient';
import { dispatchCompositionWorkerMessage, type CompositionHostOperations, type CompositionScriptStatus } from './compositionScriptProtocol';

class FakeWorker {
  static last: FakeWorker | undefined;
  posted: unknown[] = []; onmessage: ((event: MessageEvent) => void) | null = null; onerror: ((event: ErrorEvent) => void) | null = null; terminated = false;
  postMessage(message: unknown) { this.posted.push(message); }
  terminate() { this.terminated = true; }
  constructor() { FakeWorker.last = this; }
}

const status: CompositionScriptStatus = { currentPage: 'page-1', completedBlocks: ['block-1'], pendingBlocks: [], state: 'in_progress' };

function createOps(): CompositionHostOperations {
  return { onPageVisibility: vi.fn(), onBlockVisibility: vi.fn(), onRefreshData: vi.fn(), onDataLoading: vi.fn(), onNavigate: vi.fn(), onNext: vi.fn(), onPrevious: vi.fn(), onError: vi.fn(), onSetFormField: vi.fn() };
}

function createClient(ops: CompositionHostOperations) {
  return new CompositionScriptClient({ compiled: 'export default () => {}', pageIds: ['page-1'], blockIds: ['block-1'], dataBlockIds: ['block-2'], status, ...ops });
}

function lastWorker(): FakeWorker { const worker = FakeWorker.last; if (!worker) throw new Error('Worker was not created'); return worker; }

beforeEach(() => { vi.stubGlobal('Worker', FakeWorker); });
afterEach(() => { vi.unstubAllGlobals(); FakeWorker.last = undefined; });

describe('CompositionScriptClient', () => {
  it('posts the init message with all fields', () => {
    createClient(createOps());
    expect(lastWorker().posted).toEqual([{ type: 'init', compiled: 'export default () => {}', pageIds: ['page-1'], blockIds: ['block-1'], dataBlockIds: ['block-2'], status }]);
  });

  it.each([
    ['page:visibility', { type: 'page:visibility', id: 'page-1', visible: true }, 'onPageVisibility', ['page-1', true]],
    ['block:visibility', { type: 'block:visibility', id: 'block-1', visible: false }, 'onBlockVisibility', ['block-1', false]],
    ['data:refresh with id', { type: 'data:refresh', id: 'block-2' }, 'onRefreshData', ['block-2']],
    ['data:refresh without id', { type: 'data:refresh' }, 'onRefreshData', [undefined]],
    ['data:loading', { type: 'data:loading', id: 'block-2', loading: true }, 'onDataLoading', ['block-2', true]],
    ['navigation:go-to', { type: 'navigation:go-to', id: 'page-1' }, 'onNavigate', ['page-1']],
    ['navigation:next', { type: 'navigation:next' }, 'onNext', []],
    ['navigation:previous', { type: 'navigation:previous' }, 'onPrevious', []],
    ['form:set-field', { type: 'form:set-field', blockId: 'block-1', fieldName: 'weight', value: 72 }, 'onSetFormField', ['block-1', 'weight', 72]],
    ['error', { type: 'error', message: 'boom' }, 'onError', ['boom']],
    ['error without message', { type: 'error' }, 'onError', ['Composition Script fehlgeschlagen.']],
  ] as Array<[string, Record<string, unknown>, keyof CompositionHostOperations, unknown[]]>)('routes %s to %s', (_label, message, operation, args) => {
    const ops = createOps();
    createClient(ops);
    lastWorker().onmessage?.({ data: message } as MessageEvent);
    expect(ops[operation]).toHaveBeenCalledTimes(1);
    expect(ops[operation]).toHaveBeenCalledWith(...args);
  });

  it('ignores unknown messages and dispatch reports false', () => {
    const ops = createOps();
    createClient(ops);
    lastWorker().onmessage?.({ data: { type: 'ready' } } as MessageEvent);
    lastWorker().onmessage?.({ data: null } as MessageEvent);
    expect(dispatchCompositionWorkerMessage({ type: 'ready' }, ops)).toBe(false);
    expect(dispatchCompositionWorkerMessage(null, ops)).toBe(false);
    for (const operation of Object.values(ops)) expect(operation).not.toHaveBeenCalled();
  });

  it('destroys the worker once and ignores later updates and messages', () => {
    const ops = createOps();
    const client = createClient(ops);
    const worker = lastWorker();
    client.destroy();
    expect(worker.posted).toEqual([{ type: 'init', compiled: 'export default () => {}', pageIds: ['page-1'], blockIds: ['block-1'], dataBlockIds: ['block-2'], status }, { type: 'destroy' }]);
    expect(worker.terminated).toBe(true);
    client.destroy();
    client.updateStatus(status);
    client.pickData('block-2', { value: 1 });
    worker.onmessage?.({ data: { type: 'page:visibility', id: 'page-1', visible: true } } as MessageEvent);
    expect(worker.posted).toHaveLength(2);
    expect(worker.terminated).toBe(true);
    for (const operation of Object.values(ops)) expect(operation).not.toHaveBeenCalled();
  });

  it('reports worker errors with fallback text', () => {
    const ops = createOps();
    createClient(ops);
    lastWorker().onerror?.({ message: '' } as ErrorEvent);
    expect(ops.onError).toHaveBeenCalledWith('Composition Script Worker fehlgeschlagen.');
  });
});
