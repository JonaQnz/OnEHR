import type { FormbuilderApiClient } from '../apiClient';
import type { ActivityLog } from '../activity/log';
import type { EntityRegistryLike } from '../entity/registry';
import type { Provenance } from '../types';

export interface EnsureScenarioPatientInput {
  scenarioKey: string;
  patientId: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  gender: string;
  provenance: Provenance;
}

export interface EnsureScenarioPatientResult {
  formsPatientId: string;
  ehrId: string;
  fhirPatientId?: string;
  created: boolean;
}

/**
 * Patient is the one resource type this workbench creates through Forms'
 * own native onboarding endpoint (POST /api/patients,
 * apps/api/src/services/patientService.ts's createPatient) rather than the
 * generic FHIR CDR passthrough every other resource type uses
 * (fhirHip/resourceClient.ts) - live-verified: only that endpoint actually
 * links a real openEHR EHR to the resulting FHIR Patient, and every openEHR
 * capability this workbench uses (openehr/capabilityBridge.ts) needs that
 * link to address the patient at all. A Patient created through the generic
 * route alone would be a real, valid FHIR resource with no EHR behind it -
 * useless for anything openEHR.
 *
 * Still idempotent per scenarioKey and Activity-logged like every other
 * ensure* function here - just a different underlying HIP call, not a
 * different pattern.
 *
 * `personFormValues` targets this Forms deployment's currently-configured
 * Person Form Section directly (vg_Person.v1.1.1, id
 * 66f056d4-de67-4650-8732-0b131a5152b1, confirmed via
 * get_patient_creation_configuration) - tied to this specific instance's
 * configuration, unlike the generic Resource Form/Blueprint system the rest
 * of this workbench uses for every other resource type. Documented here as
 * a deliberate, known exception rather than hidden inside the generic path.
 */
export async function ensureScenarioPatient(
  deps: { api: FormbuilderApiClient; registry: EntityRegistryLike; activity: ActivityLog },
  input: EnsureScenarioPatientInput,
): Promise<EnsureScenarioPatientResult> {
  const existing = deps.registry.get(input.scenarioKey);
  if (existing) {
    if (existing.resourceType !== 'Patient' || !existing.ehrId || !existing.formsPatientId) {
      throw new Error(`Scenario key "${input.scenarioKey}" is already registered but not as a fully-linked Patient.`);
    }
    return { formsPatientId: existing.formsPatientId, ehrId: existing.ehrId, fhirPatientId: existing.hipResourceId, created: false };
  }

  const reason = `Patient required for scenario entity "${input.scenarioKey}"`;
  const action = 'create Patient';

  let response: { patient: { id: string; ehrId: string; fhirPatientId?: string } };
  try {
    response = await deps.api.post('/api/patients', {
      patientId: input.patientId,
      firstName: input.firstName,
      lastName: input.lastName,
      birthDate: input.birthDate,
      gender: input.gender,
      personFormValues: {
        'vg_person.v1.1.1_namensart': 'official',
        'vg_person.v1.1.1_vorname': [input.firstName],
        'vg_person.v1.1.1_familienname': input.lastName,
        'vg_person.v1.1.1_administratives_geschlecht': input.gender,
        'vg_person.v1.1.1_geburtsdatum': input.birthDate,
        'vg_person.v1.1.1_vitalstatus': 'L',
      },
    });
  } catch (error: any) {
    deps.activity.append({ reason, action, tool: 'create_patient', result: 'error', message: error?.message ?? String(error) });
    throw error;
  }

  const { id: formsPatientId, ehrId, fhirPatientId } = response.patient;
  deps.registry.upsert(input.scenarioKey, {
    resourceType: 'Patient',
    hipResourceId: fhirPatientId ?? formsPatientId,
    ehrId,
    formsPatientId,
    provenance: input.provenance,
    fieldProvenance: {
      firstName: input.provenance, lastName: input.provenance, gender: input.provenance, birthDate: input.provenance,
    },
  });
  deps.activity.append({ reason, action, tool: 'create_patient', result: 'success', message: `Patient ${formsPatientId} created (ehrId ${ehrId})` });

  return { formsPatientId, ehrId, fhirPatientId, created: true };
}
