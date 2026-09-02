import { CanonicalForm, FormElementLayout, JsonValue } from '../canonical';
import { FormScriptDocument, normalizeFormScript } from '../form-scripting';

export const FORM_DEFINITION_SCHEMA_VERSION = '1.0' as const;

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
 * A form saved before per-node `binding` existed (or one whose top-level
 * `bindings` map was written under a different key than the layout node's
 * own id - see the mismatched-key bug this consolidation fixes at the
 * write side) can still have real binding data sitting only in the legacy
 * top-level `bindings` dict. Rather than a one-off data migration script,
 * every such form self-heals the first time it's loaded: this backfills
 * `node.binding` from `bindings[node.id]` (or `bindings[node.name]`, the
 * other key convention historically used) wherever a node is missing one -
 * a read-time normalization, not a standing runtime fallback.
 */
function backfillLegacyBindings(layout: FormElementLayout, bindingsInput: CanonicalForm['bindings'] | undefined): FormElementLayout {
  if (!bindingsInput) return layout;
  const bindings: CanonicalForm['bindings'] = bindingsInput;
  function walk(node: FormElementLayout): FormElementLayout {
    const children = node.children?.map(walk);
    if (node.binding || (!node.id && !node.name)) {
      return children ? { ...node, children } : node;
    }
    const legacy = (node.id && bindings[node.id]?.openehr) || (node.name && bindings[node.name]?.openehr);
    if (!legacy) return children ? { ...node, children } : node;
    return { ...node, binding: legacy, ...(children ? { children } : {}) };
  }
  return walk(layout);
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

  // CanonicalForm's remaining fields (name/version/sourceTemplates/layout/
  // bindings/locales) are all non-optional on the type, but until now
  // nothing here actually checked them - `input as unknown as
  // CanonicalForm` let a payload missing any of these through silently,
  // to fail much later and far from the actual bad data (e.g. a missing
  // `layout` surfacing as a confusing crash deep inside
  // `collectRuntimeFields` instead of a clear error right here at the
  // trust boundary both apps/api and apps/web rely on for every stored
  // form). Mirrors the equivalent checks apps/api's
  // `normalizeCanonicalFormPayload` already does, but only at the one
  // HTTP form-creation endpoint - every other caller (every route/service
  // that re-loads an already-stored form) calls this function directly
  // and never passed through those checks.
  if (!idOverride && typeof input.id !== 'string') {
    throw new Error('"id" must be a string');
  }
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new Error('"name" must be a non-empty string');
  }
  if (typeof input.version !== 'string' || input.version.trim() === '') {
    throw new Error('"version" must be a non-empty string');
  }
  const sourceTemplates = input.sourceTemplates === undefined ? [] : input.sourceTemplates;
  if (!Array.isArray(sourceTemplates)) {
    throw new Error('"sourceTemplates" must be an array');
  }
  if (!isRecord(input.layout)) {
    throw new Error('"layout" must be an object');
  }
  if (input.layout.type !== 'form') {
    throw new Error('"layout.type" must be "form"');
  }
  const bindings = input.bindings === undefined ? {} : input.bindings;
  if (!isRecord(bindings)) {
    throw new Error('"bindings" must be an object');
  }
  const locales = input.locales === undefined ? {} : input.locales;
  if (!isRecord(locales)) {
    throw new Error('"locales" must be an object');
  }

  const rawForm = input as unknown as CanonicalForm;
  const definition = {
    ...rawForm,
    ...(idOverride ? { id: idOverride } : {}),
    schemaVersion: FORM_DEFINITION_SCHEMA_VERSION,
    revision: revision as number,
    extensions: extensions as Record<string, JsonValue>,
    sourceTemplates: sourceTemplates as CanonicalForm['sourceTemplates'],
    bindings: bindings as CanonicalForm['bindings'],
    locales: locales as CanonicalForm['locales'],
    layout: backfillLegacyBindings(rawForm.layout, rawForm.bindings),
  };

  return {
    ...definition,
    formScript: normalizeFormScript(input.formScript, definition),
  };
}
