import prisma from '../db/prisma';
import { getFormFhirMapping, migrateCanonicalFormToV1 } from 'core';
import { searchFhirResource } from './fhirCdrService';
import { EhrbaseDataProvider, type LatestCompositionContext } from './ehrbaseDataProvider';

/**
 * Verifies (never writes) that a Form's submitted data made it into HIP's
 * FHIR CDR as the expected resource type - HIP itself converts a committed
 * openEHR Composition into FHIR server-side (see fhirCdrService.ts's own
 * doc comment on the Patient/Encounter-vs-clinical-templates split), so
 * Forms' job here is only to search for and display what landed, not to
 * author it. Powers FormBuilder.tsx's "FHIR Debug" tab: a manual "Jetzt
 * prüfen" click, and an automatic fire-and-forget check right after a real
 * submit (see formSessionService.ts's submitFormSessionToProvider). See
 * docs/features/fhir-debug.md.
 */
export type FhirVerificationResult =
  // The form has no FORM_FHIR_MAPPING_EXTENSION_KEY set - not an error,
  // most forms don't have one (yet).
  | { status: 'unmapped' }
  // The form is mapped, but this patient has no fhirPatientId on file
  // (patientService.createPatient only sets one for HIP/'fhir'-mode
  // connections) - nothing meaningful to search by.
  | { status: 'no-fhir-patient' }
  | { status: 'ok'; resourceType: string; bundle: unknown; composition?: LatestCompositionContext };

export async function verifyFhirForSubmission(
  formId: string,
  ehrId: string,
  options: { sessionId?: string; operation?: string } = {},
): Promise<FhirVerificationResult> {
  const stored = await prisma.form.findUnique({ where: { id: formId } });
  if (!stored) return { status: 'unmapped' };
  const definition = migrateCanonicalFormToV1({ ...(stored.canonical_json as any), id: stored.id }, stored.id);
  const mapping = getFormFhirMapping(definition);
  if (!mapping) return { status: 'unmapped' };

  const patient = await prisma.patient.findUnique({ where: { ehrId }, select: { patientId: true, fhirPatientId: true } });
  if (!patient?.fhirPatientId) return { status: 'no-fhir-patient' };

  const bundle = await searchFhirResource(
    mapping.resourceType,
    { patient: patient.fhirPatientId, _sort: '-_lastUpdated', _count: '5', ...(mapping.searchParams || {}) },
    { ehrId, patientId: patient.patientId, formId, ...(options.sessionId ? { sessionId: options.sessionId } : {}), operation: options.operation || 'verify' },
  );

  // Best-effort - the FHIR search above is the actual point of this call;
  // a composition-context failure (template rename, EHRbase hiccup, ...)
  // must never hide an otherwise-successful FHIR verification result.
  let composition: LatestCompositionContext | undefined;
  try {
    composition = await new EhrbaseDataProvider().loadLatestCompositionContext({
      context: {
        mode: 'view', patientId: patient.patientId, ehrId,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      },
      form: { id: stored.id, version: stored.version, definition },
    });
  } catch (error) {
    console.warn('[fhirVerificationService] Could not load composition context alongside FHIR verification:', error instanceof Error ? error.message : error);
  }

  return { status: 'ok', resourceType: mapping.resourceType, bundle, ...(composition ? { composition } : {}) };
}
