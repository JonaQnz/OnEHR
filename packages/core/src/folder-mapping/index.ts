import type { CanonicalForm } from '../canonical';

/**
 * Which FOLDER path a Form's submitted Compositions should be filed under in
 * the EHR's RM `FOLDER`/`VERSIONED_FOLDER` directory - set by a designer via
 * the FormBuilder "FHIR Debug" tab's "Ordner-Pfad" field. Filing itself
 * happens fire-and-forget right after a real submit (see
 * apps/api/src/services/ehrDirectoryService.ts and
 * formSessionService.ts's submitFormSessionToProvider) - Forms never reads
 * the directory back to drive any other behavior, this only decides where a
 * newly-committed Composition gets linked.
 */
export const FORM_FOLDER_PATH_EXTENSION_KEY = 'formbuilder.folder-path' as const;

export interface FormFolderMapping {
  /** Slash-separated path, e.g. "Tumorboard/{year}". Segments are matched/
   * created by exact name. `{year}` is the only supported placeholder for
   * now (resolved to the current calendar year at filing time). */
  path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `null` when the form has no folder mapping configured - not an error,
 * most forms don't have one. */
export function getFormFolderMapping(
  form: Pick<CanonicalForm, 'layout'> & { extensions?: Record<string, unknown> },
): FormFolderMapping | null {
  const raw = form.extensions?.[FORM_FOLDER_PATH_EXTENSION_KEY];
  if (!isRecord(raw) || typeof raw.path !== 'string' || !raw.path.trim()) return null;
  return { path: raw.path.trim() };
}

/** Resolves the only supported placeholder (`{year}`) against a given
 * reference date, defaulting to now - split out so both the filing service
 * and the FormBuilder UI's live preview resolve it identically. */
export function resolveFolderPath(pathTemplate: string, at: Date = new Date()): string {
  return pathTemplate.replace(/\{year\}/g, String(at.getFullYear()));
}
