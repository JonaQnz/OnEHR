import {
  assertFormSessionTransition,
  isFormRuntimeMode,
  isFormSessionChangeType,
  isFormSessionStatus,
  type FormSessionChangeType,
  type FormSessionLifecycleState,
  type FormRuntimeMode,
  type FormSessionStatus,
  type UserAuthMode,
} from 'core';
import { HttpError } from '../middleware/errorHandler';

export interface SessionActor {
  userId: string;
  authMode: UserAuthMode;
}

export function persistedStatus(value: unknown): FormSessionStatus {
  if (!isFormSessionStatus(value)) throw new HttpError(500, 'Stored form session has an invalid status');
  return value;
}

export function persistedMode(value: unknown): FormRuntimeMode {
  if (!isFormRuntimeMode(value)) throw new HttpError(500, 'Stored form session has an invalid mode');
  return value;
}

// Same defensive-boundary pattern as persistedStatus/persistedMode above -
// core doesn't export an isUserAuthMode guard (authMode is a plain String
// column, not a Prisma enum), so this was previously only "checked" by
// `record: any` silently accepting whatever the column held. Found while
// removing that `any` for real: an invalid stored value now fails loudly
// here instead of quietly typing as UserAuthMode without ever having been
// verified.
export function persistedAuthMode(value: unknown): UserAuthMode {
  if (value !== 'local' && value !== 'hip') throw new HttpError(500, 'Stored form session has an invalid auth mode');
  return value;
}

export function transitionStatus(current: FormSessionStatus, next: FormSessionStatus): FormSessionStatus {
  try {
    assertFormSessionTransition(current, next);
  } catch {
    throw new HttpError(409, `Invalid form-session transition: ${current} -> ${next}`);
  }
  return next;
}

export function assertSessionIsEditable(status: FormSessionStatus, lifecycleState?: unknown): void {
  if (lifecycleState === 'deleted') {
    throw new HttpError(409, 'This document has been withdrawn and can no longer be edited');
  }
  if (status === 'submitted' || status === 'cancelled') {
    throw new HttpError(409, 'Form session is no longer editable');
  }
}

export function persistedLifecycleState(value: unknown): FormSessionLifecycleState {
  return value === 'new' || value === 'incomplete' || value === 'complete' || value === 'deleted' ? value : 'new';
}

export function assertWithdrawable(session: { lifecycleState: unknown; providerReference: string | null }): void {
  const lifecycleState = persistedLifecycleState(session.lifecycleState);
  if (lifecycleState === 'deleted') throw new HttpError(409, 'This document has already been withdrawn');
  if (lifecycleState !== 'complete') throw new HttpError(409, 'Only a finalized document can be withdrawn');
  if (!session.providerReference) throw new HttpError(409, 'No finalized composition reference to withdraw');
}

export function submitChangeType(lifecycleState: unknown, requested: unknown, stored: unknown): FormSessionChangeType | undefined {
  return persistedLifecycleState(lifecycleState) === 'complete'
    ? (isFormSessionChangeType(requested) ? requested : (isFormSessionChangeType(stored) ? stored : 'modification'))
    : undefined;
}

export function assertOwner(record: { userId: string }, actor: SessionActor): void {
  if (record.userId !== actor.userId && actor.userId !== 'anonymous') throw new HttpError(403, 'You do not have access to this form session');
}
