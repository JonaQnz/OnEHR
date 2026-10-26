import express from 'express';
import cors from 'cors';
import { loadConfig } from '../config';
import { DEFAULT_FACILITY_ID, WorkbenchContext, isReservedNamespace } from '../context';
import { getWorldState } from '../world/state';
import { FallbackEntityRegistry } from '../entity/fallbackRegistry';
import { listScenarioRuns, deleteScenarioRun } from '../world/jsonStore';
import { getViewEmbedUrl } from '../openehr/capabilityBridge';
import { listScenarios, loadScenario, loadScenarioForRun } from '../scenario/loader';
import { executeNextEvent, runScenario, runCriticFor, type ScenarioEngineDeps } from '../scenario/engine';
import { buildJourneyGraph, buildClinicGraph } from '../graph/build';
import { updateFhirResourceEntity, PlannerValidationError } from '../agent/planner';

/**
 * The small HTTP API the workbench's OWN frontend talks to - never the main
 * Forms apps/api directly (mirrors vital-signs-generator/backend's own
 * "frontend never calls the Forms API directly" rule, see README.md), so
 * CORS/cookie handling for the Forms session stays entirely server-side
 * here. Every handler is a thin wrapper around the same
 * WorkbenchContext/planner functions the MCP server
 * (../mcp/index.ts) calls - one implementation, two entry points (spec
 * section 10/21), never a separate "UI path".
 */
const config = loadConfig();
const context = new WorkbenchContext(config);

/** Live-discovered race: `executeNextEvent`/`runScenario` read "the next
 * not-yet-completed event" from `progress`, execute it, THEN save progress -
 * two overlapping /step or /play calls for the SAME run (e.g. a client
 * retry firing while the first request is still genuinely in flight
 * server-side, which Express does not itself prevent) can both see the
 * same event as pending and both execute its real HIP/openEHR side effects
 * before either one's save is visible to the other. Caught this live: a
 * killed-client-side-but-still-running `/play` request overlapped with a
 * second one on the same run and produced duplicate real openEHR
 * compositions for several events. A per-run in-memory guard is enough
 * here (single process, no horizontal scaling) - a second call for a run
 * already executing gets a clear 409 rather than racing. */
const runsInFlight = new Set<string>();
function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> | { conflict: true } {
  if (runsInFlight.has(runId)) return { conflict: true };
  runsInFlight.add(runId);
  return fn().finally(() => runsInFlight.delete(runId));
}

const app = express();
app.use(cors({ origin: config.webOrigin, credentials: false }));
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Optional `?facilityId=` scopes the list to one Haus - a scenario file
// missing/unparsable is skipped rather than failing the whole listing (same
// tolerant style as `eventsTotal` below), since this is a picker, not a
// detail page.
app.get('/api/scenarios', (req, res) => {
  const facilityId = typeof req.query.facilityId === 'string' ? req.query.facilityId : undefined;
  const scenarioIds = listScenarios(config.scenariosDir).filter((scenarioId) => {
    if (!facilityId) return true;
    try {
      return (loadScenario(config.scenariosDir, scenarioId).facilityId ?? DEFAULT_FACILITY_ID) === facilityId;
    } catch {
      return false;
    }
  });
  res.json({ scenarioIds });
});

app.get('/api/scenario-runs', (req, res) => {
  const facilityId = typeof req.query.facilityId === 'string' ? req.query.facilityId : undefined;
  // The reserved pseudo-run namespaces (the shared clinics, the facility
  // directory) live in the same dataDir as every real run but are never
  // themselves a case a user should be able to "open" - filtered out here
  // rather than at the storage layer, same reasoning as the POST/DELETE
  // routes below already guarding them explicitly.
  const scenarioRunIds = listScenarioRuns(config.dataDir)
    .filter((id) => !isReservedNamespace(id))
    .filter((id) => !facilityId || (context.forRun(id).progress.get().facilityId ?? DEFAULT_FACILITY_ID) === facilityId);
  res.json({ scenarioRunIds });
});

// User's own ask: "dass wir ein zweites Haus eröffnen können" - the
// directory of open facilities (context.ts's WorkbenchContext.facilities).
// Opening a facility is metadata registration only, idempotent - its own
// clinic-scoped stations/staff/HealthcareService/Schedule capacity is still
// built lazily, the first time a scenario run actually needs it (same
// "nothing exists until needed" philosophy as everything else here).
app.get('/api/facilities', (_req, res) => {
  res.json({ facilities: context.facilities.list() });
});

