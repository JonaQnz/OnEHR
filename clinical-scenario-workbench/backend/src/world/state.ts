import type { ActivityEntry } from '../activity/log';
import type { CapabilityRecord } from '../capability/registry';
import type { EntityRecord } from '../entity/registry';
import type { FhirResourceForm } from '../fhir/resourceForm';

/**
 * Spec section 25 - the local World State assembly. Deliberately thin: FHIR
 * resources themselves are NOT duplicated here (they live in HIP - the
 * Entity Registry only holds the reference), matching the spec's own "der
 * lokale World State ist NICHT die zweite fachliche Wahrheit" rule.
 * `patientState`/`scenarioEvents`/`simulationTime` are added once the
 * scenario engine (agent/planner.ts's ensureCapability + scenario/engine.ts)
 * lands - this covers exactly what's built so far (entities/capabilities/
 * forms/activity), still a complete, useful snapshot on its own for the
 * Patient/Encounter vertical slice.
 */
export interface ClinicalWorldState {
  scenarioRunId: string;
  entities: EntityRecord[];
  capabilities: CapabilityRecord[];
  fhirResourceForms: FhirResourceForm[];
  activityLog: ActivityEntry[];
}

export interface WorldStateDeps {
  registry: { list(): EntityRecord[] };
  capabilities: { list(): CapabilityRecord[] };
  forms: { list(): FhirResourceForm[] };
  activity: { list(): ActivityEntry[] };
}

export function getWorldState(scenarioRunId: string, deps: WorldStateDeps): ClinicalWorldState {
  return {
    scenarioRunId,
    entities: deps.registry.list(),
    capabilities: deps.capabilities.list(),
    fhirResourceForms: deps.forms.list(),
    activityLog: deps.activity.list(),
  };
}
