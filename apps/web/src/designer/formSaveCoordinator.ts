/**
 * One save coordinator per form id.
 *
 * The form designer has several independent save paths (canvas autosave,
 * undo/redo snapshots, folder/FHIR mapping, the live JSON editor, template
 * application). Before this coordinator they each PUT the whole canonical
 * definition on their own, so two overlapping requests could land in either
 * order and silently drop one of the edits. The backend guards drafts with an
 * `If-Match: "rev-<n>"` token; this class owns that token for exactly one form
 * and serialises all writes against it:
 *
 * - at most one PUT is in flight,
 * - newer drafts replace older *pending* drafts (never run in parallel),
 * - the confirmed server revision is kept separately from the local draft,
 * - a 412/409 conflict stops every automated write until the user decides,
 * - an exclusive action (apply-template) waits for open PUTs, blocks new ones
 *   while it runs, and publishes the new confirmed revision before releasing
 *   saves again,
 * - replies for a closed/other form are ignored instead of overwriting the
 *   currently open form.
 */

export type FormSaveStatus = 'idle' | 'pending' | 'saving' | 'conflict' | 'error' | 'exclusive' | 'closed';

export interface FormSaveResult {
  status: 'saved' | 'conflict' | 'error' | 'blocked' | 'ignored' | 'superseded';
  saved?: any;
  error?: string;
  localDraft?: any;
  reason?: 'conflict' | 'error' | 'exclusive' | 'closed';
  /** Sequence of the local draft this result belongs to. */
  draftSequence?: number;
}

export type ExclusiveActionResult<T> =
  | { status: 'done'; value: T }
  | { status: 'blocked'; error: string; reason: 'conflict' | 'error' | 'exclusive' }
  | { status: 'error'; error: string }
  | { status: 'ignored' };

export interface FormSaveCoordinatorOptions {
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}

interface PendingSave {
  draft: any;
  sequence: number;
  resolve: (result: FormSaveResult) => void;
}

function formRevision(form: any): number | undefined {
  const revision = form?.canonical_json?.revision ?? form?.revision;
  return typeof revision === 'number' && Number.isFinite(revision) ? revision : undefined;
}

function errorMessage(body: any, status: number): string {
  return body?.error || body?.message || `Speichern fehlgeschlagen (HTTP ${status})`;
}

function thrownMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Speichern fehlgeschlagen.';
}

export class FormSaveCoordinator {
  readonly formId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;

  private confirmedForm: any = null;
  private confirmedRevision: number | null = null;
  private latestDraft: any = null;
  private latestDraftSequence = 0;
  private pending: PendingSave | null = null;
  private inFlight: Promise<FormSaveResult> | null = null;
  private drainPromise: Promise<void> | null = null;
  private exclusive = false;
  private closed = false;
  private conflict: { serverRevision: number | null; localDraft: any } | null = null;
  private lastError: string | null = null;
  private status: FormSaveStatus = 'idle';

