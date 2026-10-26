#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WorkbenchContext } from '../context';
import { registerWorldStateTools } from './tools/worldStateTools';
import { registerResourceFormTools } from './tools/resourceFormTools';
import { registerFhirResourceTools } from './tools/fhirResourceTools';
import { registerScenarioTools } from './tools/scenarioTools';
import { registerCapabilityTools } from './tools/capabilityTools';
import { registerCritiqueTools } from './tools/critiqueTools';
import { registerFacilityTools } from './tools/facilityTools';

/**
 * The Clinical Scenario Workbench's OWN MCP server - exposes only the
 * genuinely new tools this project adds (world state, capabilities,
 * resource forms, validated FHIR create/update). Deliberately does NOT
 * re-expose get_fhir_resource/search_fhir_resource/list_patients/etc. -
 * those already exist, unchanged, on the main repo's own
 * formbuilder-mcp-server (see .mcp.json, which registers both servers side
 * by side) - spec section 21's "keine redundanten Tools bauen".
 */
async function main(): Promise<void> {
  const context = new WorkbenchContext();
  const server = new McpServer({ name: 'clinical-scenario-workbench', version: '0.1.0' }, {
    instructions:
      'Tools for the HIP Clinical Scenario Workbench - a scenario-run-scoped layer on top of the onEHR Form Builder\'s '
      + 'own FHIR/openEHR integration. Every FHIR write here goes through create_fhir_resource/update_fhir_resource, '
      + 'which enforce Resource Form + Blueprint + Reference validation before ever touching HIP (never bypass this by '
      + 'calling the main formbuilder-mcp-server\'s own raw create_fhir_resource tool for a resource type this '
      + 'workbench manages). Reads (get_fhir_resource/search_fhir_resource) and everything openEHR/Form-Builder-related '
      + '(templates, Compositions, patients) should use the main formbuilder-mcp-server\'s tools directly - this server '
      + 'only adds what did not already exist: get_world_state/list_hip_capabilities for scenario-run state, the '
      + 'FHIR Resource Form CRUD tools, scenario playback (start_scenario_run, then execute_next_event/'
      + 'advance_scenario/reset_scenario), and the openEHR capability registry (list_capabilities/resolve_capability/'
      + 'register_capability/request_missing_form - "is there a Form for X", and how to add one when there is not), and '
      + 'multi-facility support (list_facilities/open_facility - each facility, e.g. a hospital vs. a Rehazentrum, has its '
      + 'own independent stations/staff/booking capacity; a scenario file names which one it is set at).',
  });

  registerWorldStateTools(server, context);
  registerResourceFormTools(server, context);
  registerFhirResourceTools(server, context);
  registerScenarioTools(server, context);
  registerCapabilityTools(server, context);
  registerCritiqueTools(server, context);
  registerFacilityTools(server, context);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[clinical-scenario-workbench mcp] fatal error:', error);
  process.exit(1);
});
