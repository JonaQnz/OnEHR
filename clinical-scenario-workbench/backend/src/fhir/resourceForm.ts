import type { Provenance } from '../types';

/** Spec section 9 - deliberately small, not a second Form Builder. One of
 * these exists per FHIR resource type actually used in a scenario; the SAME
 * definition drives the UI's ResourceFormRenderer and the MCP
 * create_fhir_resource/update_fhir_resource tools (spec section 10 - no
 * separate "UI path" vs "agent path"). */
export interface FhirResourceForm {
  id: string;
  resourceType: string;
  version: number;
  fields: FhirFormField[];
  createdBy: 'system' | 'agent' | 'user';
  editable: boolean;
}

export type FhirFieldType = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'select' | 'reference' | 'code';

/** sourcePolicy says where a field's value is EXPECTED to come from when the
 * planner auto-fills it - not a hard access-control rule (a user can still
 * edit any `editable` field). 'scenario' -> filled straight from
 * ScenarioEvent facts (provenance SOURCE); 'derived' -> computed
 * deterministically from other already-known facts (provenance DERIVED);
 * 'generated' -> the one category agent/generate.ts's narrow LLM-fill step
 * is allowed to touch (provenance GENERATED); 'user' -> never auto-filled at
 * all, left blank until a person enters it. */
export type FhirFieldSourcePolicy = 'scenario' | 'derived' | 'generated' | 'user';

export interface FhirFormFieldOption {
  value: string;
  label: string;
}

export interface FhirFormField {
  /** A dot/bracket path into the FHIR resource, e.g. "name.0.family",
   * "participant.0.actor.reference". Kept as a flat string (not a nested
   * schema) - simple enough for the small resource shapes this workbench
   * actually produces, per spec section 9's "don't overengineer". */
  path: string;
  label: string;
  type: FhirFieldType;
  required: boolean;
  editable: boolean;
  sourcePolicy: FhirFieldSourcePolicy;
  referenceResourceTypes?: string[];
  options?: FhirFormFieldOption[];
}

export const SOURCE_POLICY_PROVENANCE: Record<FhirFieldSourcePolicy, Provenance> = {
  scenario: 'SOURCE',
  derived: 'DERIVED',
  generated: 'GENERATED',
  user: 'USER',
};

export interface FhirFormValidationIssue {
  path: string;
  message: string;
}

/** Required-field + basic type-shape checks (spec section 34's "Form
 * Validation" step) - Blueprint-level checks (simulationRequired,
 * references) are a separate pass, see validation/blueprintValidation.ts,
 * since a Resource Form can be broader or narrower than our own blueprint
 * and the two failure kinds are reported separately in the Activity log. */
export function validateAgainstForm(form: FhirResourceForm, values: Record<string, unknown>): FhirFormValidationIssue[] {
  const issues: FhirFormValidationIssue[] = [];
  for (const field of form.fields) {
    const value = values[field.path];
    const isEmpty = value === undefined || value === null || value === '';
    if (field.required && isEmpty) {
      issues.push({ path: field.path, message: `${field.label} is required.` });
      continue;
    }
    if (isEmpty) continue;
    if (field.type === 'number' && typeof value !== 'number') {
      issues.push({ path: field.path, message: `${field.label} must be a number.` });
    }
    if (field.type === 'boolean' && typeof value !== 'boolean') {
      issues.push({ path: field.path, message: `${field.label} must be a boolean.` });
    }
    if (field.type === 'select' && field.options && !field.options.some((option) => option.value === value)) {
      issues.push({ path: field.path, message: `${field.label} must be one of the configured options.` });
    }
  }
  return issues;
}
