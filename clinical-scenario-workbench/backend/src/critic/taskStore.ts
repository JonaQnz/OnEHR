import { readJsonFile, writeJsonFile } from '../world/jsonStore';

/**
 * The "und daraus Tasks erstellen" half of the critic system. A real FHIR
 * `Task` resource would be the honest way to model this - but live-probed
 * (create_fhir_resource against this exact HIP tenant) and confirmed it
 * hits the SAME "No mapping found" gap already known from `Location`/
 * `Organization`/`Procedure`/`DiagnosticReport`. Per the same precedent
 * (`world/localLocations.ts`'s own doc comment - "leg das einfach lokal an,
 * dann ist das eben kein FHIR"), Tasks are a small, per-run local JSON
 * store instead - never written into a real FHIR resource, and never
 * claimed to be one.
 */
export interface CritiqueTaskRecord {
  /** `${code}:${anchorEventId}` - stable across a re-play of the identical
   * scenario, so `ensure()` is idempotent per finding, not per call. */
  id: string;
  code: string;
  description: string;
  anchorEventId: string;
  status: 'open' | 'resolved';
  createdAt: string;
  resolvedAt?: string;
  /** 'critic' (default) - a deterministic critic/rules.ts finding, eligible
   * for `resolveStale`'s own automatic reconciliation. 'manual' - filed by
   * a human/agent directly (request_missing_form, report_system_critique -
   * mcp/tools/*.ts), NEVER auto-resolved: a real bug found live wiring
   * pregnancy-status - `resolveStale` was reconciling against
   * `critiqueScenario`'s own code set, so a manually-filed task whose code
   * (e.g. "missing-form") that function never produces got silently marked
   * resolved on the very next Step regardless of whether anything was
   * actually fixed. */
  source: 'critic' | 'manual';
}

type StoreFile = Record<string, CritiqueTaskRecord>;

export class TaskStore {
  private tasks: StoreFile;

  constructor(private readonly dataDir: string, private readonly scenarioRunId: string) {
    this.tasks = readJsonFile<StoreFile>(dataDir, scenarioRunId, 'tasks', {});
  }

  list(): CritiqueTaskRecord[] {
    return Object.values(this.tasks).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Idempotent - the first time a given finding fires it's recorded and
   * returned; a later call for the same id (e.g. a `Step` retried after a
   * transient failure) returns the already-recorded one unchanged. A
   * previously-resolved task whose finding genuinely came back true (rare,
   * but possible for a dynamically-growing scenario - see `resolveStale`'s
   * own doc comment) is reopened rather than left resolved. */
  ensure(input: { id: string; code: string; description: string; anchorEventId: string; source?: 'critic' | 'manual' }): { record: CritiqueTaskRecord; created: boolean } {
    const existing = this.tasks[input.id];
    if (existing && existing.status === 'open') return { record: existing, created: false };
    const record: CritiqueTaskRecord = { ...input, source: input.source ?? 'critic', status: 'open', createdAt: existing?.createdAt ?? new Date().toISOString() };
    this.tasks[input.id] = record;
    writeJsonFile(this.dataDir, this.scenarioRunId, 'tasks', this.tasks);
    return { record, created: !existing };
  }

  /** Explicitly resolves one manually-filed task by id (e.g. once the
   * capability it was about now actually exists) - the counterpart to
   * `resolveStale`'s automatic reconciliation, which deliberately never
   * touches a 'manual' task. A no-op if the task is unknown or already
   * resolved. */
  resolve(id: string): CritiqueTaskRecord | undefined {
    const task = this.tasks[id];
    if (!task || task.status === 'resolved') return task;
    task.status = 'resolved';
    task.resolvedAt = new Date().toISOString();
    writeJsonFile(this.dataDir, this.scenarioRunId, 'tasks', this.tasks);
    return task;
  }

  /** For a scenario whose event list can grow AFTER some events already
   * completed (scenario/dynamicEvents.ts's "eigener Agent als Arzt" case),
   * a finding that was genuinely true when first checked (e.g. "no
   * discharge letter yet" - true right after the very first two events)
   * can become false once a later, real event closes it (a real
   * discharge-letter event gets appended and executed) - `critiqueScenario`
   * itself is a pure, always-fresh recomputation, but a plain write-once
   * `ensure()` would leave that now-stale Task open forever. Called once
   * per Step with every code the CURRENT critique run actually produced
   * for an already-completed anchor - any still-open Task whose code is
   * NOT in that set no longer reflects reality and gets marked resolved. */
  resolveStale(currentCodes: ReadonlySet<string>): void {
    let changed = false;
    for (const task of Object.values(this.tasks)) {
      if (task.source === 'manual') continue;
      if (task.status === 'open' && !currentCodes.has(task.code)) {
        task.status = 'resolved';
        task.resolvedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) writeJsonFile(this.dataDir, this.scenarioRunId, 'tasks', this.tasks);
  }
}
