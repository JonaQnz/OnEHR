import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkbenchContext } from '../../context';
import { getWorldState } from '../../world/state';
import { toResult } from '../toResult';

const scenarioRunId = z.string().describe('The scenario run this is about.');

/**
 * User's own ask, two parts:
 *
 * 1. "Wenn ein Fall verlegt wird muss ein Arzt erstmal bei null starten und
 *    darf nur auf Basis bestehender Infos arbeiten." A ward-transfer already
 *    puts the run's own entity status into "thinking" with exactly this note
 *    (scenario/engine.ts's executeNextEvent) - `get_handoff_briefing` is the
 *    concrete tool that makes "bei null, nur bestehende Infos" possible in
 *    practice: everything a doctor picking the case back up is allowed to
 *    know, bundled in one call, instead of assuming continuity from a prior
 *    conversation/session. This tool can enforce WHAT gets read; it cannot
 *    enforce that whoever plays the doctor actually starts a fresh context
 *    before calling it - that's a workflow discipline this tool exists to
 *    support, not something a backend can compel by itself.
 *
 * 2. "Er darf auch Kritik am System äußern." - `report_system_critique` lets
 *    that doctor (human or agent) file a real, tracked complaint about the
 *    SYSTEM itself (confusing/missing data, a capability that doesn't fit,
 *    anything the deterministic critic/rules.ts could never catch because
 *    it's not a structural rule) - reuses the existing critic TaskStore
 *    (critic/taskStore.ts) with `source: 'manual'`, so it shows up
 *    alongside every other Task but is never silently auto-resolved by the
 *    deterministic critic's own `resolveStale` pass (see taskStore.ts's own
 *    doc comment on that bug, found live while building this).
 */
export function registerCritiqueTools(server: McpServer, context: WorkbenchContext): void {
  server.registerTool('get_handoff_briefing', {
    title: 'Everything a doctor picking up a transferred case may read - and nothing else',
    description: 'The "bei null starten, nur auf Basis bestehender Infos" bundle: this run\'s full World State (entities/capabilities/Resource Forms/Activity log - get_world_state\'s own payload) plus the shared clinic\'s station roster, this run\'s own current entity status, and its real transfer history (the same data get_hospital_state exposes). Call this instead of assuming continuity from an earlier conversation/session whenever picking up a case after a ward-transfer.',
    inputSchema: { scenarioRunId },
  }, ({ scenarioRunId }) => toResult(async () => {
    const deps = context.forRun(scenarioRunId);
    return {
      worldState: getWorldState(scenarioRunId, deps),
      stations: context.clinicDepsForRun(scenarioRunId).locations.list(),
      entityStatus: deps.entityStatus.list(),
      locationHistory: deps.locationLog.list(),
    };
  }));

  server.registerTool('report_system_critique', {
    title: 'File a critique of the SYSTEM itself, from whoever is acting as the doctor',
    description: 'For a complaint that is not a structural rule critic/rules.ts could ever check itself - confusing or missing data, a capability that does not really fit the clinical situation, anything the acting doctor notices while working a case only from get_handoff_briefing/get_world_state. Filed as a real, tracked Task (source "manual") - visible via GET /tasks alongside the deterministic critic\'s own findings, but never auto-resolved by them. Resolve it explicitly with resolve_task once addressed.',
    inputSchema: {
      scenarioRunId,
      eventId: z.string().describe('The event this critique is anchored to - typically the current/most recent one.'),
      description: z.string().describe('The critique itself, in plain language.'),
    },
  }, ({ scenarioRunId, eventId, description }) => toResult(async () => {
    const { tasks } = context.forRun(scenarioRunId);
    return tasks.ensure({
      id: `system-critique:${eventId}:${Date.now()}`,
      code: 'system-critique',
      anchorEventId: eventId,
      description,
      source: 'manual',
    });
  }));

  server.registerTool('resolve_task', {
    title: 'Resolve one manually-filed task by id',
    description: 'Marks a "manual"-source task (request_missing_form/report_system_critique) resolved - the deterministic critic\'s own findings resolve themselves automatically (resolveStale) and do not need this. A no-op if the task is unknown or already resolved.',
    inputSchema: { scenarioRunId, taskId: z.string().describe('The task\'s own id, e.g. from list tasks / GET /tasks.') },
  }, ({ scenarioRunId, taskId }) => toResult(async () => context.forRun(scenarioRunId).tasks.resolve(taskId)));
}
