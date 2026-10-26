import type { EntityRecord, EntityRegistryLike } from './registry';
import type { Provenance } from '../types';

/**
 * A patient-scoped entity (a Slot/Appointment for THIS visit) can reference
 * a clinic-scoped one (a standing Schedule/HealthcareService) that lives in
 * a different EntityRegistry entirely (see context.ts's CLINIC_NAMESPACE -
 * "the clinic" is shared/accumulating across every scenario run, never
 * re-created per patient, per the user's own correction). Reads fall
 * through primary (the current run) to fallback (the shared clinic) so
 * fhir/resourceFactory.ts's reference resolution finds either kind of
 * target transparently; writes always land in `primary` - this workbench
 * never wants a per-patient ensureFhirResource call to accidentally mutate
 * shared clinic state.
 */
export class FallbackEntityRegistry implements EntityRegistryLike {
  constructor(private readonly primary: EntityRegistryLike, private readonly fallback: EntityRegistryLike) {}

  get(scenarioKey: string): EntityRecord | undefined {
    return this.primary.get(scenarioKey) ?? this.fallback.get(scenarioKey);
  }

  has(scenarioKey: string): boolean {
    return this.primary.has(scenarioKey) || this.fallback.has(scenarioKey);
  }

  list(): EntityRecord[] {
    const primaryKeys = new Set(this.primary.list().map((record) => record.scenarioKey));
    return [...this.primary.list(), ...this.fallback.list().filter((record) => !primaryKeys.has(record.scenarioKey))];
  }

  listByType(resourceType: string): EntityRecord[] {
    return this.list().filter((record) => record.resourceType === resourceType);
  }

  upsert(scenarioKey: string, patch: Parameters<EntityRegistryLike['upsert']>[1]): EntityRecord {
    return this.primary.upsert(scenarioKey, patch);
  }

  setFieldProvenance(scenarioKey: string, fields: Record<string, Provenance>): EntityRecord {
    return (this.primary.has(scenarioKey) ? this.primary : this.fallback).setFieldProvenance(scenarioKey, fields);
  }
}
