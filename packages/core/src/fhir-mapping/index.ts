import type { CanonicalForm } from '../canonical';

/**
 * Which FHIR resource a Form Section's submitted data should show up as on
 * the FHIR CDR - set by a designer via the FormBuilder "FHIR Debug" tab.
 * HIP itself converts a committed openEHR Composition into FHIR server-side
 * (see apps/api/src/services/fhirCdrService.ts's own doc comment); this key
 * only records *what to search for* to verify that conversion landed, it
 * never drives a write - Forms itself never authors these resources.
 */
export const FORM_FHIR_MAPPING_EXTENSION_KEY = 'formbuilder.fhir-mapping' as const;

export interface FormFhirMapping {
  /** e.g. "ServiceRequest", "Procedure", "Observation", "MedicationRequest". */
  resourceType: string;
  /** Extra FHIR search parameters beyond `patient=<fhirPatientId>`, e.g. { code: '...' }. */
  searchParams?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `null` when the form has no FHIR mapping configured yet - not an error,
 * most forms don't have one. */
export function getFormFhirMapping(
  form: Pick<CanonicalForm, 'layout'> & { extensions?: Record<string, unknown> },
): FormFhirMapping | null {
  const raw = form.extensions?.[FORM_FHIR_MAPPING_EXTENSION_KEY];
  if (!isRecord(raw) || typeof raw.resourceType !== 'string' || !raw.resourceType.trim()) return null;
  const searchParams = isRecord(raw.searchParams)
    ? Object.fromEntries(Object.entries(raw.searchParams).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined;
  return {
    resourceType: raw.resourceType.trim(),
    ...(searchParams && Object.keys(searchParams).length > 0 ? { searchParams } : {}),
  };
}
