import type { ActivityLog } from '../activity/log';
import type { BlueprintLoader } from '../fhir/blueprint';
import { buildFhirResource, extractFormValues } from '../fhir/resourceFactory';
import { validateAgainstForm } from '../fhir/resourceForm';
import type { ResourceFormStore } from '../fhir/resourceFormStore';
import type { FhirHipClient } from '../fhirHip/resourceClient';
import { mayOverwrite, type Provenance } from '../types';
import { validateAgainstBlueprint } from '../validation/blueprintValidation';
import { validateReferences } from '../validation/referenceValidation';
import type { EntityRecord, EntityRegistryLike } from '../entity/registry';

/**
 * The deterministic core of the "Agent Loop" (spec section 26): given a
 * scenario need, this resolves it through the mandatory Resource Form ->
 * Blueprint Validation -> Reference Validation -> FHIR Factory -> HIP API ->
 * read-back -> Registry pipeline (spec section 22). No LLM call happens
 * here at all - see agent/generate.ts for the separate, narrow LLM-fill step
 * this pipeline's caller may invoke first to fill in `generated`-policy
 * fields the scenario didn't specify. Both the UI's "Speichern"/"Step"
 * actions and the MCP create_fhir_resource/update_fhir_resource/
 * advance_scenario tools call these same functions - never a second,
 * parallel implementation (spec section 10/21).
 */

export interface PlannerDeps {
  blueprints: BlueprintLoader;
  forms: ResourceFormStore;
  registry: EntityRegistryLike;
  hip: FhirHipClient;
  activity: ActivityLog;
}

export class PlannerValidationError extends Error {
  constructor(message: string, public readonly issues: string[]) {
    super(message);
  }
}

function issueSummary(formIssues: { message: string }[], blueprintIssues: { message: string }[], referenceIssues: { message: string }[]): string[] {
  return [...formIssues.map((i) => i.message), ...blueprintIssues.map((i) => i.message), ...referenceIssues.map((i) => i.message)];
}

export interface EnsureFhirResourceInput {
  resourceType: string;
  scenarioKey: string;
  /** Flat `{field.path: value}` - a `reference`-typed field's value is a
   * scenario key, resolved by the FHIR Factory, never a raw FHIR reference. */
  values: Record<string, unknown>;
  provenance: Provenance;
  /** Which fields (by path) this specific call is actually setting, for
   * per-field provenance tracking - defaults to every key present in
   * `values`. */
  fieldsWritten?: string[];
}

export interface EnsureFhirResourceResult {
  entity: EntityRecord;
  resource: Record<string, unknown>;
  created: boolean;
}

/** Idempotent: if `scenarioKey` is already registered as this resourceType,
 * returns the existing entity (re-reading it from HIP) rather than creating
 * a duplicate - this is what lets the planner be called again for a
 * scenario need that's already been satisfied without side effects. */
export async function ensureFhirResource(deps: PlannerDeps, input: EnsureFhirResourceInput): Promise<EnsureFhirResourceResult> {
  const existing = deps.registry.get(input.scenarioKey);
  if (existing) {
    if (existing.resourceType !== input.resourceType) {
      throw new Error(`Scenario key "${input.scenarioKey}" is already registered as a ${existing.resourceType}, not ${input.resourceType}.`);
    }
    const resource = await deps.hip.get(input.resourceType, existing.hipResourceId);
    return { entity: existing, resource, created: false };
  }

  const reason = `${input.resourceType} required for scenario entity "${input.scenarioKey}"`;
  const action = `create ${input.resourceType}`;

  const form = deps.forms.ensureForm(input.resourceType);
  const blueprint = deps.blueprints.require(input.resourceType);

  const formIssues = validateAgainstForm(form, input.values);
  const blueprintIssues = validateAgainstBlueprint(blueprint, input.values).filter((issue) => issue.severity === 'error');
  const referenceIssues = validateReferences(blueprint, input.values, deps.registry);

  if (formIssues.length || blueprintIssues.length || referenceIssues.length) {
    const issues = issueSummary(formIssues, blueprintIssues, referenceIssues);
    deps.activity.append({ reason, action, tool: 'create_fhir_resource', result: 'error', message: issues.join('; ') });
    throw new PlannerValidationError(`Cannot create ${input.resourceType}: ${issues.join('; ')}`, issues);
  }

  const body = buildFhirResource(input.resourceType, form.fields, input.values, deps.registry);

  let created: Record<string, unknown>;
  try {
    created = await deps.hip.create(input.resourceType, body);
  } catch (error: any) {
    deps.activity.append({ reason, action, tool: 'create_fhir_resource', result: 'error', message: error?.message ?? String(error) });
    throw error;
  }

  const hipId = String(created.id);
  // Read-back validation (spec section 34) - confirms the write actually
  // landed and is queryable, not just that the POST returned 2xx.
  const resource = await deps.hip.get(input.resourceType, hipId);
  const meta = resource.meta as { versionId?: string } | undefined;

  const fieldsWritten = input.fieldsWritten ?? Object.keys(input.values);
  const fieldProvenance = Object.fromEntries(fieldsWritten.map((field) => [field, input.provenance]));
  const entity = deps.registry.upsert(input.scenarioKey, {
    resourceType: input.resourceType,
    hipResourceId: hipId,
    fhirVersionId: meta?.versionId,
    provenance: input.provenance,
    fieldProvenance,
  });

  deps.activity.append({ reason, action, tool: 'create_fhir_resource', result: 'success', message: `${input.resourceType}/${hipId} created` });
  return { entity, resource, created: true };
}

