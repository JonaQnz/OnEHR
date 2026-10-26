import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkbenchContext } from '../../context';
import { getWorldState } from '../../world/state';
import { toResult } from '../toResult';

const scenarioRunId = z.string().describe('The scenario run to inspect (spec section 3).');

export function registerWorldStateTools(server: McpServer, context: WorkbenchContext): void {
  server.registerTool('get_world_state', {
    title: 'Get the current World State for a scenario run',
    description: 'Spec section 25 - a snapshot of everything this workbench knows about one scenario run: registered entities (with their HIP resource ids and provenance), capabilities, FHIR Resource Forms, and the activity log. FHIR resources are NOT duplicated in full here (only referenced by id) - use get_fhir_resource (existing formbuilder-mcp-server tool) for a resource\'s actual content.',
    inputSchema: { scenarioRunId },
  }, ({ scenarioRunId }) => toResult(async () => getWorldState(scenarioRunId, context.forRun(scenarioRunId))));

  server.registerTool('list_hip_capabilities', {
    title: 'List clinical/organizational capabilities registered for a scenario run',
    description: 'Spec section 23 - the capabilities (e.g. "ct-imaging", "anamnesis") already ensured for this scenario run, each with the resource/form references backing it. An agent should think in capabilities first, individual resources second.',
    inputSchema: { scenarioRunId },
  }, ({ scenarioRunId }) => toResult(async () => context.forRun(scenarioRunId).capabilities.list()));

  server.registerTool('get_hospital_state', {
    title: 'Get a UI-ready spatial/status snapshot for a scenario run',
    description: 'Visual-sim groundwork - the shared clinic\'s own station roster (each with an optional grid `position`), this run\'s own per-scenarioKey activity status (idle/thinking/filling-form/blocked-needs-form/moving - activity/entityStatus.ts, set at real dispatch points in scenario/engine.ts, not mocked), and its real transfer history (world/locationLog.ts). Shaped for a future spatial hospital view to consume directly; no such UI exists yet.',
    inputSchema: { scenarioRunId },
  }, ({ scenarioRunId }) => toResult(async () => {
    const deps = context.forRun(scenarioRunId);
    return {
      stations: context.clinicDepsForRun(scenarioRunId).locations.list(),
      entityStatus: deps.entityStatus.list(),
      locationHistory: deps.locationLog.list(),
    };
  }));
}
