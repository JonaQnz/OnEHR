import { CanonicalForm } from '../canonical';
import { FormScriptDocument, normalizeFormScript } from '../form-scripting';

export const FORM_DEFINITION_SCHEMA_VERSION = '1.0' as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface FormDefinitionV1 extends CanonicalForm {
  schemaVersion: typeof FORM_DEFINITION_SCHEMA_VERSION;
  revision: number;
  extensions: Record<string, JsonValue>;
  formScript: FormScriptDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Upgrades the current legacy CanonicalForm payload to FormDefinition v1.
 * The migration is deliberately pure so it can be used by the API, CLI and
 * future importers without coupling those callers to HTTP errors.
 */
export function migrateCanonicalFormToV1(input: unknown, idOverride?: string): FormDefinitionV1 {
  if (!isRecord(input)) {
    throw new Error('FormDefinition must be an object');
  }

  if (input.schemaVersion !== undefined && input.schemaVersion !== FORM_DEFINITION_SCHEMA_VERSION) {
    throw new Error(`"schemaVersion" must be "${FORM_DEFINITION_SCHEMA_VERSION}"`);
  }

  const revision = input.revision === undefined ? 0 : input.revision;
  if (!Number.isInteger(revision) || (revision as number) < 0) {
    throw new Error('"revision" must be a non-negative integer');
  }

  const extensions = input.extensions === undefined ? {} : input.extensions;
  if (!isRecord(extensions)) {
    throw new Error('"extensions" must be an object');
  }

  const definition = {
    ...(input as unknown as CanonicalForm),
    ...(idOverride ? { id: idOverride } : {}),
    schemaVersion: FORM_DEFINITION_SCHEMA_VERSION,
    revision: revision as number,
    extensions: extensions as Record<string, JsonValue>,
  };

  return {
    ...definition,
    formScript: normalizeFormScript(input.formScript, definition),
  };
}
