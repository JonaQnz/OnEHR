import {
  FORM_LAUNCH_PROTOCOL_VERSION,
  type FormEmbedEvent,
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

export function isFormEmbedEvent(value: unknown): value is FormEmbedEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<FormEmbedEvent>;
  return event.protocolVersion === FORM_LAUNCH_PROTOCOL_VERSION
    && (event.event === 'loaded' || event.event === 'submitted' || event.event === 'error')
    && typeof event.formId === 'string';
}