app.post('/api/facilities', (req, res) => {
  const { id, name, description } = req.body ?? {};
  if (typeof id !== 'string' || typeof name !== 'string') return res.status(400).json({ error: '"id" and "name" are required.' });
  if (!/^[a-z0-9-]+$/.test(id)) return res.status(400).json({ error: '"id" must be lowercase letters/digits/hyphens only (it becomes part of an internal namespace).' });
  if (isReservedNamespace(id) || id === 'facilities') return res.status(400).json({ error: `"${id}" is a reserved namespace and cannot be used as a facility id.` });
  res.status(201).json(context.facilities.open(id, name, typeof description === 'string' ? description : ''));
});

// Spec section 30 - Resource Form Manager. FhirResourceForms are GLOBAL
// (context.ts's WorkbenchContext.clinicDeps().forms - a Resource Form for a
// given resourceType is shared across every scenario run, never re-derived
// per run), so these routes are deliberately NOT nested under
// /scenario-runs/:runId - there is exactly one "appointment" form regardless
// of which run you're looking at. Same ResourceFormStore the MCP's
// list/get/create/update_fhir_resource_form tools call (spec section 10 -
// one implementation, two entry points).
app.get('/api/resource-forms', (_req, res) => {
  res.json({ forms: context.clinicDeps().forms.list() });
});

app.get('/api/resource-forms/:id', (req, res) => {
  const form = context.clinicDeps().forms.get(req.params.id);
  if (!form) return res.status(404).json({ error: `No FhirResourceForm "${req.params.id}".` });
  res.json(form);
});

// Spec section 12's form-growth: appends a brand-new field (fails on a
// duplicate path - use PUT on the field's own path to change an existing
// one instead).
app.post('/api/resource-forms/:id/fields', (req, res) => {
  try {
    res.status(201).json(context.clinicDeps().forms.addField(req.params.id, req.body));
  } catch (error: any) {
    res.status(400).json({ error: error?.message ?? String(error) });
  }
});

app.put('/api/resource-forms/:id/fields/:path', (req, res) => {
  try {
    res.json(context.clinicDeps().forms.updateField(req.params.id, req.params.path, req.body));
  } catch (error: any) {
    res.status(400).json({ error: error?.message ?? String(error) });
  }
});

// Spec section 3 - mints a new, uniquely-tagged scenario run and binds it to
// one scenario definition. Nothing HIP-facing happens here - the run stays
// genuinely empty until the first Step.
app.post('/api/scenario-runs', (req, res) => {
  const { scenarioRunId, scenarioId } = req.body ?? {};
  if (!scenarioRunId || !scenarioId) return res.status(400).json({ error: '"scenarioRunId" and "scenarioId" are required.' });
  if (isReservedNamespace(scenarioRunId)) return res.status(400).json({ error: `"${scenarioRunId}" is a reserved namespace and cannot be used as a scenario run id.` });
  let scenario;
  try {
    scenario = loadScenario(config.scenariosDir, scenarioId); // fail fast if the scenario file doesn't exist/parse
  } catch (error: any) {
    return res.status(400).json({ error: error?.message ?? String(error) });
  }
  const facilityId = scenario.facilityId ?? DEFAULT_FACILITY_ID;
  if (!context.facilities.get(facilityId)) {
    return res.status(400).json({ error: `Facility "${facilityId}" is not open yet - open_facility/POST /api/facilities first.` });
  }
  const deps = context.forRun(scenarioRunId);
  deps.progress.save({ scenarioId, facilityId, completedEventIds: [] });
  res.status(201).json(deps.progress.get());
});

// Spec section 3's "Reset Scenario" - deletes ONLY this run's own local
// JSON files (world/jsonStore.ts's deleteScenarioRun). Deliberately does
// NOT delete anything in HIP: no FHIR-resource-delete capability exists
// anywhere in this app (apps/api's fhirCdrService.ts has create/get/search/
// update only), and deleting real openEHR Compositions is out of scope -
// documented here rather than silently doing a partial reset. A "Reset"
// therefore forgets this run's own bookkeeping and lets you start a fresh
// scenarioRunId; it never claims to un-write what was already sent to HIP.
app.delete('/api/scenario-runs/:runId', (req, res) => {
  if (isReservedNamespace(req.params.runId)) return res.status(400).json({ error: 'A shared clinic (or the facility directory) cannot be reset through this endpoint.' });
  deleteScenarioRun(config.dataDir, req.params.runId);
  context.forgetRun(req.params.runId);
  res.status(204).end();
});

