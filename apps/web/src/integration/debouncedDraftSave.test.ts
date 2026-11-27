import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FormSaveCoordinator } from '../designer/formSaveCoordinator';
import { createDebouncedDraftSave, type DraftSaveTarget } from './debouncedDraftSave';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createDebouncedDraftSave', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const coordinatorA = new FormSaveCoordinator('form-a', { fetchImpl: vi.fn(async () => json({})), apiBaseUrl: '' });
  const coordinatorB = new FormSaveCoordinator('form-b', { fetchImpl: vi.fn(async () => json({})), apiBaseUrl: '' });

  it('fires the captured target only while that form and coordinator are still active', () => {
    const save = vi.fn();
    let active: DraftSaveTarget = { formId: 'form-a', coordinator: coordinatorA };
    const scheduler = createDebouncedDraftSave<{ value: string }>({
      delay: 500,
      isStillActive: (target) => target === active,
      save,
    });

    scheduler.schedule(active, { value: 'a' });
    vi.advanceTimersByTime(499);
    expect(save).not.toHaveBeenCalled();

    // The route switches to form B before A's debounce elapses. The captured
    // A timer must not save A's JSON into B's editor or coordinator.
    active = { formId: 'form-b', coordinator: coordinatorB };
    vi.advanceTimersByTime(1);
    expect(save).not.toHaveBeenCalled();

    scheduler.schedule(active, { value: 'b' });
    vi.advanceTimersByTime(500);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(active, { value: 'b' });
  });

  it('cancels a pending save when the editor is left', () => {
    const save = vi.fn();
    const target = { formId: 'form-a', coordinator: coordinatorA };
    const scheduler = createDebouncedDraftSave<{ value: string }>({
      delay: 500,
      isStillActive: () => true,
      save,
    });

    scheduler.schedule(target, { value: 'a' });
    scheduler.cancel();
    vi.advanceTimersByTime(1000);
    expect(save).not.toHaveBeenCalled();
  });
});
