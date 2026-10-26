import fs from 'node:fs';
import path from 'node:path';

/** Every piece of per-scenario-run state (World State, Entity Registry,
 * Capability Registry, Resource Forms, Workflows, Activity Log) is a single
 * JSON file under `<dataDir>/runs/<scenarioRunId>/<name>.json` - no database,
 * per the plan's persistence decision. This is the one place that reads/
 * writes those files, so every store shares identical, correct
 * read-missing-as-default / atomic-write behavior instead of five ad hoc
 * copies of the same few lines.
 */

export function runDir(dataDir: string, scenarioRunId: string): string {
  return path.join(dataDir, 'runs', scenarioRunId);
}

function filePath(dataDir: string, scenarioRunId: string, name: string): string {
  return path.join(runDir(dataDir, scenarioRunId), `${name}.json`);
}

export function readJsonFile<T>(dataDir: string, scenarioRunId: string, name: string, fallback: T): T {
  const file = filePath(dataDir, scenarioRunId, name);
  if (!fs.existsSync(file)) return fallback;
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return fallback;
  return JSON.parse(raw) as T;
}

/** Writes via a temp file + rename so a crash mid-write never leaves a
 * truncated/corrupt JSON file behind - the one thing that matters for a
 * plain-file store with no transactions. */
export function writeJsonFile(dataDir: string, scenarioRunId: string, name: string, value: unknown): void {
  const dir = runDir(dataDir, scenarioRunId);
  fs.mkdirSync(dir, { recursive: true });
  const file = filePath(dataDir, scenarioRunId, name);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Every scenario run directory that currently exists, newest first - backs
 * "list past/active runs" in the UI. */
export function listScenarioRuns(dataDir: string): string[] {
  const runsDir = path.join(dataDir, 'runs');
  if (!fs.existsSync(runsDir)) return [];
  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

/** Deletes one scenario run's entire directory - the only thing `Reset
 * Scenario` (spec section 3) is allowed to touch locally. Deleting HIP's own
 * resources for the run is a separate, explicit step (see agent/planner.ts's
 * resetScenario) - this alone only clears the local World State/Registry
 * mirror. */
export function deleteScenarioRun(dataDir: string, scenarioRunId: string): void {
  const dir = runDir(dataDir, scenarioRunId);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}
