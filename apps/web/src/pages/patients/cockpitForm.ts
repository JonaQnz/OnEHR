export const LEGACY_COCKPIT_FORM_NAME = 'Klinisches Cockpit';

export interface CockpitCandidate {
  id: string;
  parent_id?: string | null;
  name: string;
}

/**
 * Resolves the form shown in the patient's Cockpit tab.
 *
 * A configured parent/line id wins exclusively - no name fallback, so pointing
 * the setting at a line that has no published form reliably shows nothing
 * instead of silently falling back to a differently named form. Only while the
 * setting is empty (the transition period before it is configured) the legacy
 * name match applies.
 */
export function resolveCockpitForm<T extends CockpitCandidate>(
  forms: T[],
  configuredParentId?: string | null,
): T | undefined {
  const lineId = configuredParentId?.trim();
  if (lineId) return forms.find((form) => (form.parent_id || form.id) === lineId);
  return forms.find((form) => form.name === LEGACY_COCKPIT_FORM_NAME);
}

/** Cockpit setting from GET /config/runtime-defaults as PatientDetail holds it: undefined while the request runs, null when it failed, '' when unconfigured (legacy name match), otherwise the configured line id. */
export type CockpitLineSetting = string | null | undefined;

/** Nothing is resolved before the setting has loaded (no legacy name match while loading) and nothing after a failed load: mounting the Cockpit starts a composition session, so a form of the wrong line must never be mounted. */
export function selectCockpitForm<T extends CockpitCandidate>(forms: T[], setting: CockpitLineSetting): T | undefined {
  if (setting === undefined || setting === null) return undefined;
  return resolveCockpitForm(forms, setting);
}
