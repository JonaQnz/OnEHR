import { readJsonFile, writeJsonFile } from './jsonStore';

/**
 * User's own ask: "dass wir ein zweites Haus eröffnen können" - a real,
 * listable directory of the independent facilities ("Häuser") this
 * workbench knows about (a hospital, a Rehazentrum, ...), each with its own
 * physical stations/staff/booking capacity (see context.ts's
 * `clinicNamespaceFor`/`clinicDeps`). This registry itself is just the
 * directory - metadata about which facilities exist - never a facility's own
 * clinical/organizational state, which lives in its own `_clinic:<id>`
 * namespace exactly like the original hospital's `_clinic` always has.
 * Global (not per-run), same reasoning as `_clinic` itself - stored under a
 * reserved `_facilities` pseudo-run namespace via the same
 * readJsonFile/writeJsonFile every other JSON store already uses.
 */
export interface Facility {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

export const FACILITY_REGISTRY_NAMESPACE = '_facilities';

type StoreFile = Record<string, Facility>;

export class FacilityRegistry {
  private facilities: StoreFile;

  constructor(private readonly dataDir: string) {
    this.facilities = readJsonFile<StoreFile>(dataDir, FACILITY_REGISTRY_NAMESPACE, 'facilities', {});
  }

  list(): Facility[] {
    return Object.values(this.facilities).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Facility | undefined {
    return this.facilities[id];
  }

  /** Idempotent, like every other `ensure*`/`open`-style method in this
   * project - "opening" an already-open facility returns it unchanged
   * rather than overwriting its name/description. */
  open(id: string, name: string, description: string): Facility {
    const existing = this.facilities[id];
    if (existing) return existing;
    const facility: Facility = { id, name, description, createdAt: new Date().toISOString() };
    this.facilities[id] = facility;
    writeJsonFile(this.dataDir, FACILITY_REGISTRY_NAMESPACE, 'facilities', this.facilities);
    return facility;
  }
}
