import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DEFAULT_FACILITY_ID, isReservedNamespace, type WorkbenchContext } from '../../context';
import { listScenarios, loadScenario } from '../../scenario/loader';
import { executeNextEvent, runScenario } from '../../scenario/engine';
import { deleteScenarioRun, listScenarioRuns } from '../../world/jsonStore';
import { toResult } from '../toResult';

const scenarioRunId = z.string().describe('A unique tag for this simulation run (spec section 3), e.g. "lae-demo-2026-09-15-001" - every resource this run creates is scoped to it.');

/**
 * Spec section 21's MCP-first requirement made concrete for scenario
 * control: an external agent can drive the exact same "Step"/"Play"/
 * "Reset" actions the UI's own SimulationControls.tsx calls - both go
 * through scenario/engine.ts's executeNextEvent/runScenario, never a
 * separate agent-only code path.
 */
export function registerScenarioTools(server: McpServer, context: WorkbenchContext): void {
  server.registerTool('list_scenarios', {
    title: 'List available scenario definitions',
    description: 'Lists the scenario ids available to start a run from (backend/scenarios/*.yaml) - e.g. "lae-demo".',
    inputSchema: {},
  }, () => toResult(async () => ({ scenarioIds: listScenarios(context.config.scenariosDir) })));

  server.registerTool('list_scenario_runs', {
    title: 'List existing scenario runs',
    description: 'Lists every scenarioRunId that currently has local state on disk.',
    inputSchema: {},
  }, () => toResult(async () => ({ scenarioRunIds: listScenarioRuns(context.config.dataDir) })));

  server.registerTool('start_scenario_run', {
    title: 'Start a new scenario run',
    description: 'Mints a fresh scenario run bound to one scenario definition - spec section 3: the clinic looks empty because every resource is scoped to this run\'s own scenarioRunId, not because HIP itself is empty. Fails if `scenarioId` has no matching file.',
    inputSchema: { scenarioRunId, scenarioId: z.string() },
  }, ({ scenarioRunId, scenarioId }) => toResult(async () => {
    if (isReservedNamespace(scenarioRunId)) throw new Error(`"${scenarioRunId}" is a reserved namespace and cannot be used as a scenario run id.`);
    const scenario = loadScenario(context.config.scenariosDir, scenarioId); // fail fast on a bad scenarioId
    const facilityId = scenario.facilityId ?? DEFAULT_FACILITY_ID;
    if (!context.facilities.get(facilityId)) throw new Error(`Facility "${facilityId}" is not open yet - call open_facility first.`);
    const deps = context.forRun(scenarioRunId);
    deps.progress.save({ scenarioId, facilityId, completedEventIds: [] });
    return deps.progress.get();
  }));

  server.registerTool('set_generated_values', {
    title: 'Supply GENERATED-policy values for an upcoming scenario event',
    description: 'The "be the agent, not an API key" path: this deployment has no ANTHROPIC_API_KEY configured for the narrow LLM-fill step, so whoever is acting as the agent (you) can supply the same kind of values directly instead - a plausible HealthcareService name, an Appointment time, a comment. Call this BEFORE execute_next_event/advance_scenario runs the event; anything not supplied falls back to a small fixed default. Currently honored by the "request-imaging" event type: healthcareServiceName (string), slotStart/slotEnd (ISO datetime strings, also used for the Appointment), appointmentComment (string). Values you supply are still subject to the normal Resource Form + Blueprint validation gate when the event actually runs - this does not bypass that.',
    inputSchema: {
      scenarioRunId,
      eventId: z.string().describe('The scenario event id these values are for, e.g. "ctpa-request" (see list_scenarios/the scenario YAML for event ids).'),
      values: z.record(z.string(), z.unknown()).describe('Field overrides, e.g. { healthcareServiceName: "Radiologisches Zentrum Ost", slotStart: "2026-09-15T15:30:00.000Z", slotEnd: "2026-09-15T16:00:00.000Z" }.'),
    },
  }, ({ scenarioRunId, eventId, values }) => toResult(async () => context.forRun(scenarioRunId).generatedValues.set(eventId, values)));

  server.registerTool('execute_next_event', {
    title: 'Execute exactly the next scenario event',
    description: 'Spec section 26/31\'s "Step" - runs the next not-yet-completed event of this run\'s scenario (patient arrival, anamnesis, vital signs, an imaging request, ...) through the real ensure*/Form Builder pipeline, and advances progress. Returns {event: null, finished: true} once every event has run. Call start_scenario_run first if this run has no scenario bound yet.',
    inputSchema: { scenarioRunId },
  }, ({ scenarioRunId }) => toResult(async () => {
    const deps = context.forRun(scenarioRunId);
    const scenarioId = deps.progress.get().scenarioId;
    if (!scenarioId) throw new Error(`Scenario run "${scenarioRunId}" has not been started yet - call start_scenario_run first.`);
    return executeNextEvent(scenarioRunId, deps, context.clinicDepsForRun(scenarioRunId), loadScenario(context.config.scenariosDir, scenarioId), deps.progress);
  }));

  server.registerTool('advance_scenario', {
    title: 'Run scenario events until finished (or maxEvents is reached)',
    description: 'Spec section 31\'s "Play"/"Instant" - repeatedly calls the same step logic as execute_next_event. Omit `maxEvents` to run the whole remaining scenario in one call (Instant); every step is still individually Activity-logged exactly as if it had been Stepped one at a time.',
    inputSchema: { scenarioRunId, maxEvents: z.number().optional().describe('Run at most this many more events. Omit to run to completion.') },
  }, ({ scenarioRunId, maxEvents }) => toResult(async () => {
    const deps = context.forRun(scenarioRunId);
    const scenarioId = deps.progress.get().scenarioId;
    if (!scenarioId) throw new Error(`Scenario run "${scenarioRunId}" has not been started yet - call start_scenario_run first.`);
    const scenario = loadScenario(context.config.scenariosDir, scenarioId);
    const executed = await runScenario(scenarioRunId, deps, context.clinicDepsForRun(scenarioRunId), scenario, deps.progress, maxEvents);
    return { executed, finished: deps.progress.get().completedEventIds.length === scenario.events.length };
  }));

  server.registerTool('reset_scenario', {
    title: 'Reset a scenario run',
    description: 'Spec section 3 - deletes ONLY this run\'s own local bookkeeping (entities/capabilities/forms/activity/progress JSON). Never touches HIP itself: no FHIR-resource-delete capability exists in this app, and deleting real openEHR Compositions is out of scope, so anything already written to HIP under this scenarioRunId remains there (orphaned but harmless, tagged with a scenarioRunId nothing will reference again) - this is a reset of the workbench\'s own view, not a HIP data deletion.',
    inputSchema: { scenarioRunId },
  }, ({ scenarioRunId }) => toResult(async () => {
    if (isReservedNamespace(scenarioRunId)) throw new Error('A shared clinic (or the facility directory) cannot be reset through this tool.');
    deleteScenarioRun(context.config.dataDir, scenarioRunId);
    context.forgetRun(scenarioRunId);
    return { reset: true, scenarioRunId };
  }));
}
