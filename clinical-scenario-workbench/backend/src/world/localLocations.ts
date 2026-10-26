import { readJsonFile, writeJsonFile } from './jsonStore';

/**
 * User's explicit call (after a real platform limitation was found live -
 * this HIP tenant has no FHIR resource-type mapping configured for
 * `Location`/`Organization` at all): "leg das einfach lokal an, dann ist
 * das eben kein FHIR" - a small, deliberately NOT-FHIR roster of wards the
 * patient's journey moves through, purely local to this workbench. Clinic-
 * level, same sharing shape as `ResourceFormStore`/`HealthcareService` -
 * one small shared roster, never invented per patient. Never written into
 * a real FHIR resource (an Encounter never gets a reference to one of
 * these - that would be a broken/unresolvable reference on the real HIP,
 * which is worse than not having the data at all).
 *
 * User's follow-up correction: the Klinik view was too patient-centric - a
 * Station should be the primary, data-rich thing, with staff hanging off
 * it and patients as the last, least-emphasized link. `description` is the
 * "Station mit Daten" ask (a short real-world blurb, not just a bare
 * name); `staffScenarioKeys` is who works there - real Practitioner FHIR
 * entities (that resource type DOES work on this tenant, unlike Location
 * itself), resolved through the normal Entity Registry, only the
 * ASSOCIATION "this Practitioner belongs to this Station" is local.
 */
export interface LocalLocation {
  scenarioKey: string;
  name: string;
  description: string;
  staffScenarioKeys: string[];
  createdAt: string;
  /** Visual-sim groundwork - an optional grid position, so a future
   * floor-plan view has something to lay stations out against without
   * inventing a new store. Additive/optional: absent for every station
   * ensured before this field existed, and for any not yet explicitly
   * placed. Set via `setPosition` below, never inferred. */
  position?: { x: number; y: number };
}

type StoreFile = Record<string, LocalLocation>;

export class LocalLocationRegistry {
  private locations: StoreFile;

  constructor(private readonly dataDir: string, private readonly scenarioRunId: string) {
    this.locations = readJsonFile<StoreFile>(dataDir, scenarioRunId, 'local-locations', {});
  }

  list(): LocalLocation[] {
    return Object.values(this.locations);
  }

  get(scenarioKey: string): LocalLocation | undefined {
    return this.locations[scenarioKey];
  }

  /** Idempotent, like every ensure* in this project - registers a location
   * the first time it's named, returns the existing one unchanged
   * afterwards (including its already-assigned staff). */
  ensure(scenarioKey: string, name: string, description: string): LocalLocation {
    const existing = this.locations[scenarioKey];
    if (existing) return existing;
    const location: LocalLocation = { scenarioKey, name, description, staffScenarioKeys: [], createdAt: new Date().toISOString() };
    this.locations[scenarioKey] = location;
    writeJsonFile(this.dataDir, this.scenarioRunId, 'local-locations', this.locations);
    return location;
  }

  /** Associates an already-ensured real Practitioner (by scenarioKey) with
   * this station - idempotent, never lists the same one twice. */
  assignStaff(scenarioKey: string, practitionerScenarioKey: string): LocalLocation {
    const location = this.locations[scenarioKey];
    if (!location) throw new Error(`No local Location "${scenarioKey}" to assign staff to - ensure() it first.`);
    if (!location.staffScenarioKeys.includes(practitionerScenarioKey)) {
      location.staffScenarioKeys = [...location.staffScenarioKeys, practitionerScenarioKey];
      writeJsonFile(this.dataDir, this.scenarioRunId, 'local-locations', this.locations);
    }
    return location;
  }

  /** Visual-sim groundwork - places this already-ensured station on a
   * future floor-plan's grid. Idempotent to call again with a corrected
   * position, same convention as every other setter in this project. */
  setPosition(scenarioKey: string, position: { x: number; y: number }): LocalLocation {
    const location = this.locations[scenarioKey];
    if (!location) throw new Error(`No local Location "${scenarioKey}" to place - ensure() it first.`);
    location.position = position;
    writeJsonFile(this.dataDir, this.scenarioRunId, 'local-locations', this.locations);
    return location;
  }
}