  constructor(formId: string, options: FormSaveCoordinatorOptions = {}) {
    this.formId = formId;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBaseUrl = options.apiBaseUrl ?? '';
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get confirmed(): any {
    return this.confirmedForm;
  }

  getConfirmedRevision(): number | null {
    return this.confirmedRevision;
  }

  getLatestDraft(): any {
    return this.latestDraft;
  }

  hasPendingDraft(): boolean {
    return this.pending !== null;
  }

  /** True when this sequence is still the newest local draft. */
  isLatestDraftSequence(sequence: number): boolean {
    return sequence === this.latestDraftSequence;
  }

  getStatus(): FormSaveStatus {
    return this.closed ? 'closed' : this.status;
  }

  getError(): string | null {
    return this.lastError;
  }

  hasConflict(): boolean {
    return this.conflict !== null;
  }

  /**
   * Adopts a server record without touching the local draft. Used for the
   * initial GET, after an exclusive server action and after a conflict reload.
   */
  adoptServerForm(form: any): boolean {
    if (this.closed) return false;
    const revision = formRevision(form);
    if (revision !== undefined) this.confirmedRevision = revision;
    if (form) this.confirmedForm = form;
    return true;
  }

  close(): void {
    this.closed = true;
    this.status = 'closed';
    this.pending?.resolve({ status: 'ignored', reason: 'closed' });
    this.pending = null;
  }

  /**
   * Publishes a local draft synchronously and returns its generation.
   *
   * Every save source (canvas, undo/redo, mapping, live JSON) adopts its
   * draft here *before* a debounce starts or a PUT is queued. That way a
   * reply for an older draft can be recognised as stale even while the newer
   * draft is still waiting in the 500 ms JSON debounce.
   */
  adoptLocalDraft(draft: any): number {
    if (this.closed || this.exclusive) return this.latestDraftSequence;
    this.latestDraft = draft;
    this.latestDraftSequence += 1;
    return this.latestDraftSequence;
  }

  /**
   * Queues the complete canonical definition as the newest local draft. Any
   * older pending draft is superseded; the returned promise resolves with the
   * outcome for *this* draft.
   *
   * `draftSequence` is the generation returned by adoptLocalDraft() for a
   * debounced editor save. If a newer local draft has been adopted since,
   * the snapshot is already overtaken and must not be sent at all.
   */
  save(draft: any, options: { draftSequence?: number } = {}): Promise<FormSaveResult> {
    if (this.closed) return Promise.resolve({ status: 'ignored', reason: 'closed' });

    if (this.exclusive) {
      // Editing is locked for the duration of the exclusive action; the
      // pre-template draft must not leak into a later save.
      return Promise.resolve({
        status: 'blocked',
        reason: 'exclusive',
        error: 'Das Formular wird gerade durch eine andere Aktion geändert.',
        localDraft: draft,
      });
    }

    let sequence: number;
    if (typeof options.draftSequence === 'number') {
      if (options.draftSequence !== this.latestDraftSequence) {
        return Promise.resolve({ status: 'superseded', draftSequence: options.draftSequence });
      }
      sequence = options.draftSequence;
      // Keep the queued body identical to the adopted generation.
      this.latestDraft = draft;
    } else {
      sequence = this.adoptLocalDraft(draft);
    }

    if (this.conflict) {
      return Promise.resolve({
        status: 'conflict',
        reason: 'conflict',
        error: 'Das Formular wurde in einem anderen Tab geändert.',
        localDraft: this.latestDraft,
        draftSequence: sequence,
      });
    }

    // A new explicit edit after a failed save is a fresh attempt.
    this.lastError = null;

    return new Promise<FormSaveResult>((resolve) => {
      if (this.pending) this.pending.resolve({ status: 'superseded' });
      this.pending = { draft, sequence, resolve };
      this.scheduleDrain();
    });
  }

  /**
   * Retry after a transport/server error. Conflict resends must go through
   * resolveConflict() instead, so they first pick up the new server revision.
   */
  retryPending(): Promise<FormSaveResult> {
    if (this.closed) return Promise.resolve({ status: 'ignored', reason: 'closed' });
    if (this.conflict) {
      return Promise.resolve({
        status: 'conflict',
        reason: 'conflict',
        error: 'Bitte den Konflikt zuerst auflösen.',
        localDraft: this.latestDraft,
      });
    }
    if (this.latestDraft === null) {
      return Promise.resolve({ status: 'blocked', reason: 'error', error: 'Kein lokaler Entwurf vorhanden.' });
    }
    this.lastError = null;
    return this.save(this.latestDraft);
  }

  /**
   * Conflict resolution. With keepLocal the fetched server revision becomes
   * the new If-Match base, while the newest local draft is sent on top of it -
   * the server data is never written over the local canvas/editor.
   */
  resolveConflict(serverForm: any, options: { keepLocal?: boolean } = {}): Promise<FormSaveResult> {
    if (this.closed) return Promise.resolve({ status: 'ignored', reason: 'closed' });
    this.adoptServerForm(serverForm);
    this.conflict = null;
    this.lastError = null;
    this.status = 'pending';

    if (options.keepLocal === false) {
      this.pending?.resolve({ status: 'superseded' });
      this.pending = null;
      return Promise.resolve({ status: 'saved', saved: serverForm, draftSequence: this.latestDraftSequence });
    }

    if (this.latestDraft === null) {
      return Promise.resolve({ status: 'blocked', reason: 'error', error: 'Kein lokaler Entwurf zum erneuten Senden.' });
    }
    return this.save(this.latestDraft);
  }

  /**
   * Runs a revision-changing action (apply-template) exclusively: waits for
   * the open PUT, refuses to start on a conflict/error, keeps every other PUT
   * out while the POST and the adoption of its result are in progress, then
   * publishes the new confirmed revision.
   */
  async runExclusive<T>(action: () => Promise<T>): Promise<ExclusiveActionResult<T>> {
    if (this.closed) return { status: 'ignored' };
    if (this.conflict) {
      return { status: 'blocked', reason: 'conflict', error: 'Bitte zuerst den Konflikt auflösen.' };
    }
    if (this.lastError) {
      return { status: 'blocked', reason: 'error', error: 'Bitte zuerst den Speicherfehler beheben.' };
    }
    if (this.exclusive) {
      return { status: 'blocked', reason: 'exclusive', error: 'Eine andere Aktion läuft bereits.' };
    }

    if (this.drainPromise || this.pending || this.inFlight) {
      await (this.drainPromise ?? (this.inFlight ? this.inFlight.then(() => undefined) : this.ensureDrain()));
    }
    if (this.closed) return { status: 'ignored' };
    if (this.conflict) {
      return { status: 'blocked', reason: 'conflict', error: 'Bitte zuerst den Konflikt auflösen.' };
    }
    if (this.lastError) {
      return { status: 'blocked', reason: 'error', error: 'Bitte zuerst den Speicherfehler beheben.' };
    }

    this.exclusive = true;
    this.status = 'exclusive';
    try {
      const value = await action();
      if (this.closed) return { status: 'ignored' };
      const serverForm = (value as any)?.form ?? value;
      this.adoptServerForm(serverForm);
      return { status: 'done', value };
    } catch (error) {
      if (this.closed) return { status: 'ignored' };
      this.lastError = thrownMessage(error);
      this.status = 'error';
      return { status: 'error', error: this.lastError };
    } finally {
      this.exclusive = false;
      if (!this.closed) {
        this.status = this.lastError ? 'error' : this.conflict ? 'conflict' : 'idle';
      }
    }
  }

  private scheduleDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      // A retry may have been queued while the previous loop was already
      // unwinding (e.g. right after an error). Pick it up instead of leaving
      // it waiting forever for a drain that has already finished.
      if (!this.closed && this.pending && !this.conflict && !this.lastError && !this.exclusive) {
        this.scheduleDrain();
      }
    });
  }

  private ensureDrain(): Promise<void> {
    this.scheduleDrain();
    return this.drainPromise as Promise<void>;
  }

  private async drain(): Promise<void> {
    try {
      while (!this.closed && this.pending && !this.conflict && !this.exclusive && !this.lastError) {
        const current = this.pending;
        this.pending = null;
        this.status = 'saving';
        this.inFlight = this.send(current.draft, current.sequence);
        const result = await this.inFlight;
        this.inFlight = null;
        current.resolve(result);
        if (result.status !== 'saved') {
          // A newer draft may have been queued while this request was open.
          // It is still the latest local draft, but the conflict/error state
          // blocks automated sending - resolve its promise too instead of
          // leaving it pending forever.
          const queued = this.pending as PendingSave | null;
          this.pending = null;
          queued?.resolve(result.status === 'conflict'
            ? { ...result, localDraft: this.latestDraft, draftSequence: queued.sequence }
            : { ...result, draftSequence: queued?.sequence });
          break;
        }
      }
    } finally {
      this.inFlight = null;
      if (!this.closed) {
        if (this.conflict) this.status = 'conflict';
        else if (this.lastError) this.status = 'error';
        else if (this.exclusive) this.status = 'exclusive';
        else this.status = this.pending ? 'pending' : 'idle';
      }
    }
  }

  private async send(draft: any, draftSequence: number): Promise<FormSaveResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.confirmedRevision !== null) headers['If-Match'] = `"rev-${this.confirmedRevision}"`;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}/forms/${encodeURIComponent(this.formId)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(draft),
        credentials: 'include',
      });
    } catch (error) {
      if (this.closed) return { status: 'ignored', reason: 'closed', draftSequence };
      this.lastError = thrownMessage(error);
      this.status = 'error';
      return { status: 'error', error: this.lastError, localDraft: draft, draftSequence };
    }

    if (this.closed) return { status: 'ignored', reason: 'closed', draftSequence };

    let body: any = null;
    try { body = await response.json(); } catch { body = null; }
    if (this.closed) return { status: 'ignored', reason: 'closed', draftSequence };

    if (!response.ok) {
      const conflictCode = body?.code === 'FORM_REVISION_CONFLICT';
      if (response.status === 412 || response.status === 409 || conflictCode) {
        this.conflict = { serverRevision: this.confirmedRevision, localDraft: this.latestDraft };
        this.status = 'conflict';
        return {
          status: 'conflict',
          reason: 'conflict',
          error: 'Das Formular wurde in einem anderen Tab geändert. Deine Änderungen bleiben erhalten.',
          localDraft: this.latestDraft,
          draftSequence,
        };
      }
      this.lastError = errorMessage(body, response.status);
      this.status = 'error';
      return { status: 'error', error: this.lastError, localDraft: draft, draftSequence };
    }

    this.adoptServerForm(body);
    this.lastError = null;
    return { status: 'saved', saved: body, draftSequence };
  }
}

const coordinators = new Map<string, FormSaveCoordinator>();

/** Returns the single coordinator for a form id, creating it on first use. */
export function ensureFormSaveCoordinator(
  formId: string,
  options: FormSaveCoordinatorOptions = {},
): FormSaveCoordinator {
  const existing = coordinators.get(formId);
  if (existing && !existing.isClosed) return existing;
  const coordinator = new FormSaveCoordinator(formId, options);
  coordinators.set(formId, coordinator);
  return coordinator;
}

/** Closes a form's coordinator so its late replies can never reach another form. */
export function closeFormSaveCoordinator(formId: string): void {
  const coordinator = coordinators.get(formId);
  if (coordinator) {
    coordinator.close();
    coordinators.delete(formId);
  }
}

/** Test helper - the registry is process wide, tests must not leak state. */
export function resetFormSaveCoordinatorsForTests(): void {
  for (const coordinator of coordinators.values()) coordinator.close();
  coordinators.clear();
}
