import { describe, expect, it, vi } from 'vitest';
import { FormSaveCoordinator } from '../designer/formSaveCoordinator';
import { resendLocalDraftAfterConflict } from './resendLocalDraftAfterConflict';

function form(revision: number, extra: Record<string, unknown> = {}) {
  return { id: 'form-1', name: 'Test', canonical_json: { id: 'form-1', revision, name: 'Test', ...extra } };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('resendLocalDraftAfterConflict', () => {
  it('reads the current server revision, keeps the local draft and saves it with the fresh If-Match', async () => {
    const fetchImpl = vi.fn()
      // The original save lost the race: confirmed was rev-3, server is rev-8.
      .mockResolvedValueOnce(json({ error: 'conflict' }, 412))
      // The conflict banner's resend reads the current revision first.
      .mockResolvedValueOnce(json(form(8)))
      // The PUT then succeeds on top of rev-8.
      .mockResolvedValueOnce(json(form(9, { marker: 'local-wins' })));
    const coordinator = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: 'https://api.test' });
    coordinator.adoptServerForm(form(3));

    const conflicted = await coordinator.save({ id: 'form-1', revision: 3, marker: 'local-wins' });
    expect(conflicted.status).toBe('conflict');

    const result = await resendLocalDraftAfterConflict(coordinator, fetchImpl, 'https://api.test');

    expect(result.status).toBe('saved');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [getUrl, getInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(getUrl).toBe('https://api.test/forms/form-1');
    expect(getInit.method ?? 'GET').toBe('GET');
    const [putUrl, putInit] = fetchImpl.mock.calls[2] as unknown as [string, RequestInit];
    expect(putUrl).toBe('https://api.test/forms/form-1');
    expect((putInit.headers as Record<string, string>)['If-Match']).toBe('"rev-8"');
    expect(JSON.parse(String(putInit.body)).marker).toBe('local-wins');
  });

  it('reports a failed reload instead of sending the stale If-Match', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ error: 'conflict' }, 412))
      .mockResolvedValueOnce(json({ error: 'Server weg' }, 500));
    const coordinator = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: '' });
    coordinator.adoptServerForm(form(3));
    await coordinator.save({ id: 'form-1', revision: 3, marker: 'local' });

    const result = await resendLocalDraftAfterConflict(coordinator, fetchImpl, '');

    expect(result.status).toBe('error');
    expect(result.error).toContain('Server weg');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does nothing once the coordinator belongs to a form that is no longer open', async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'conflict' }, 412));
    const coordinator = new FormSaveCoordinator('form-1', { fetchImpl, apiBaseUrl: '' });
    coordinator.adoptServerForm(form(3));
    await coordinator.save({ id: 'form-1', revision: 3 });
    coordinator.close();

    const result = await resendLocalDraftAfterConflict(coordinator, fetchImpl, '');

    expect(result.status).toBe('ignored');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