// Merges in the shared clinic's own entities (HealthcareService/Schedule) -
// a patient's world-state should show the clinic capacity their own
// Slot/Appointment actually used, not just their own per-run entities.
app.get('/api/scenario-runs/:runId/world-state', (req, res) => {
  const deps = context.forRun(req.params.runId);
  const merged = { ...deps, registry: new FallbackEntityRegistry(deps.registry, context.clinicDepsForRun(req.params.runId).registry) };
  res.json(getWorldState(req.params.runId, merged));
});

// Spec section 28C - a chronological list of the scenario's OWN events
// (not the free-form Activity log), each annotated with whether/when it
// actually ran. `event.at` is only the scenario definition's descriptive
// offset ("5m", "1h10m"); `completedAt` is this run's own real clock,
// recorded by scenario/engine.ts's executeNextEvent the moment an event
// finishes - undefined for an event that hasn't happened yet in this run.
app.get('/api/scenario-runs/:runId/timeline', (req, res) => {
  const deps = context.forRun(req.params.runId);
  const progress = deps.progress.get();
  if (!progress.scenarioId) return res.status(400).json({ error: 'This scenario run has not been created yet - POST /api/scenario-runs first.' });
  const scenario = loadScenarioForRun(config.scenariosDir, config.dataDir, progress.scenarioId, req.params.runId);
  const timeline = scenario.events.map((event) => ({
    event,
    completed: progress.completedEventIds.includes(event.id),
    completedAt: progress.completedAt?.[event.id],
  }));
  res.json({ timeline });
});

// The critic system's own output ("bei jedem Schritt [...] kritisieren
// [...] und daraus Tasks erstellen") - a Task appears here the moment its
// anchor event completes (scenario/engine.ts's `runCriticFor`), never all
// at once at the end. Local-only (critic/taskStore.ts) - a real FHIR `Task`
// hits the same "No mapping found" tenant gap as `Location`/`Procedure`.
app.get('/api/scenario-runs/:runId/tasks', (req, res) => {
  res.json({ tasks: context.forRun(req.params.runId).tasks.list() });
});

// Visual-sim groundwork (user's own ask - "prepare further to make it a UI
// visual simulation hospital with people running around and working and
// thinking"): one payload shaped exactly for a future spatial view to
// consume directly - the shared clinic's own station roster (with an
// optional grid `position`, world/localLocations.ts), this run's own
// per-scenarioKey activity status (activity/entityStatus.ts), and its real
// transfer history (world/locationLog.ts). No frontend built against this
// yet, this pass is data only.
app.get('/api/scenario-runs/:runId/hospital-state', (req, res) => {
  const deps = context.forRun(req.params.runId);
  res.json({
    stations: context.clinicDepsForRun(req.params.runId).locations.list(),
    entityStatus: deps.entityStatus.list(),
    locationHistory: deps.locationLog.list(),
  });
});

// See mcp/tools/critiqueTools.ts's own doc comment - "bei null starten, nur
// auf Basis bestehender Infos" made concrete: everything a doctor picking
// up a transferred case may read, bundled in one call.
app.get('/api/scenario-runs/:runId/handoff-briefing', (req, res) => {
  const deps = context.forRun(req.params.runId);
  res.json({
    worldState: getWorldState(req.params.runId, deps),
    stations: context.clinicDepsForRun(req.params.runId).locations.list(),
    entityStatus: deps.entityStatus.list(),
    locationHistory: deps.locationLog.list(),
  });
});

// "Er darf auch Kritik am System äußern" - a real, tracked complaint from
// whoever is acting as the doctor, distinct from the deterministic
// critic/rules.ts findings (source "manual" - never auto-resolved by
// resolveStale, see taskStore.ts's own doc comment).
app.post('/api/scenario-runs/:runId/system-critique', (req, res) => {
  const { eventId, description } = req.body ?? {};
  if (typeof eventId !== 'string' || typeof description !== 'string') {
    return res.status(400).json({ error: '"eventId" and "description" are required.' });
  }
  const { tasks } = context.forRun(req.params.runId);
  res.json(tasks.ensure({ id: `system-critique:${eventId}:${Date.now()}`, code: 'system-critique', anchorEventId: eventId, description, source: 'manual' }));
});

