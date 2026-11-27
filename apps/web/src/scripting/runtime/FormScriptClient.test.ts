import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormScriptClient } from './FormScriptClient';
import type {
  FormHostToWorkerMessage,
  FormWorkerToHostMessage,
} from './formScriptProtocol';

vi.mock('./scriptLogStore', () => ({ appendScriptLog: vi.fn() }));

type ClientOptions = ConstructorParameters<typeof FormScriptClient>[0];

class FakeWorker {
  static instances: FakeWorker[] = [];

  readonly posted: FormHostToWorkerMessage[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor(
    readonly url: URL,
    readonly workerOptions?: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: FormHostToWorkerMessage): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: FormWorkerToHostMessage | Record<string, unknown>): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}

function createClient(overrides: Partial<ClientOptions> = {}) {
  const options: ClientOptions = {
    formId: 'form-1',
    compiled: 'export default {};',
    values: { f1: 'initial' },
    ids: {
      fields: ['f1'],
      groups: [],
      repeatableGroups: [],
      sections: [],
      tabs: [],
      buttons: [],
      texts: [],
      alerts: [],
    },
    groupFields: { group1: ['f1'] },
    requiredFields: [],
    context: { patientId: 'p1' },
    onSetValue: vi.fn(),
    onUpdateValues: vi.fn(),
    onValidationErrors: vi.fn(),
    onUiState: vi.fn(),
    onToast: vi.fn(),
    onPrefillConflict: vi.fn(),
    onLog: vi.fn(),
    ...overrides,
  };
  const client = new FormScriptClient(options);
  return { client, options, worker: FakeWorker.instances[FakeWorker.instances.length - 1] };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('FormScriptClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances.length = 0;
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('posts init with merged group fields and resolves ready on "ready"', async () => {
    const { client, worker } = createClient();

    expect(worker.posted[0]).toMatchObject({
      type: 'init',
      ids: {
        fields: ['f1'],
        groupFields: { group1: ['f1'] },
      },
    });

    const ready = client.ready();
    worker.emit({ type: 'ready' });
    await expect(ready).resolves.toBeUndefined();
  });

  it('rejects ready and terminates the worker when "ready" does not arrive within 5s', async () => {
    const { client, worker } = createClient();

    const ready = client.ready();
    const rejection = expect(ready).rejects.toThrow('Zeitlimit von 5 Sekunden');
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;

    expect(worker.terminated).toBe(true);
  });

  it('resolves runLifecycle with the response result for its requestId', async () => {
    const { client, worker } = createClient();
    worker.emit({ type: 'ready' });
    await flush();

    const lifecycle = client.runLifecycle('afterLoad', { f1: 'value' });
    await flush();
    const request = worker.posted.find((message) => message.type === 'lifecycle');
    expect(request).toMatchObject({ type: 'lifecycle', name: 'afterLoad' });

    worker.emit({
      type: 'response',
      requestId: (request as { requestId: string }).requestId,
      result: { cancelled: false },
    });
    await expect(lifecycle).resolves.toEqual({ cancelled: false });
  });

  it('resolves runLifecycle as cancelled and terminates after 5s without a response', async () => {
    const { client, worker } = createClient();
    worker.emit({ type: 'ready' });
    await flush();

    const lifecycle = client.runLifecycle('beforeSave', { f1: 'value' });
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(lifecycle).resolves.toMatchObject({ cancelled: true });
    expect(worker.terminated).toBe(true);
  });

  it('returns a script error message when validate times out', async () => {
    const { client, worker } = createClient();
    worker.emit({ type: 'ready' });
    await flush();

    const validation = client.validate({ f1: 'value' });
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);

    const result = await validation;
    expect(result.__script).toMatchObject({ severity: 'error', source: 'script' });
    expect(result.__script.message).toContain('Zeitlimit von 5 Sekunden');
  });

  it('sends lifecycle onDestroy on destroy and rejects a pending validate with AbortError', async () => {
    const { client, worker } = createClient();
    worker.emit({ type: 'ready' });
    await flush();

    const validation = client.validate({ f1: 'value' });
    await flush();
    const rejection = expect(validation).rejects.toMatchObject({ name: 'AbortError' });

    const destroy = client.destroy({ f1: 'value' });
    await flush();
    const lifecycle = worker.posted.find((message) => message.type === 'lifecycle');
    expect(lifecycle).toMatchObject({ type: 'lifecycle', name: 'onDestroy' });

    worker.emit({
      type: 'response',
      requestId: (lifecycle as { requestId: string }).requestId,
      result: { cancelled: false },
    });
    await expect(destroy).resolves.toBeUndefined();
    await rejection;

    expect(worker.terminated).toBe(true);
  });

  it('posts connector calls to the form endpoint and aborts them on api:cancel', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { worker } = createClient();
    worker.emit({ type: 'ready' });
    await flush();

    worker.emit({ type: 'api:call', requestId: 'api-1', operation: 'lookup', input: { id: '1' } });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/script-connectors\/forms\/form-1\/call$/);
    expect(init).toMatchObject({ method: 'POST' });

    worker.emit({ type: 'api:cancel', requestId: 'api-1' });
    await flush();

    expect((init.signal as AbortSignal).aborted).toBe(true);
    expect(worker.posted.some((message) => message.type === 'api:response')).toBe(false);
  });

  it('ignores worker messages after destroy', async () => {
    const { client, options, worker } = createClient();
    worker.emit({ type: 'ready' });
    await flush();

    const destroy = client.destroy({});
    await flush();
    const lifecycle = worker.posted.find((message) => message.type === 'lifecycle');
    worker.emit({
      type: 'response',
      requestId: (lifecycle as { requestId: string }).requestId,
      result: { cancelled: false },
    });
    await destroy;

    worker.emit({ type: 'form:set-value', id: 'f1', value: 'scripted', persist: true });

    expect(options.onSetValue).not.toHaveBeenCalled();
  });
});
