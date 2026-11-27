import type { FormSaveCoordinator } from '../designer/formSaveCoordinator';

export interface DraftSaveTarget {
  formId: string;
  coordinator: FormSaveCoordinator;
}

/**
 * `TTarget` carries whatever the caller captures before waiting (e.g. the
 * Designer's local draft generation) through the timer untouched. It defaults
 * to the plain target so callers that need nothing extra stay unchanged.
 */
export interface DebouncedDraftSaveOptions<T, TTarget extends DraftSaveTarget = DraftSaveTarget> {
  delay: number;
  /** Checked when the timer fires, not when it was scheduled. */
  isStillActive: (target: TTarget) => boolean;
  save: (target: TTarget, payload: T) => void;
}

export interface DebouncedDraftSave<T, TTarget extends DraftSaveTarget = DraftSaveTarget> {
  schedule: (target: TTarget, payload: T) => void;
  cancel: () => void;
}

/**
 * Captures the form id and coordinator *before* waiting, then verifies at fire
 * time that they are still the active ones. A timer that was armed for form A
 * can therefore never save A's JSON into form B after the route switched.
 */
export function createDebouncedDraftSave<T, TTarget extends DraftSaveTarget = DraftSaveTarget>(
  options: DebouncedDraftSaveOptions<T, TTarget>,
): DebouncedDraftSave<T, TTarget> {
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
