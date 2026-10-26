import { readJsonFile, writeJsonFile } from '../world/jsonStore';
import type { OpenEhrCapabilityConfig } from '../openehr/capabilityBridge';

/**
 * User's own ask: "Form Builder as a capability" - resolving/registering a
 * capability should be a first-class, MCP-tool-level operation, not a human
 * editing `capability/catalog.ts`'s static TS object by hand every time. A
 * capability discovered or newly created this way (an agent designs+
 * publishes+live-tests a new Form Section, then calls the `register_capability`
 * MCP tool - see mcp/tools/capabilityTools.ts) lands here instead.
 *
 * Clinic-scoped (CLINIC_NAMESPACE), not per-scenario-run - same reasoning as
 * `world/localLocations.ts`'s own roster: a Form binding, once discovered,
 * is a durable fact about this Forms instance as a whole, not something
 * that should reset with every fresh scenario run. Same
 * readJsonFile/writeJsonFile-backed shape/style as LocalLocationRegistry.
 */
export class DynamicCapabilityRegistry {
  private records: Record<string, OpenEhrCapabilityConfig>;

  constructor(private readonly dataDir: string, private readonly namespace: string) {
    this.records = readJsonFile<Record<string, OpenEhrCapabilityConfig>>(dataDir, namespace, 'dynamic-capabilities', {});
  }

  get(capability: string): OpenEhrCapabilityConfig | undefined {
    return this.records[capability];
  }

  list(): Array<{ name: string; config: OpenEhrCapabilityConfig }> {
    return Object.entries(this.records).map(([name, config]) => ({ name, config }));
  }

  /** Registers (or overwrites) one capability's binding - idempotent by
   * design, like every other registry in this project: calling it again
   * for the same name with a corrected binding is the intended way to fix
   * a mistake, not a separate "update" method. */
  register(capability: string, config: OpenEhrCapabilityConfig): OpenEhrCapabilityConfig {
    this.records[capability] = config;
    writeJsonFile(this.dataDir, this.namespace, 'dynamic-capabilities', this.records);
    return config;
  }
}
