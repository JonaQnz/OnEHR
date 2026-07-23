import { CanonicalForm } from 'core';
import { HttpError } from '../middleware/errorHandler';

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `"${field}" must be a non-empty string`);
  }
  return value.trim();
}

export function normalizeCanonicalFormPayload(payload: unknown, formId: string): CanonicalForm {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'Canonical form must be an object');
  }

  const form = payload as Record<string, unknown>;
  const name = requireNonEmptyString(form.name, 'name');
  const version = requireNonEmptyString(form.version, 'version');

  if (!Array.isArray(form.sourceTemplates)) {
    throw new HttpError(400, '"sourceTemplates" must be an array');
  }
  if (!form.layout || typeof form.layout !== 'object' || Array.isArray(form.layout)) {
    throw new HttpError(400, '"layout" must be an object');
  }
  if ((form.layout as Record<string, unknown>).type !== 'form') {
    throw new HttpError(400, '"layout.type" must be "form"');
  }
  if (!form.bindings || typeof form.bindings !== 'object' || Array.isArray(form.bindings)) {
    throw new HttpError(400, '"bindings" must be an object');
  }
  if (!form.locales || typeof form.locales !== 'object' || Array.isArray(form.locales)) {
    throw new HttpError(400, '"locales" must be an object');
  }

  return { ...(form as unknown as CanonicalForm), id: formId, name, version };
}
