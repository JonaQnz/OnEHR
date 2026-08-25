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

  const rawForm = input as unknown as CanonicalForm;
  const definition = {
    ...rawForm,
    ...(idOverride ? { id: idOverride } : {}),
    schemaVersion: FORM_DEFINITION_SCHEMA_VERSION,
    revision: revision as number,
    extensions: extensions as Record<string, JsonValue>,
    ...(rawForm.layout ? { layout: backfillLegacyBindings(rawForm.layout, rawForm.bindings) } : {}),
  };

  return {
    ...definition,
    formScript: normalizeFormScript(input.formScript, definition),
  };
}
