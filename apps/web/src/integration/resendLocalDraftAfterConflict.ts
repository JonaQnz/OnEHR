import type { FormSaveCoordinator, FormSaveResult } from '../designer/formSaveCoordinator';

/**
 * The conflict banner's "Erneut senden" path.
 *
 * Retrying the failed PUT directly can never work: the coordinator still
 * holds the revision the server already rejected. Instead read the current
 * server revision, then let the coordinator send the *newest local draft* on
 * top of that revision (keepLocal). The server body fetched here is only used
 * as the new If-Match base - it never replaces the local canvas/editor.
 */
export async function resendLocalDraftAfterConflict(
  coordinator: FormSaveCoordinator,
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
): Promise<FormSaveResult> {
  if (coordinator.isClosed) return { status: 'ignored', reason: 'closed' };

  let response: Response;
  try {
    response = await fetchImpl(`${apiBaseUrl}/forms/${encodeURIComponent(coordinator.formId)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
  } catch (error) {
    if (coordinator.isClosed) return { status: 'ignored', reason: 'closed' };
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Aktueller Formularstand konnte nicht geladen werden.',
    };
  }

  // The route may have switched forms while the reload was in flight.
  if (coordinator.isClosed) return { status: 'ignored', reason: 'closed' };

  let body: any = null;
  try { body = await response.json(); } catch { body = null; }
  if (coordinator.isClosed) return { status: 'ignored', reason: 'closed' };

  if (!response.ok) {
    return {
      status: 'error',
      error: body?.error || body?.message || `Aktueller Formularstand konnte nicht geladen werden (HTTP ${response.status}).`,
    };
  }

  return coordinator.resolveConflict(body, { keepLocal: true });
}