app.post('/api/scenario-runs/:runId/tasks/:taskId/resolve', (req, res) => {
  const resolved = context.forRun(req.params.runId).tasks.resolve(req.params.taskId);
  if (!resolved) return res.status(404).json({ error: `No task "${req.params.taskId}" on this run.` });
  res.json(resolved);
});

// Re-runs the critic against everything already completed, without
// executing a new event - needed for a run that has already finished (so
// no future Step will ever call `runCriticFor` again) but whose findings
// should still reflect the LATEST critic rules or a scenario file that
// changed since the run completed. Also what fixes a run caught by the
// exact stale-Task bug `TaskStore.resolveStale`'s own doc comment
// describes, for a case that had already fully played out before the fix
// shipped.
app.post('/api/scenario-runs/:runId/tasks/recheck', (req, res) => {
  const deps = context.forRun(req.params.runId);
  const progress = deps.progress.get();
  if (!progress.scenarioId) return res.status(400).json({ error: 'This scenario run has not been created yet - POST /api/scenario-runs first.' });
  const scenario = loadScenarioForRun(config.scenariosDir, config.dataDir, progress.scenarioId, req.params.runId);
  runCriticFor(deps as ScenarioEngineDeps, scenario, progress.completedEventIds);
  res.json({ tasks: deps.tasks.list() });
});

// The Journey Graph (frontend's JourneyGraph.tsx, React Flow) - nodes are
// the Patient/other FHIR entities/openEHR capabilities, edges are REAL
// reference fields resolved out of the actual HIP resources (graph/build.ts),
// never a hardcoded shape - so a Resource Form grown via the Manager above
// shows up in the graph's edges too, with no separate logic to keep in sync.
app.get('/api/scenario-runs/:runId/graph', async (req, res) => {
  const deps = context.forRun(req.params.runId) as ScenarioEngineDeps;
  const clinic = context.clinicDepsForRun(req.params.runId) as ScenarioEngineDeps;
  try {
    res.json(await buildJourneyGraph(deps, clinic));
  } catch (error: any) {
    res.status(502).json({ error: error?.message ?? String(error) });
  }
});

// The "Klinik" bird's-eye view (graph/build.ts's buildClinicGraph) - every
// real case's own Patient hung off the shared clinic capacity it actually
// used, scoped to ONE facility (`?facilityId=`, default the original
// hospital) - a Rehazentrum's Klinik view must never show the hospital's
// cases/stations and vice versa. `eventsTotal` needs each run's own scenario
// file loaded (to know how many events it declares) - a run whose scenario
// file is missing/unparsable is skipped rather than failing the whole view,
// since this is a summary, not a per-case detail page.
app.get('/api/clinic-graph', async (req, res) => {
  const facilityId = typeof req.query.facilityId === 'string' ? req.query.facilityId : DEFAULT_FACILITY_ID;
  const clinic = context.clinicDeps(facilityId) as ScenarioEngineDeps;
  try {
    const runs = listScenarioRuns(config.dataDir)
      .filter((id) => !isReservedNamespace(id))
      .filter((scenarioRunId) => (context.forRun(scenarioRunId).progress.get().facilityId ?? DEFAULT_FACILITY_ID) === facilityId)
      .map((scenarioRunId) => {
        const deps = context.forRun(scenarioRunId) as ScenarioEngineDeps;
        const progress = context.forRun(scenarioRunId).progress.get();
        let eventsTotal = 0;
        try {
          eventsTotal = loadScenarioForRun(config.scenariosDir, config.dataDir, progress.scenarioId, scenarioRunId).events.length;
        } catch {
          // scenario file missing/renamed since this run was created - still show it, just without a step count
        }
        return { scenarioRunId, deps, eventsCompleted: progress.completedEventIds.length, eventsTotal };
      });
    res.json(await buildClinicGraph(clinic, runs));
  } catch (error: any) {
    res.status(502).json({ error: error?.message ?? String(error) });
  }
});

