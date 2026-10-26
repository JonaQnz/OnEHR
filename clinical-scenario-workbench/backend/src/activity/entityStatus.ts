import { readJsonFile, writeJsonFile } from '../world/jsonStore';

/**
 * Visual-sim groundwork (user's own ask - "prepare further to make it a UI
 * visual simulation hospital with people running around and working and
 * thinking"), scoped to data model + a UI-ready state feed this pass, NOT
 * the animated frontend itself. One current status per scenarioKey
 * (typically a patient, but nothing stops a staff scenarioKey from having
 * one too), set at real call sites in scenario/engine.ts - never a UI
 * mockup value.
 *
 * Per-run, same JSON-store shape/style as `activity/log.ts`/
 * `world/locationLog.ts` - a status is a fact about ONE scenario run's own
 * simulated moment, not clinic-wide state.
 */
export type EntityActivityStatus = 'idle' | 'thinking' | 'filling-form' | 'blocked-needs-form' | 'moving' | 'talking';

export interface EntityStatusRecord {
  scenarioKey: string;
  status: EntityActivityStatus;
  /** Short human-readable reason, e.g. the event id/type being filled, or
   * the capability name a "blocked-needs-form" status is waiting on. */
  reason?: string;
  updatedAt: string;
}

type StoreFile = Record<string, EntityStatusRecord>;

export class EntityStatusStore {
  private records: StoreFile;

  constructor(private readonly dataDir: string, private readonly scenarioRunId: string) {
    this.records = readJsonFile<StoreFile>(dataDir, scenarioRunId, 'entity-status', {});
  }

  get(scenarioKey: string): EntityStatusRecord | undefined {
    return this.records[scenarioKey];
  }

  list(): EntityStatusRecord[] {
    return Object.values(this.records);
  }

  set(scenarioKey: string, status: EntityActivityStatus, reason?: string): EntityStatusRecord {
    const record: EntityStatusRecord = { scenarioKey, status, reason, updatedAt: new Date().toISOString() };
    this.records[scenarioKey] = record;
    writeJsonFile(this.dataDir, this.scenarioRunId, 'entity-status', this.records);
    return record;
  }
}
