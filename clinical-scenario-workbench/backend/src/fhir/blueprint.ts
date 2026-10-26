import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { FhirFormField } from './resourceForm';

/**
 * Spec section 13 - OUR requirements for a FHIR resource type, distinct from
 * (and typically stricter than) bare FHIR-spec minimums. One YAML file per
 * resource type actually used by a scenario, under ./blueprints/.
 *
 * `fields` is the one addition beyond the spec's own named properties
 * (simulationRequired/recommended/references/llmMayGenerate/
 * llmMayNotGenerate/dependencies/mayTrigger, all present verbatim below) -
 * something has to say a field's concrete path/label/type/options for a
 * FhirResourceForm to actually be generatable (spec section 8's "Resource
 * Blueprint laden -> einfache Resource Form erzeugen" step); the blueprint
 * is the natural place for that, and it stays exactly as small as the
 * FhirFormField shape itself (fhir/resourceForm.ts).
 */
export interface BlueprintReference {
  target: string[];
}

export interface ResourceBlueprint {
  resourceType: string;
  simulationRequired: string[];
  recommended: string[];
  references: Record<string, BlueprintReference>;
  llmMayGenerate: string[];
  llmMayNotGenerate: string[];
  dependencies: string[];
  mayTrigger: string[];
  fields: FhirFormField[];
}

function normalize(raw: any, sourceFile: string): ResourceBlueprint {
  if (!raw || typeof raw !== 'object' || typeof raw.resourceType !== 'string') {
    throw new Error(`Invalid blueprint in ${sourceFile}: "resourceType" is required.`);
  }
  if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
    throw new Error(`Invalid blueprint in ${sourceFile}: "fields" must be a non-empty array.`);
  }
  return {
    resourceType: raw.resourceType,
    simulationRequired: Array.isArray(raw.simulationRequired) ? raw.simulationRequired : [],
    recommended: Array.isArray(raw.recommended) ? raw.recommended : [],
    references: raw.references && typeof raw.references === 'object' ? raw.references : {},
    llmMayGenerate: Array.isArray(raw.llmMayGenerate) ? raw.llmMayGenerate : [],
    llmMayNotGenerate: Array.isArray(raw.llmMayNotGenerate) ? raw.llmMayNotGenerate : [],
    dependencies: Array.isArray(raw.dependencies) ? raw.dependencies : [],
    mayTrigger: Array.isArray(raw.mayTrigger) ? raw.mayTrigger : [],
    fields: raw.fields,
  };
}

/** Loads and caches every *.yaml blueprint in the given directory, keyed by
 * resourceType. Small and synchronous on purpose - there are, at most, a
 * handful of these for the whole POC (spec section 40's allowlist). */
export class BlueprintLoader {
  private readonly byResourceType = new Map<string, ResourceBlueprint>();

  constructor(private readonly blueprintsDir: string) {
    this.reload();
  }

  reload(): void {
    this.byResourceType.clear();
    if (!fs.existsSync(this.blueprintsDir)) return;
    for (const entry of fs.readdirSync(this.blueprintsDir)) {
      if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
      const file = path.join(this.blueprintsDir, entry);
      const raw = yaml.load(fs.readFileSync(file, 'utf8'));
      const blueprint = normalize(raw, file);
      this.byResourceType.set(blueprint.resourceType, blueprint);
    }
  }

  get(resourceType: string): ResourceBlueprint | undefined {
    return this.byResourceType.get(resourceType);
  }

  require(resourceType: string): ResourceBlueprint {
    const blueprint = this.get(resourceType);
    if (!blueprint) {
      throw new Error(
        `No Resource Blueprint for "${resourceType}" - this workbench only knows the resource types it has a `
        + `blueprint for (spec section 40's allowlist), not arbitrary FHIR types.`,
      );
    }
    return blueprint;
  }

  list(): ResourceBlueprint[] {
    return [...this.byResourceType.values()];
  }
}
