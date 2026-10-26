import { readJsonFile, writeJsonFile } from './jsonStore';

/**
 * One patient's own real transfer history - which local Location
 * (localLocations.ts) they moved to, and exactly when (a real timestamp,
 * the same moment the causing scenario event actually completed). This is
 * what makes the Klinik view's time-scrubber honest without needing to
 * store a full period-by-period history on a FHIR resource: "where was
 * this patient at time T" is just "the last entry at or before T", derived
 * purely from real, already-recorded transfer moments - never a fabricated
 * position for a time the simulation hasn't actually reached yet.
 */
export interface LocationLogEntry {
  eventId: string;
  locationScenarioKey: string;
  timestamp: string;
  /** "Er bekommt Betten" - which bed within that station, when the scenario
   * author/doctor actually names one (`ward-transfer`'s `data.bed`).
   * Undefined for an ambulant visit or a station that doesn't track beds
   * (e.g. discharge "home"). Local-only, like the station itself. */
  bedLabel?: string;
}

export class LocationLog {
  private entries: LocationLogEntry[];

  constructor(private readonly dataDir: string, private readonly scenarioRunId: string) {
    this.entries = readJsonFile<LocationLogEntry[]>(dataDir, scenarioRunId, 'location-log', []);
  }

  list(): LocationLogEntry[] {
    return this.entries;
  }

  current(): LocationLogEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  /** As-of lookup for the time-scrubber - the latest entry whose timestamp
   * is at or before `asOf`, or undefined if the patient hadn't moved
   * anywhere yet by that point. */
  asOf(asOf: string): LocationLogEntry | undefined {
    let result: LocationLogEntry | undefined;
    for (const entry of this.entries) {
      if (entry.timestamp <= asOf) result = entry;
      else break;
    }
    return result;
  }

  append(eventId: string, locationScenarioKey: string, timestamp: string, bedLabel?: string): LocationLogEntry {
    const entry: LocationLogEntry = { eventId, locationScenarioKey, timestamp, ...(bedLabel ? { bedLabel } : {}) };
    this.entries.push(entry);
    writeJsonFile(this.dataDir, this.scenarioRunId, 'location-log', this.entries);
    return entry;
  }
}
