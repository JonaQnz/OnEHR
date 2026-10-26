import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isReservedNamespace, type WorkbenchContext } from '../../context';
import { toResult } from '../toResult';

/**
 * User's own ask: "dass wir ein zweites Haus eröffnen können" - each open
 * facility (context.ts's WorkbenchContext.facilities) gets its own
 * independent clinic namespace (stations/staff/HealthcareService/Schedule
 * capacity - see context.ts's `clinicNamespaceFor`), while shared clinical
 * documentation infrastructure (Form Sections, openEHR capability bindings)
 * stays global across every facility. Opening a facility is metadata
 * registration only - its own clinic-scoped state is still built lazily,
 * the first time a scenario run at that facility actually needs it.
 */
export function registerFacilityTools(server: McpServer, context: WorkbenchContext): void {
  server.registerTool('list_facilities', {
    title: 'List open facilities ("Häuser")',
    description: 'Every facility opened via open_facility so far - always includes the original hospital ("krankenhaus"). A scenario file names which facility it is set at (its own `facilityId`, defaulting to the hospital) - start_scenario_run fails if that facility has not been opened yet.',
    inputSchema: {},
  }, () => toResult(async () => ({ facilities: context.facilities.list() })));

  server.registerTool('open_facility', {
    title: 'Open a new facility ("Haus"), e.g. a Rehazentrum',
    description: 'Registers a new, independent facility - its own station/staff roster and its own HealthcareService/Schedule booking capacity, completely separate from every other facility\'s (a Rehazentrum never shares the hospital\'s Notaufnahme/OP, and vice versa). Shared clinical documentation (Form Sections, openEHR capabilities) stays available to every facility unchanged. Idempotent - opening an already-open id returns it unchanged. A scenario file can then declare this facility via its own top-level `facilityId`.',
    inputSchema: {
      id: z.string().regex(/^[a-z0-9-]+$/, 'lowercase letters/digits/hyphens only').describe('A short, stable id, e.g. "rehazentrum" - becomes part of an internal namespace, never shown to a scenario author beyond the scenario file\'s own `facilityId`.'),
      name: z.string().describe('A human-readable name, e.g. "Rehazentrum Sonnenberg".'),
      description: z.string().optional().describe('A short blurb, e.g. "Anschlussheilbehandlung nach operativen Eingriffen."'),
    },
  }, ({ id, name, description }) => toResult(async () => {
    if (isReservedNamespace(id) || id === 'facilities') throw new Error(`"${id}" is a reserved namespace and cannot be used as a facility id.`);
    return context.facilities.open(id, name, description ?? '');
  }));
}