export interface UpdateFhirResourceInput {
  scenarioKey: string;
  values: Record<string, unknown>;
  provenance: Provenance;
}

export interface UpdateFhirResourceResult {
  entity: EntityRecord;
  resource: Record<string, unknown>;
  /** Fields present in `values` that were NOT applied because an
   * equal-or-higher-priority provenance already governed them (spec section
   * 38 - e.g. a GENERATED rescheduling attempt on a field a USER already
   * edited). Never silently dropped without being reported here. */
  refused: string[];
}

/** Edits an already-registered entity in place (spec section 11/37) -
 * fetches the current resource from HIP, re-validates the merged result,
 * PUTs, reads back, and updates the registry's per-field provenance. Any
 * field whose current provenance outranks this call's `provenance` is
 * skipped (never silently overwritten - spec section 38's USER > SOURCE >
 * DERIVED > GENERATED priority). */
export async function updateFhirResourceEntity(deps: PlannerDeps, input: UpdateFhirResourceInput): Promise<UpdateFhirResourceResult> {
  const entity = deps.registry.get(input.scenarioKey);
  if (!entity) throw new Error(`No entity registered for scenario key "${input.scenarioKey}" - nothing to update.`);

  const reason = `Update requested for ${entity.resourceType} "${input.scenarioKey}"`;
  const action = `update ${entity.resourceType}`;

  const refused: string[] = [];
  const applied: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(input.values)) {
    const currentProvenance = entity.fieldProvenance[field] ?? entity.provenance;
    if (mayOverwrite(currentProvenance, input.provenance)) applied[field] = value;
    else refused.push(field);
  }

  const form = deps.forms.ensureForm(entity.resourceType);
  const blueprint = deps.blueprints.require(entity.resourceType);

  // Validate the resulting WHOLE resource (current values merged with this
  // call's applied changes), not just the handful of fields being changed -
  // otherwise every partial edit would spuriously fail every OTHER
  // required field's presence check.
  const existingResource = await deps.hip.get(entity.resourceType, entity.hipResourceId);
  const currentValues = extractFormValues(form.fields, existingResource);
  const mergedValues = { ...currentValues, ...applied };

  const formIssues = validateAgainstForm(form, mergedValues);
  const blueprintIssues = validateAgainstBlueprint(blueprint, mergedValues).filter((issue) => issue.severity === 'error');
  // Reference validation only needs to check fields THIS call is actually
  // setting - an unchanged reference field was already valid when it was
  // first written (or the entity wouldn't exist), and extractFormValues'
  // extracted value for it is a raw FHIR reference string, not a scenario
  // key, which validateReferences isn't meant to interpret.
  const referenceIssues = validateReferences(blueprint, applied, deps.registry);
  if (formIssues.length || blueprintIssues.length || referenceIssues.length) {
    const issues = issueSummary(formIssues, blueprintIssues, referenceIssues);
    deps.activity.append({ reason, action, tool: 'update_fhir_resource', result: 'error', message: issues.join('; ') });
    throw new PlannerValidationError(`Cannot update ${entity.resourceType}: ${issues.join('; ')}`, issues);
  }

  const body = buildFhirResource(entity.resourceType, form.fields, applied, deps.registry, { existingResource });

  try {
    await deps.hip.update(entity.resourceType, entity.hipResourceId, body);
  } catch (error: any) {
    deps.activity.append({ reason, action, tool: 'update_fhir_resource', result: 'error', message: error?.message ?? String(error) });
    throw error;
  }

  const resource = await deps.hip.get(entity.resourceType, entity.hipResourceId);
  const meta = resource.meta as { versionId?: string } | undefined;
  const updatedEntity = deps.registry.upsert(input.scenarioKey, {
    resourceType: entity.resourceType,
    hipResourceId: entity.hipResourceId,
    fhirVersionId: meta?.versionId,
    provenance: entity.provenance,
  });
  deps.registry.setFieldProvenance(input.scenarioKey, Object.fromEntries(Object.keys(applied).map((field) => [field, input.provenance])));

  deps.activity.append({
    reason, action, tool: 'update_fhir_resource', result: 'success',
    message: refused.length
      ? `${entity.resourceType}/${entity.hipResourceId} updated (refused higher-priority fields: ${refused.join(', ')})`
      : `${entity.resourceType}/${entity.hipResourceId} updated`,
  });

  return { entity: updatedEntity, resource, refused };
}
