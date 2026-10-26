import type { ResourceBlueprint } from '../fhir/blueprint';
import type { EntityRegistryLike } from '../entity/registry';

export interface ReferenceValidationIssue {
  field: string;
  message: string;
}

/**
 * Spec section 34's "Reference Validation" step, and section 24's rule that
 * "FHIR-Referenzen niemals durch freie LLM-Strings erzeugen": a `reference`
 * field's VALUE, throughout this workbench's own values/forms, is always a
 * scenario key (e.g. "patient-maria"), never a raw `Patient/<id>` string -
 * only the FHIR Factory resolves a scenario key to a real reference right
 * before writing to HIP (fhir/resourceFactory.ts). This validates that every
 * `references` entry the blueprint declares (spec section 13's `references`
 * map) actually resolves to a registered entity of one of the allowed target
 * resource types.
 */
export function validateReferences(
  blueprint: ResourceBlueprint,
  values: Record<string, unknown>,
  registry: EntityRegistryLike,
): ReferenceValidationIssue[] {
  const issues: ReferenceValidationIssue[] = [];
  for (const [field, reference] of Object.entries(blueprint.references)) {
    const scenarioKey = values[field];
    if (scenarioKey === undefined || scenarioKey === null || scenarioKey === '') continue; // required-ness is Form/Blueprint Validation's job, not this pass's
    if (typeof scenarioKey !== 'string') {
      issues.push({ field, message: `"${field}" must be a scenario entity key (string), got ${typeof scenarioKey}.` });
      continue;
    }
    const entity = registry.get(scenarioKey);
    if (!entity) {
      issues.push({ field, message: `"${field}" references scenario key "${scenarioKey}", which has no registered entity yet.` });
      continue;
    }
    if (!reference.target.includes(entity.resourceType)) {
      issues.push({
        field,
        message: `"${field}" must reference one of [${reference.target.join(', ')}], but "${scenarioKey}" is a ${entity.resourceType}.`,
      });
    }
  }
  return issues;
}
