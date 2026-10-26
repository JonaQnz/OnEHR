import { readJsonFile, writeJsonFile } from '../world/jsonStore';

export interface ScenarioProgress {
  scenarioId: string;
  completedEventIds: string[];
  patientScenarioKey?: string;
  /** Which facility (context.ts's FacilityRegistry) this run belongs to -
   * set once at run creation from the scenario file's own `facilityId`.
   * Optional because progress files saved before multi-facility support
   * existed won't have it - every reader falls back to
   * `DEFAULT_FACILITY_ID`. */
  facilityId?: string;
  /** When each event actually completed (ISO timestamp), keyed by event id -
   * the Timeline view's own real clock, independent of the scenario
   * definition's purely descriptive `event.at` offset. Optional because
   * progress files saved before this field existed won't have it. */
  completedAt?: Record<string, string>;
}

export class ScenarioProgressStore {
  private progress: ScenarioProgress;

  constructor(private readonly dataDir: string, private readonly scenarioRunId: string, scenarioId: string) {
    this.progress = readJsonFile<ScenarioProgress>(dataDir, scenarioRunId, 'progress', { scenarioId, completedEventIds: [] });
  }

  get(): ScenarioProgress {
    return this.progress;
  }

  save(progress: ScenarioProgress): void {
    this.progress = progress;
    writeJsonFile(this.dataDir, this.scenarioRunId, 'progress', progress);
  }
}
