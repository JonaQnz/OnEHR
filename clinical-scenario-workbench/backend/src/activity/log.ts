import crypto from 'node:crypto';
import { readJsonFile, writeJsonFile } from '../world/jsonStore';

/**
 * Spec section 28D / 36 - visible, no-chain-of-thought activity trail: just
 * the clinical/technical reason, the planned action, the tool/operation
 * used, the result, and any error. Every planner step appends exactly one of
 * these, success or failure - this is what the UI's Activity view and a
 * "what actually happened" MCP query both read.
 *
 * `action` conventions worth knowing when filtering (user's own ask - "ich
 * will am Ende auch ein Activitylog von Denken und Gespräch"): `'critique'`
 * is the deterministic critic system (critic/rules.ts); `'thinking'` is a
 * doctor's own reasoning pause (scenario/engine.ts's executeNextEvent, at a
 * genuine "nothing queued, a real decision is needed" or "just handed off,
 * re-review the chart from zero" point - real pauses, not narration);
 * `'conversation'` is a real patient-conversation event
 * (scenario/engine.ts's `case 'patient-conversation'`) - a source of new
 * clinical information distinct from reading the existing chart.
 */
export interface ActivityEntry {
  id: string;
  scenarioRunId: string;
  timestamp: string;
  reason: string;
  action: string;
  tool?: string;
  result: 'success' | 'error';
  message?: string;
}

export class ActivityLog {
  private entries: ActivityEntry[];

  constructor(private readonly dataDir: string, private readonly scenarioRunId: string) {
    this.entries = readJsonFile<ActivityEntry[]>(dataDir, scenarioRunId, 'activity', []);
  }

  list(): ActivityEntry[] {
    return this.entries;
  }

  append(entry: Omit<ActivityEntry, 'id' | 'scenarioRunId' | 'timestamp'>): ActivityEntry {
    const full: ActivityEntry = {
      ...entry,
      id: crypto.randomUUID(),
      scenarioRunId: this.scenarioRunId,
      timestamp: new Date().toISOString(),
    };
    this.entries.push(full);
    writeJsonFile(this.dataDir, this.scenarioRunId, 'activity', this.entries);
    return full;
  }
}
