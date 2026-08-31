import {
  FORM_LAUNCH_PROTOCOL_VERSION,
  type FormEmbedEvent,
  type FormEmbedEventName,
  type FormLaunchRequest,
  type FormLaunchResult,
} from 'core';

const API = 'http://localhost:3001/api';

export async function launchEmbeddedForm(request: FormLaunchRequest): Promise<FormLaunchResult> {
  const response = await fetch(`${API}/form-launches`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...request, protocolVersion: FORM_LAUNCH_PROTOCOL_VERSION }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `Form launch failed (${response.status})`);
  return body as FormLaunchResult;
}

export function formEmbedUrl(launchUrl: string, hostOrigin = window.location.origin): string {
  const url = new URL(launchUrl, window.location.origin);
  url.searchParams.set('hostOrigin', hostOrigin);
  return url.toString();
}

// A `Record<FormEmbedEventName, true>` rather than a plain array/union
// check of literals - QA review finding: the previous inline check
// (`event.event === 'loaded' || ... === 'resize'`, no 'dirty') silently
// dropped every 'dirty' postMessage before CompositionRuntime.tsx ever
// saw it, which meant the "Ungespeicherte Änderungen" navigation guard
// there was entirely dead code - a clinician could leave a Composition
// with unsaved child-form edits and lose them with no warning. Listing
// every FormEmbedEventName as a required key here means TypeScript
// itself refuses to compile if `core`'s FormEmbedEventName union and this
// runtime check ever drift apart again, the same class of "duplicated
// enum" gap that has bitten this codebase before (see the Matrix-widget
// display-type bug).
const FORM_EMBED_EVENT_NAMES: Record<FormEmbedEventName, true> = {
  loaded: true,
  submitted: true,
  error: true,
  resize: true,
  dirty: true,
};

export function isFormEmbedEvent(value: unknown): value is FormEmbedEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<FormEmbedEvent>;
  return event.protocolVersion === FORM_LAUNCH_PROTOCOL_VERSION
    && typeof event.event === 'string' && Object.prototype.hasOwnProperty.call(FORM_EMBED_EVENT_NAMES, event.event)
    && typeof event.formId === 'string';
}
