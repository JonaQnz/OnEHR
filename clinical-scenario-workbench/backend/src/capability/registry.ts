import { readJsonFile, writeJsonFile } from '../world/jsonStore';

/**
 * Spec section 23 - the Agent thinks primarily in capabilities ("I need
 * ct-imaging"), not individual resources. This records what a capability
 * currently resolves to, once ensured: for an openEHR capability, the Form
 * Section id used; for a FHIR capability chain, the scenario keys of the
 * resources that back it (role -> scenario key, e.g. { healthcareService:
 * "service-ct-imaging", schedule: "schedule-ct-today" }) - resolve the
 * actual HIP resource ids for those via the Entity Registry, never
 * duplicated here.
 */
export interface CapabilityRecord {
  capability: string;
  kind: 'fhir' | 'openEHR';
  resourceRefs?: Record<string, string>;
  /** openEHR only - the Form Section id filled for this capability. */
  formId?: string;
  /** openEHR only - the Composition-kind Form this capability's Form
   * Section is embedded in, and the block id within it - both needed to
   * re-launch a read-only view of the same Composition later
   * (openehr/capabilityBridge.ts's viewEmbedUrl). */
  compositionFormId?: string;
  blockId?: string;
  /** openEHR only - which patient this specific ensure-call was for. */
  patientScenarioKey?: string;
  /** openEHR only - the most recent runtime session pair
   * (openehr/capabilityBridge.ts), enough to re-embed the same Composition
   * read-only later (spec's own §28B/§29 "look at this data" views). For a
   * repeatable capability (e.g. vital-signs, forceNewComposition: true) this
   * only ever holds the LATEST instance - a full history view is a later
   * addition, not needed for the initial viewer. */
  compositionSessionId?: string;
  formSessionId?: string;
  providerReference?: string;
  scenarioRunId: string;
  createdAt: string;
  updatedAt: string;
}

type RegistryFile = Record<string, CapabilityRecord>;

export class CapabilityRegistry {
  private records: RegistryFile;

  constructor(private readonly dataDir: string, private readonly scenarioRunId: string) {
    this.records = readJsonFile<RegistryFile>(dataDir, scenarioRunId, 'capabilities', {});
  }

  get(capability: string): CapabilityRecord | undefined {
    return this.records[capability];
  }

  has(capability: string): boolean {
    return capability in this.records;
  }

  list(): CapabilityRecord[] {
    return Object.values(this.records);
  }

  upsert(capability: string, patch: Omit<CapabilityRecord, 'capability' | 'scenarioRunId' | 'createdAt' | 'updatedAt'>): CapabilityRecord {
    const now = new Date().toISOString();
    const existing = this.records[capability];
    const record: CapabilityRecord = {
      ...existing,
      ...patch,
      capability,
      scenarioRunId: this.scenarioRunId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.records[capability] = record;
    this.save();
    return record;
  }

  private save(): void {
    writeJsonFile(this.dataDir, this.scenarioRunId, 'capabilities', this.records);
  }
}
