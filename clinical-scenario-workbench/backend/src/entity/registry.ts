import { readJsonFile, writeJsonFile } from '../world/jsonStore';
import type { Provenance } from '../types';

/**
 * Maps a stable scenario key (e.g. "patient-maria", "appointment-ctpa-001")
 * to the real HIP resource it became - spec section 24. FHIR references are
 * always built from THIS registry, never from a free-form LLM string: the
 * planner resolves "the patient" to `entityRegistry.get('patient-maria')`
 * and only then writes `Patient/<hipResourceId>` into a dependent resource.
 */
export interface EntityRecord {
  scenarioKey: string;
  resourceType: string;
  hipResourceId: string;
  /** FHIR resources only - the openEHR analog (a Composition/session) has no
   * single "resource id" the same way; see `ehrbaseCompositionUid` instead. */
  fhirVersionId?: string;
  /** Patient entities only - the linked openEHR EHR id (agent/patientBridge.ts's
   * ensureScenarioPatient is the only writer of this) and Forms' own
   * internal Patient record id, both needed to address this patient in
   * openehr/capabilityBridge.ts's composition-session calls (which accept
   * the internal id, the ehrId, or an external MRN interchangeably). */
  ehrId?: string;
  formsPatientId?: string;
  /** openEHR only - the committed Composition's own versioned uid, when this
   * entity represents an openEHR capability rather than a FHIR resource. */
  ehrbaseCompositionUid?: string;
  provenance: Provenance;
  /** Per-field provenance override (spec section 7/37/38: a single edited
   * field, e.g. an Appointment's `start`, can carry a different, higher-
   * priority provenance than the rest of the same resource). A field with no
   * entry here is governed by the entity-level `provenance` above. */
  fieldProvenance: Record<string, Provenance>;
  scenarioRunId: string;
  createdAt: string;
  updatedAt: string;
}

type RegistryFile = Record<string, EntityRecord>;

/** The public shape both `EntityRegistry` and `FallbackEntityRegistry`
 * (entity/fallbackRegistry.ts) satisfy - every consumer (agent/planner.ts,
 * fhir/resourceFactory.ts, validation/referenceValidation.ts) depends on
 * this interface, not the concrete `EntityRegistry` class, precisely so a
 * patient-scoped ensure* call can be given a registry that transparently
 * falls through to the shared clinic registry for reference resolution. */
export interface EntityRegistryLike {
  get(scenarioKey: string): EntityRecord | undefined;
  has(scenarioKey: string): boolean;
  list(): EntityRecord[];
  listByType(resourceType: string): EntityRecord[];
  upsert(
    scenarioKey: string,
    patch: Omit<EntityRecord, 'scenarioKey' | 'scenarioRunId' | 'createdAt' | 'updatedAt' | 'fieldProvenance'> & { fieldProvenance?: Record<string, Provenance> },
  ): EntityRecord;
  setFieldProvenance(scenarioKey: string, fields: Record<string, Provenance>): EntityRecord;
}

export class EntityRegistry implements EntityRegistryLike {
  private records: RegistryFile;

  constructor(private readonly dataDir: string, private readonly scenarioRunId: string) {
    this.records = readJsonFile<RegistryFile>(dataDir, scenarioRunId, 'entities', {});
  }

  get(scenarioKey: string): EntityRecord | undefined {
    return this.records[scenarioKey];
  }

  has(scenarioKey: string): boolean {
    return scenarioKey in this.records;
  }

  list(): EntityRecord[] {
    return Object.values(this.records);
  }

  listByType(resourceType: string): EntityRecord[] {
    return this.list().filter((record) => record.resourceType === resourceType);
  }

  /** Registers a brand-new entity or updates an existing one's resource
   * reference (e.g. after a HIP update round-trip bumped its version) -
   * never silently drops fields the caller didn't pass. `fieldProvenance`
   * defaults to the existing record's own (or `{}` for a new one) since most
   * callers only ever touch it via `setFieldProvenance` below, not here. */
  upsert(
    scenarioKey: string,
    patch: Omit<EntityRecord, 'scenarioKey' | 'scenarioRunId' | 'createdAt' | 'updatedAt' | 'fieldProvenance'> & { fieldProvenance?: Record<string, Provenance> },
  ): EntityRecord {
    const now = new Date().toISOString();
    const existing = this.records[scenarioKey];
    const record: EntityRecord = {
      ...existing,
      ...patch,
      fieldProvenance: patch.fieldProvenance ?? existing?.fieldProvenance ?? {},
      scenarioKey,
      scenarioRunId: this.scenarioRunId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.records[scenarioKey] = record;
    this.save();
    return record;
  }

  /** Merges `fields` into an existing entity's per-field provenance map
   * (spec section 7 - each field written gets its own SOURCE/DERIVED/
   * GENERATED/USER tag) without touching anything else about the record. */
  setFieldProvenance(scenarioKey: string, fields: Record<string, Provenance>): EntityRecord {
    const existing = this.records[scenarioKey];
    if (!existing) throw new Error(`No entity registered for scenario key "${scenarioKey}".`);
    existing.fieldProvenance = { ...existing.fieldProvenance, ...fields };
    existing.updatedAt = new Date().toISOString();
    this.save();
    return existing;
  }

  private save(): void {
    writeJsonFile(this.dataDir, this.scenarioRunId, 'entities', this.records);
  }
}