// Read-only proxy for one already-registered entity's real FHIR resource
// body, annotated with its FhirResourceForm's field labels so the frontend
// can render "Name: CT-Diagnostik" instead of raw JSON keys (spec section
// 29's Resource Inspector) - the one small server-side assembly step this
// endpoint exists for. Falls through to the shared clinic registry too
// (see world-state above) so a HealthcareService/Schedule scenario key is
// resolvable from any run that used it.
app.get('/api/scenario-runs/:runId/entities/:scenarioKey', async (req, res) => {
  const deps = context.forRun(req.params.runId);
  const registry = new FallbackEntityRegistry(deps.registry, context.clinicDepsForRun(req.params.runId).registry);
  const entity = registry.get(req.params.scenarioKey);
  if (!entity) return res.status(404).json({ error: `No entity registered for scenario key "${req.params.scenarioKey}".` });
  try {
    const form = deps.forms.getByResourceType(entity.resourceType);
    const resource = await deps.hip.get(entity.resourceType, entity.hipResourceId);
    res.json({ entity, resource, form });
  } catch (error: any) {
    res.status(502).json({ error: error?.message ?? String(error) });
  }
});

// Spec section 11/37 - editing an already-created resource from the UI
// (e.g. "open this Appointment, change the time, save"). Always
// USER-provenance: a person editing through this workbench's own UI is
// exactly the case spec section 38 says must outrank SOURCE/DERIVED/
// GENERATED. Routes to whichever registry (this run's own, or the shared
// clinic's) actually owns the entity - never blindly the run's own, or
// editing a clinic-level entity (e.g. renaming the HealthcareService) would
// wrongly create a second, run-scoped copy instead of updating the real,
// shared one.
app.put('/api/scenario-runs/:runId/entities/:scenarioKey', async (req, res) => {
  const deps = context.forRun(req.params.runId);
  const clinic = context.clinicDepsForRun(req.params.runId);
  const ownerDeps = deps.registry.has(req.params.scenarioKey) ? deps : clinic.registry.has(req.params.scenarioKey) ? clinic : undefined;
  if (!ownerDeps) return res.status(404).json({ error: `No entity registered for scenario key "${req.params.scenarioKey}".` });
  if (!req.body?.values || typeof req.body.values !== 'object') return res.status(400).json({ error: '"values" (an object of field-path -> new value) is required.' });
  try {
    const result = await updateFhirResourceEntity(ownerDeps, { scenarioKey: req.params.scenarioKey, values: req.body.values, provenance: 'USER' });
    res.json(result);
  } catch (error: any) {
    if (error instanceof PlannerValidationError) return res.status(422).json({ error: error.message, issues: error.issues });
    res.status(502).json({ error: error?.message ?? String(error) });
  }
});

// Returns a fresh, read-only iframe-embeddable URL for an already-ensured
// openEHR capability (see openehr/capabilityBridge.ts's getViewEmbedUrl doc
// comment for why this is always a new view-mode session, never the
// original submission's session reused).
app.get('/api/scenario-runs/:runId/capabilities/:capability/embed', async (req, res) => {
  const deps = context.forRun(req.params.runId);
  const capability = deps.capabilities.get(req.params.capability);
  if (!capability || capability.kind !== 'openEHR' || !capability.compositionSessionId || !capability.formId || !capability.blockId) {
    return res.status(404).json({ error: `No openEHR capability "${req.params.capability}" registered for this scenario run.` });
  }
  const patientEntity = capability.patientScenarioKey ? deps.registry.get(capability.patientScenarioKey) : undefined;
  if (!patientEntity?.formsPatientId) {
    return res.status(404).json({ error: `Capability "${req.params.capability}" has no resolvable patient.` });
  }
  try {
    const launchUrl = await getViewEmbedUrl(
      deps.api,
      { formSectionFormId: capability.formId, blockId: capability.blockId },
      capability.compositionSessionId,
      { id: patientEntity.formsPatientId },
    );
    res.json({ launchUrl, webUrl: `${config.formbuilderWebUrl}${launchUrl}` });
  } catch (error: any) {
    res.status(502).json({ error: error?.message ?? String(error) });
  }
});

// The "be the agent, not an API key" mechanism (scenario/generatedValues.ts) -
// lets whoever is acting as the agent for one specific upcoming event supply
// its GENERATED-policy field values directly (a HealthcareService name, a
// Slot/Appointment time, ...) BEFORE stepping it, instead of the engine's
// own small deterministic fallback. Field names are event-type-specific -
// see scenario/engine.ts's own request-imaging handler for exactly which
// ones it reads (healthcareServiceName/slotStart/slotEnd/appointmentComment).
app.post('/api/scenario-runs/:runId/events/:eventId/generated-values', (req, res) => {
  const deps = context.forRun(req.params.runId);
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'A JSON object of field overrides is required.' });
  res.json(deps.generatedValues.set(req.params.eventId, req.body));
});

