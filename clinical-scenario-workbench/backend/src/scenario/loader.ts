import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { Scenario } from './types';
import { expandScenario } from './protocol';
import { DynamicEventsStore } from './dynamicEvents';

function normalize(raw: any, sourceFile: string): Scenario {
  if (!raw || typeof raw !== 'object' || typeof raw.scenarioId !== 'string') {
    throw new Error(`Invalid scenario in ${sourceFile}: "scenarioId" is required.`);
  }
  if (!raw.patient?.key) throw new Error(`Invalid scenario in ${sourceFile}: "patient.key" is required.`);
  if (!Array.isArray(raw.events) || raw.events.length === 0) {
    throw new Error(`Invalid scenario in ${sourceFile}: "events" must be a non-empty array.`);
  }
  const ids = new Set<string>();
  for (const event of raw.events) {
    if (!event.id || !event.type) throw new Error(`Invalid scenario in ${sourceFile}: every event needs "id" and "type".`);
    if (ids.has(event.id)) throw new Error(`Invalid scenario in ${sourceFile}: duplicate event id "${event.id}".`);
    ids.add(event.id);
  }
  return raw as Scenario;
}

// expandScenario applies every station-kind's own admission/discharge/
// periodic ruleset (protocol.ts) - run EVERY time a scenario is loaded, so
// a scenario author never has to remember to hand-author it (the user's
// own "muss dann jedesmal auch erzeugt werden" requirement). A station
// that never sets `data.location.kind` passes through unexpanded.
export function loadScenario(scenariosDir: string, scenarioId: string): Scenario {
  const file = path.join(scenariosDir, `${scenarioId}.yaml`);
  if (!fs.existsSync(file)) throw new Error(`No scenario file at ${file}.`);
  return expandScenario(normalize(yaml.load(fs.readFileSync(file, 'utf8')), file));
}

/** Like `loadScenario`, but also appends this specific run's own
 * dynamically-appended events (dynamicEvents.ts) after the static file's
 * own (already `expandScenario`-expanded) ones - the one place a live,
 * interactively-driven case's events actually become visible to
 * Step/Play/Timeline/Graph. A run with no dynamic events behaves exactly
 * like plain `loadScenario`. */
export function loadScenarioForRun(scenariosDir: string, dataDir: string, scenarioId: string, scenarioRunId: string): Scenario {
  const scenario = loadScenario(scenariosDir, scenarioId);
  const dynamic = new DynamicEventsStore(dataDir, scenarioRunId).list();
  if (dynamic.length === 0) return scenario;
  return { ...scenario, events: [...scenario.events, ...dynamic] };
}

export function listScenarios(scenariosDir: string): string[] {
  if (!fs.existsSync(scenariosDir)) return [];
  return fs.readdirSync(scenariosDir)
    .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
    .map((entry) => entry.replace(/\.ya?ml$/, ''));
}
