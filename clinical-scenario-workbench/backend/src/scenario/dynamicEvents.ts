import { readJsonFile, writeJsonFile } from '../world/jsonStore';
import type { ScenarioEvent } from './types';

/**
 * User's ask: a real interactive simulation - a patient presents with only
 * a chief complaint (no diagnosis known upfront), and an "AI Arzt" (a real
 * agent, not a pre-authored YAML timeline) decides each next step live -
 * order labs, admit vs. discharge, ambulant vs. stationär, hourly rounds -
 * based on whatever's actually been recorded in the chart so far. A
 * pre-expanded, deterministic event list (protocol.ts's `expandScenario`)
 * cannot represent this: the FUTURE of the case genuinely isn't known until
 * a real decision gets made.
 *
 * Rather than reworking the whole engine to "pause mid-expansion", the
 * scenario file for an open-ended case stays minimal (patient + the very
 * first `patient-arrival`) and every event after that is appended here, ONE
 * AT A TIME, by whoever is acting as the doctor (a human, or an assistant
 * like Claude reviewing the real chart through this workbench's own read
 * endpoints) - reusing the exact same `ScenarioEngineDeps.executeEvent`
 * switch every other event type already goes through, so a live decision
 * writes exactly the same kind of real FHIR/openEHR record a pre-scripted
 * one would. `loader.ts`'s `loadScenarioForRun` merges these in after the
 * static file's own events - a scenario that never appends anything (every
 * existing scenario file) behaves byte-for-byte as before.
 */
export class DynamicEventsStore {
  private events: ScenarioEvent[];

  constructor(private readonly dataDir: string, private readonly scenarioRunId: string) {
    this.events = readJsonFile<ScenarioEvent[]>(dataDir, scenarioRunId, 'dynamic-events', []);
  }

  list(): ScenarioEvent[] {
    return this.events;
  }

  /** Appends one real event to this run's own tail - fails loudly on a
   * duplicate id (across BOTH the static file and any earlier dynamic
   * append) rather than silently overwriting, since an id collision here
   * almost certainly means the caller lost track of what it already did. */
  append(event: ScenarioEvent, existingIds: ReadonlySet<string>): ScenarioEvent {
    if (existingIds.has(event.id)) throw new Error(`Event id "${event.id}" already exists on this scenario run.`);
    this.events.push(event);
    writeJsonFile(this.dataDir, this.scenarioRunId, 'dynamic-events', this.events);
    return event;
  }
}
