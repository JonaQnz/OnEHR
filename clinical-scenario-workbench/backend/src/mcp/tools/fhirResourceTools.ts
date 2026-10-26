import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkbenchContext } from '../../context';
import { ensureFhirResource, updateFhirResourceEntity } from '../../agent/planner';
import { toResult } from '../toResult';

const scenarioRunId = z.string().describe('The scenario run this resource belongs to (spec section 3).');
const provenance = z.enum(['SOURCE', 'DERIVED', 'GENERATED', 'USER']).describe('Where this write\'s values came from - spec section 7. A GENERATED/DERIVED write is refused, per-field, wherever a higher-priority value already exists (spec section 38).');

/**
 * Spec section 22 - THE mandatory gate: create/update_fhir_resource may
 * NEVER accept arbitrary JSON. Both tools delegate to agent/planner.ts's
 * ensureFhirResource/updateFhirResourceEntity, which always run Resource
 * Form -> Blueprint Validation -> Reference Validation -> FHIR Factory ->
 * HIP API -> read-back -> Registry, exactly like the UI's own "Speichern"
 * action does (spec section 10) - this is NOT a thin passthrough to the
 * already-existing, unvalidated create_fhir_resource tool in
 * packages/mcp-server (that one still exists for raw/manual use; an agent
 * driving a scenario through THIS workbench should always prefer these).
 * Reads (list_fhir_resources/get_fhir_resource) have no such gate to add -
 * an agent should just use the existing formbuilder-mcp-server's own
 * get_fhir_resource/search_fhir_resource tools directly for those.
 */
export function registerFhirResourceTools(server: McpServer, context: WorkbenchContext): void {
  server.registerTool('create_fhir_resource', {
    title: 'Create a FHIR resource through its Resource Form and Blueprint (validated)',
    description: 'Creates a FHIR resource for a scenario entity - but only after passing Form Validation, Blueprint Validation, and Reference Validation (spec section 22/34). Ensures the resource type\'s Resource Form exists first (generating it from its Blueprint if this is the first use). Idempotent: if `scenarioKey` is already registered, returns the existing entity instead of creating a duplicate. `values` is a flat {fieldPath: value} map matching the resource type\'s Resource Form fields - a `reference`-type field\'s value must be another entity\'s scenarioKey, never a raw FHIR reference string (the Entity Registry resolves it).',
    inputSchema: {
      scenarioRunId,
      resourceType: z.string(),
      scenarioKey: z.string().describe('A stable internal key for this entity, e.g. "patient-maria" (spec section 24) - used to address it again later (update, or as another resource\'s reference target).'),
      values: z.record(z.string(), z.unknown()),
      provenance,
    },
  }, ({ scenarioRunId, resourceType, scenarioKey, values, provenance }) => toResult(async () => {
    const deps = context.forRun(scenarioRunId);
    return ensureFhirResource(deps, { resourceType, scenarioKey, values, provenance });
  }));

  server.registerTool('update_fhir_resource', {
    title: 'Update an already-registered FHIR resource (validated, provenance-aware)',
    description: 'Edits an already-created scenario entity in place (real HIP PUT, id-preserving) - re-validates the RESULTING whole resource (current values merged with this call\'s changes), not just the changed fields. Any field whose current value already carries an equal-or-higher-priority provenance than this call\'s own is silently refused (reported in `refused`, never applied) - spec section 38\'s USER > SOURCE > DERIVED > GENERATED rule. Use provenance "USER" for a person\'s own edit.',
    inputSchema: {
      scenarioRunId,
      scenarioKey: z.string(),
      values: z.record(z.string(), z.unknown()),
      provenance,
    },
  }, ({ scenarioRunId, scenarioKey, values, provenance }) => toResult(async () => {
    const deps = context.forRun(scenarioRunId);
    return updateFhirResourceEntity(deps, { scenarioKey, values, provenance });
  }));
}
