import type { ResourceBlueprint } from '../fhir/blueprint';

export interface BlueprintValidationIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

/** Spec section 34's "Blueprint Validation" step - OUR simulation
 * requirements, checked against the same flat `Record<field.path, value>`
 * shape Form Validation (fhir/resourceForm.ts's validateAgainstForm) already
 * uses, deliberately kept as a separate pass from it: a Resource Form's own
 * `required` flags can be edited by a user (spec section 12), but the
 * blueprint's `simulationRequired` list is OUR fixed policy for what this
 * workbench needs to function, independent of how a form happens to be
 * configured right now. `simulationRequired` misses are blocking; a missing
 * `recommended` field is only a warning. */
export function validateAgainstBlueprint(blueprint: ResourceBlueprint, values: Record<string, unknown>): BlueprintValidationIssue[] {
  const issues: BlueprintValidationIssue[] = [];
  const isEmpty = (value: unknown) => value === undefined || value === null || value === '';
  for (const field of blueprint.simulationRequired) {
    if (isEmpty(values[field])) {
      issues.push({ field, message: `"${field}" is required by this workbench's own simulation policy for ${blueprint.resourceType}.`, severity: 'error' });
    }
  }
  for (const field of blueprint.recommended) {
    if (isEmpty(values[field])) {
      issues.push({ field, message: `"${field}" is recommended for ${blueprint.resourceType} but not set.`, severity: 'warning' });
    }
  }
  return issues;
}
