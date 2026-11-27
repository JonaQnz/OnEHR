import type { FormSaveCoordinator } from '../designer/formSaveCoordinator';

export interface DraftSaveTarget {
  formId: string;
  coordinator: FormSaveCoordinator;
}

export interface DebouncedDraftSaveOptions<T> {
  delay: number;
  /** Checked when the timer fires, not when it was scheduled. */
  isStillActive: (target: DraftSaveTarget) => boolean;
  save: (target: DraftSaveTarget, payload: T) => void;
}

export interface DebouncedDraftSave<T> {
  schedule: (target: DraftSaveTarget, payload: T) => void;
  cancel: () => void;
}

/**
 * Captures the form id and coordinator *before* waiting, then verifies at fire
 * time that they are still the active ones. A timer that was armed for form A
 * can therefore never save A's JSON into form B after the route switched.
 */
export function createDebouncedDraftSave<T>(options: DebouncedDraftSaveOptions<T>): DebouncedDraftSave<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    schedule(target, payload) {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        if (options.isStillActive(target)) options.save(target, payload);
      }, options.delay);
    },
    cancel,
  };
}