// Read-side counterpart, so the UI (Timeline.tsx's own override form) can
// pre-fill whatever was already supplied for an upcoming event, rather than
// always starting blank and risking a well-meaning overwrite of an earlier
// choice with an empty value.
app.get('/api/scenario-runs/:runId/events/:eventId/generated-values', (req, res) => {
  const deps = context.forRun(req.params.runId);
  res.json(deps.generatedValues.get(req.params.eventId));
});

// The "eigener Agent als Arzt" mechanism (dynamicEvents.ts) - appends ONE
// real event to this run's own tail, beyond whatever its static scenario
// file declares. Whoever is playing the doctor for an open-ended case (a
// human, or an assistant reviewing the real chart through this workbench's
// own read endpoints) calls this once per decision, then Steps it like any
// other event - never a separate write path. Blocked while a Step/Play is
// mid-flight on this run, same reasoning as withRunLock elsewhere.
app.post('/api/scenario-runs/:runId/events', (req, res) => {
  const deps = context.forRun(req.params.runId);
  const progress = deps.progress.get();
  if (!progress.scenarioId) return res.status(400).json({ error: 'This scenario run has not been created yet - POST /api/scenario-runs first.' });
  const { id, type, at, data } = req.body ?? {};
  if (!id || !type) return res.status(400).json({ error: '"id" and "type" are required.' });
  try {
    const scenario = loadScenarioForRun(config.scenariosDir, config.dataDir, progress.scenarioId, req.params.runId);
    const existingIds = new Set(scenario.events.map((event) => event.id));
    const appended = deps.dynamicEvents.append({ id, type, at: typeof at === 'string' ? at : '0m', data }, existingIds);
    res.status(201).json(appended);
  } catch (error: any) {
    res.status(400).json({ error: error?.message ?? String(error) });
  }
});

// Spec section 31/44 - "Step": runs exactly the next not-yet-completed
// scenario event.
app.post('/api/scenario-runs/:runId/step', async (req, res) => {
  const deps = context.forRun(req.params.runId);
  const scenarioId = deps.progress.get().scenarioId;
  if (!scenarioId) return res.status(400).json({ error: 'This scenario run has not been created yet - POST /api/scenario-runs first.' });
  const result = withRunLock(req.params.runId, async () => {
    const scenario = loadScenarioForRun(config.scenariosDir, config.dataDir, scenarioId, req.params.runId);
    return executeNextEvent(req.params.runId, deps, context.clinicDepsForRun(req.params.runId), scenario, deps.progress);
  });
  if ('conflict' in result) return res.status(409).json({ error: 'This scenario run is already executing a Step/Play - wait for it to finish before starting another.' });
  try {
    res.json(await result);
  } catch (error: any) {
    res.status(502).json({ error: error?.message ?? String(error) });
  }
});

// "Play"/"Instant" - runs events until the scenario finishes or `maxEvents`
// (body param) is reached; omit `maxEvents` for Instant (spec section 31).
app.post('/api/scenario-runs/:runId/play', async (req, res) => {
  const deps = context.forRun(req.params.runId);
  const scenarioId = deps.progress.get().scenarioId;
  if (!scenarioId) return res.status(400).json({ error: 'This scenario run has not been created yet - POST /api/scenario-runs first.' });
  const maxEvents = typeof req.body?.maxEvents === 'number' ? req.body.maxEvents : undefined;
  const result = withRunLock(req.params.runId, async () => {
    const scenario = loadScenarioForRun(config.scenariosDir, config.dataDir, scenarioId, req.params.runId);
    const executed = await runScenario(req.params.runId, deps, context.clinicDepsForRun(req.params.runId), scenario, deps.progress, maxEvents);
    return { executed, finished: deps.progress.get().completedEventIds.length === scenario.events.length };
  });
  if ('conflict' in result) return res.status(409).json({ error: 'This scenario run is already executing a Step/Play - wait for it to finish before starting another.' });
  try {
    res.json(await result);
  } catch (error: any) {
    res.status(502).json({ error: error?.message ?? String(error) });
  }
});

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[clinical-scenario-workbench http]', error);
  res.status(500).json({ error: error?.message ?? 'Internal error' });
});

app.listen(config.port, () => {
  console.log(`clinical-scenario-workbench backend listening on :${config.port}`);
});
