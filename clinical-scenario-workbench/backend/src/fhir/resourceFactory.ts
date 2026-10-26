import type { EntityRegistryLike } from '../entity/registry';
import type { FhirFormField } from './resourceForm';

/** Sets `value` at a dot-separated path into `target`, creating intermediate
 * objects/arrays as needed - array indices are just numeric path segments
 * ("participant.0.actor.reference"), since a plain object/array both accept
 * bracket/property access by (numeric-string) key in JS. Deliberately not a
 * generic deep-merge library dependency - the paths this workbench's own
 * blueprints declare are simple and few, per spec section 9's "don't
 * overengineer". */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor: any = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const nextIsIndex = /^\d+$/.test(segments[i + 1]);
    if (cursor[segment] === undefined || cursor[segment] === null) cursor[segment] = nextIsIndex ? [] : {};
    cursor = cursor[segment];
  }
  cursor[segments[segments.length - 1]] = value;
}

/** The read-side counterpart to setPath - used by extractFormValues below to
 * recover a form's current flat values out of an already-existing FHIR
 * resource (needed so a PARTIAL update's validation checks the resulting
 * WHOLE resource, not just the handful of fields this particular call is
 * changing - see agent/planner.ts's updateFhirResourceEntity). */
export function getPath(source: Record<string, unknown>, path: string): unknown {
  let cursor: any = source;
  for (const segment of path.split('.')) {
    if (cursor === undefined || cursor === null) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/** Reads every one of `fields`' current values back out of `resource` into
 * the same flat `{path: value}` shape buildFhirResource itself consumes -
 * the inverse operation, used to reconstruct "what does this entity's form
 * currently look like" before merging in a partial edit. A `reference`
 * field's extracted value is the raw stored reference string (e.g.
 * "Patient/4711"), not a scenario key - fine for validation purposes (only
 * emptiness is checked unless the field is itself being changed, in which
 * case the caller supplies a fresh scenario-key value instead). */
export function extractFormValues(fields: FhirFormField[], resource: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    const value = getPath(resource, field.path);
    if (value !== undefined) values[field.path] = value;
  }
  return values;
}

/**
 * The one place a FhirResourceForm's flat `{path: value}` values become a
 * real, nested FHIR resource body - spec section 10/22's mandatory pipeline
 * ("Resource Form -> Validation -> FHIR Resource Factory -> HIP FHIR API"),
 * shared by both the UI's "Speichern" action and the create_fhir_resource/
 * update_fhir_resource MCP tools, so neither path can bypass it.
 *
 * A `reference`-typed field's value is always a scenario key (never a raw
 * FHIR reference string, per referenceValidation.ts's own doc comment) -
 * resolved here, and only here, via the Entity Registry into the real
 * `{reference: "ResourceType/id"}` shape.
 *
 * `existingResource`, when given (an update), is cloned and used as the
 * base so any real-world field this form doesn't manage (server-assigned
 * `meta`, an extension nobody modeled) survives the round-trip untouched -
 * only the paths this form's fields actually cover get overwritten.
 */
export function buildFhirResource(
  resourceType: string,
  fields: FhirFormField[],
  values: Record<string, unknown>,
  registry: EntityRegistryLike,
  options?: { existingResource?: Record<string, unknown> },
): Record<string, unknown> {
  const resource: Record<string, unknown> = options?.existingResource
    ? JSON.parse(JSON.stringify(options.existingResource))
    : { resourceType };
  resource.resourceType = resourceType;

  for (const field of fields) {
    const rawValue = values[field.path];
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;

    if (field.type === 'reference') {
      // field.path already names the leaf "reference" string itself (e.g.
      // "participant.0.actor.reference"), matching every blueprint's own
      // field-path convention - so the resolved value is the plain
      // "ResourceType/id" string, not a second {reference: ...} wrapper.
      const scenarioKey = String(rawValue);
      const entity = registry.get(scenarioKey);
      if (!entity) {
        throw new Error(`Cannot resolve reference field "${field.path}": scenario key "${scenarioKey}" is not registered yet.`);
      }
      setPath(resource, field.path, `${entity.resourceType}/${entity.hipResourceId}`);
      continue;
    }

    setPath(resource, field.path, rawValue);
  }

  return resource;
}
