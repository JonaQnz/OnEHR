import { afterEach, describe, expect, it, vi } from 'vitest';
import { FormSaveCoordinator, type FormSaveResult } from './formSaveCoordinator';
import { createDebouncedDraftSave } from '../integration/debouncedDraftSave';

function form(revision: number, extra: Record<string, unknown> = {}) {
  return {
    id: 'form-1',
    name: 'Test',
    canonical_json: { id: 'form-1', revision, name: 'Test', ...extra },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('FormSaveCoordinator', () => {
  it('sends the confirmed revision as If-Match and adopts the saved revision', async () => {
    const fetchImpl = vi.fn(async () => json(form(4)));
    const coordinator = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: 'https://api.test' });
    coordinator.adoptServerForm(form(3));

    const result = await coordinator.save({ id: 'form-1', revision: 3, name: 'Neu' });

    expect(result.status).toBe('saved');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/forms/form-1');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['If-Match']).toBe('"rev-3"');
    expect(coordinator.getConfirmedRevision()).toBe(4);
  });

  it('keeps at most one PUT in flight and sends the newest draft afterwards', async () => {
    const first = deferred<Response>();
    const calls: Array<{ body: any; ifMatch: string | undefined }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)), ifMatch: (init?.headers as Record<string, string>)['If-Match'] });
      if (calls.length === 1) return first.promise;
      return json(form(5));
    });
    const coordinator = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: '' });
    coordinator.adoptServerForm(form(3));

    const canvasDraft = { id: 'form-1', revision: 3, name: 'Test', layout: { children: [{ field: 'canvas-change' }] } };
    const firstResult = coordinator.save(canvasDraft);
    await flush();

    // A folder mapping save while the canvas PUT is still open - exactly the
    // regression shape: the second payload was built from the latest local
    // form, so it carries the canvas edit and the mapping.
    const mappingDraft = {
      ...canvasDraft,
      extensions: { 'formbuilder.folder-path': { path: '/klinik/aufnahme' } },
    };
    const secondResult = coordinator.save(mappingDraft);
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    first.resolve(json(form(4)));
    await firstResult;
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls[1].ifMatch).toBe('"rev-4"');
    expect(calls[1].body.layout.children).toEqual([{ field: 'canvas-change' }]);
    expect(calls[1].body.extensions['formbuilder.folder-path']).toEqual({ path: '/klinik/aufnahme' });
    await secondResult;
    expect(coordinator.getConfirmedRevision()).toBe(5);
  });

  it('reports a conflict, blocks automatic writes and keeps the newest local draft', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'Form was changed by another request', code: 'FORM_REVISION_CONFLICT' }, 412));
    const coordinator = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: '' });
    coordinator.adoptServerForm(form(3));

    const result = await coordinator.save({ id: 'form-1', revision: 3, marker: 'first' });
    expect(result.status).toBe('conflict');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A newer local edit while the conflict is open is remembered but never
    // sent automatically with the stale confirmation.
    const blocked = await coordinator.save({ id: 'form-1', revision: 3, marker: 'newest' });
    expect(blocked.status).toBe('conflict');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    fetchImpl.mockResolvedValueOnce(json(form(9, { marker: 'newest' })));
    const resolved = await coordinator.resolveConflict(form(8), { keepLocal: true });

    expect(resolved.status).toBe('saved');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['If-Match']).toBe('"rev-8"');
    expect(JSON.parse(String(init.body)).marker).toBe('newest');
    expect(coordinator.getConfirmedRevision()).toBe(9);
  });

  it('surfaces save errors and retries with the confirmed revision', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ error: 'Kaputt' }, 500))
      .mockResolvedValueOnce(json(form(4)));
    const coordinator = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: '' });
    coordinator.adoptServerForm(form(3));

    const failed = await coordinator.save({ id: 'form-1', revision: 3, marker: 'draft' });
    expect(failed).toMatchObject({ status: 'error' });
    expect(failed.error).toContain('Kaputt');

    const retried = await coordinator.retryPending();
    expect(retried.status).toBe('saved');
    const [, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['If-Match']).toBe('"rev-3"');
  });

  it('runs apply-template exclusively after open PUTs and on a conflict-free state', async () => {
    const put = deferred<Response>();
    const fetchImpl = vi.fn(async () => put.promise);
    const coordinator = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: '' });
    coordinator.adoptServerForm(form(3));

    const runningSave = coordinator.save({ id: 'form-1', revision: 3, marker: 'canvas' });
    await flush();

    let actionStarted = false;
    const action = vi.fn(async () => {
      actionStarted = true;
      return { form: form(5) };
    });
    const exclusive = coordinator.runExclusive(action);
    await flush();
    expect(actionStarted).toBe(false);

    put.resolve(json(form(4)));
    await runningSave;
    await flush();
    expect(actionStarted).toBe(true);

    // Instead of starting a parallel PUT, a competing save is refused while
    // the template POST owns the coordinator.
    const during = await coordinator.save({ id: 'form-1', revision: 4, marker: 'during-template' });
    expect(during.status).toBe('blocked');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const exclusiveResult = await exclusive;
    expect(exclusiveResult.status).toBe('done');
    expect(coordinator.getConfirmedRevision()).toBe(5);

    fetchImpl.mockResolvedValueOnce(json(form(6)));
    await coordinator.save({ id: 'form-1', revision: 5, marker: 'after-template' });
    const [, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['If-Match']).toBe('"rev-5"');
  });

  it('does not start apply-template while a conflict is unresolved', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'conflict' }, 412));
    const coordinator = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: '' });
    coordinator.adoptServerForm(form(3));
    await coordinator.save({ id: 'form-1', revision: 3, marker: 'local' });

    const action = vi.fn(async () => ({ form: form(9) }));
    const result = await coordinator.runExclusive(action);

    expect(result.status).toBe('blocked');
    expect(action).not.toHaveBeenCalled();
  });

  it('ignores late responses and errors of a closed form coordinator', async () => {
    const put = deferred<Response>();
    const fetchImpl = vi.fn(async () => put.promise);
    const coordinator = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: '' });
    coordinator.adoptServerForm(form(3));

    const resultPromise = coordinator.save({ id: 'form-1', revision: 3 });
    await flush();
    coordinator.close();
    put.resolve(json(form(4)));

    const result: FormSaveResult = await resultPromise;
    expect(result.status).toBe('ignored');
    expect(coordinator.getConfirmedRevision()).toBe(3);
    expect(coordinator.isClosed).toBe(true);
  });

  it('lets two tabs conflict visibly and keeps each local draft', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(form(4)))
      .mockResolvedValueOnce(json({ error: 'conflict' }, 412));
    const tabA = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: '' });
    const tabB = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: '' });
    tabA.adoptServerForm(form(3));
    tabB.adoptServerForm(form(3));

    const a = await tabA.save({ id: 'form-1', revision: 3, marker: 'tab-a' });
    const b = await tabB.save({ id: 'form-1', revision: 3, marker: 'tab-b' });

    expect(a.status).toBe('saved');
    expect(b.status).toBe('conflict');
    expect(tabA.getLatestDraft()).toMatchObject({ marker: 'tab-a' });
    expect(tabB.getLatestDraft()).toMatchObject({ marker: 'tab-b' });
  });

  it('only starts an exclusive action when no error is open', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'offline' }, 503));
    const coordinator = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: '' });
    coordinator.adoptServerForm(form(3));
    await coordinator.save({ id: 'form-1', revision: 3 });

    const action = vi.fn(async () => ({ form: form(9) }));
    const result = await coordinator.runExclusive(action);
    expect(result.status).toBe('blocked');
    expect(action).not.toHaveBeenCalled();
  });

  it('marks an older reply as stale while a newer local draft is in flight', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const coordinator = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: '' });
    coordinator.adoptServerForm(form(3));

    const older = coordinator.save({ id: 'form-1', revision: 3, marker: 'canvas' });
    await flush();
    const newer = coordinator.save({ id: 'form-1', revision: 3, marker: 'canvas+undo' });
    await flush();

    first.resolve(json(form(4)));
    const olderResult = await older;
    await flush();

    // The newer draft is already in flight, not "pending" - the sequence is
    // what lets the UI refuse to apply the older server body.
    expect(coordinator.hasPendingDraft()).toBe(false);
    expect(olderResult.status).toBe('saved');
    expect(coordinator.isLatestDraftSequence(olderResult.draftSequence!)).toBe(false);

    second.resolve(json(form(5)));
    const newerResult = await newer;
    expect(coordinator.isLatestDraftSequence(newerResult.draftSequence!)).toBe(true);
  });

  describe('JSON debounce races', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('does not send a debounced JSON snapshot that a mapping save has overtaken', async () => {
      vi.useFakeTimers();
      const calls: Array<{ body: any; ifMatch: string | undefined }> = [];
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        calls.push({ body: JSON.parse(String(init?.body)), ifMatch: (init?.headers as Record<string, string>)['If-Match'] });
        return json(form(4));
      });
      const coordinator = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: 'https://api.test' });
      coordinator.adoptServerForm(form(3));

      const jsonDraft = { id: 'form-1', revision: 3, marker: 'json', fields: [{ id: 'json-field' }] };
      // The live editor publishes the shared draft synchronously, before the
      // 500 ms debounce starts.
      const jsonSequence = coordinator.adoptLocalDraft(jsonDraft);
      interface GeneratedTarget {
        formId: string;
        coordinator: FormSaveCoordinator;
        draftSequence: number;
      }
      const save = vi.fn((target: GeneratedTarget, payload: { parsed: any; draftSequence: number }) => {
        if (target.coordinator.isLatestDraftSequence(target.draftSequence)) {
          void target.coordinator.save(payload.parsed, { draftSequence: payload.draftSequence });
        }
      });
      const scheduler = createDebouncedDraftSave<{ parsed: any; draftSequence: number }, GeneratedTarget>({
        delay: 500,
        isStillActive: (target) => target.coordinator.isLatestDraftSequence(target.draftSequence),
        save,
      });
      scheduler.schedule(
        { formId: 'form-1', coordinator, draftSequence: jsonSequence },
        { parsed: jsonDraft, draftSequence: jsonSequence },
      );

      // The immediately following mapping save builds on formRef, so it
      // carries the JSON edit plus the mapping - and bumps the generation.
      const mappingDraft = { ...jsonDraft, extensions: { 'formbuilder.folder-path': { path: '/klinik/aufnahme' } } };
      const mappingSave = coordinator.save(mappingDraft);
      await mappingSave;
      vi.advanceTimersByTime(500);

      expect(save).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(calls[0].ifMatch).toBe('"rev-3"');
      expect(calls[0].body.marker).toBe('json');
      expect(calls[0].body.fields).toEqual([{ id: 'json-field' }]);
      expect(calls[0].body.extensions['formbuilder.folder-path']).toEqual({ path: '/klinik/aufnahme' });
    });

    it('never lets an older canvas reply overwrite a JSON draft that is still debouncing', async () => {
      vi.useFakeTimers();
      const first = deferred<Response>();
      const calls: Array<{ body: any; ifMatch: string | undefined }> = [];
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        calls.push({ body: JSON.parse(String(init?.body)), ifMatch: (init?.headers as Record<string, string>)['If-Match'] });
        return calls.length === 1 ? first.promise : json(form(5));
      });
      const coordinator = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: 'https://api.test' });
      coordinator.adoptServerForm(form(3));

      const canvasDraft = { id: 'form-1', revision: 3, marker: 'canvas', fields: [{ id: 'canvas-field' }] };
      const canvasSave = coordinator.save(canvasDraft);
      await flush();

      // Typing valid JSON synchronously adopts a newer draft while its save
      // is still waiting in the 500 ms debounce (no PUT queued yet).
      const jsonDraft = { ...canvasDraft, marker: 'json', fields: [{ id: 'json-field' }] };
      const jsonSequence = coordinator.adoptLocalDraft(jsonDraft);

      first.resolve(json(form(4)));
      const canvasResult = await canvasSave;
      await flush();

      // The canvas PUT still advanced the confirmed revision, but its body is
      // stale relative to the local JSON draft and must not be applied.
      expect(canvasResult.status).toBe('saved');
      expect(coordinator.getConfirmedRevision()).toBe(4);
      expect(coordinator.isLatestDraftSequence(canvasResult.draftSequence!)).toBe(false);
      expect(coordinator.getLatestDraft()).toMatchObject({ marker: 'json', fields: [{ id: 'json-field' }] });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // When the debounce fires, the JSON draft goes out on top of rev-4.
      const jsonResult = await coordinator.save(jsonDraft, { draftSequence: jsonSequence });
      expect(jsonResult.status).toBe('saved');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(calls[1].ifMatch).toBe('"rev-4"');
      expect(calls[1].body.marker).toBe('json');
      expect(calls[1].body.fields).toEqual([{ id: 'json-field' }]);
    });

    it('refuses a superseded debounced snapshot without issuing a PUT', async () => {
      const fetchImpl = vi.fn(async () => json(form(4)));
      const coordinator = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: '' });
      coordinator.adoptServerForm(form(3));

      const older = coordinator.adoptLocalDraft({ id: 'form-1', revision: 3, marker: 'older' });
      coordinator.adoptLocalDraft({ id: 'form-1', revision: 3, marker: 'newer' });

      const result = await coordinator.save({ id: 'form-1', revision: 3, marker: 'older' }, { draftSequence: older });

      expect(result.status).toBe('superseded');
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
