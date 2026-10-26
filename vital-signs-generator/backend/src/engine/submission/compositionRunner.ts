import { buildTimepoints } from '../timeline';
import type { FormsApiClient } from '../../formsApiClient';
import type { OpenEhrAdapter } from '../openehrAdapter';
import type { Scenario, Timepoint } from '../../../../shared/types';

export interface GenerationTarget {
  patientId: string;
  ehrId: string;
}

export interface TimepointResult {
  timestamp: string;
  status: 'ok' | 'error';
  compositionSessionId?: string;
  formSessionId?: string;
  error?: string;
}

export interface GenerationProgress {
  completed: number;
  total: number;
  results: TimepointResult[];
}

const RETRY_DELAY_MS = 500;
const INTER_TIMEPOINT_DELAY_MS = 75;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One fresh composition-session + form-session pair per timepoint - not an
 * optimization, a correctness requirement: `PATCH /api/form-sessions/:id`
 * replaces the whole stored `values` object rather than merging, so
 * re-patching one shared session across timepoints would silently drop
 * whichever tracks weren't due at the latest patch. `forceNew: true` is
 * belt-and-suspenders with the wrapping Composition's own
 * `storageStrategy: 'always_new'` (set at publish time, Phase 1).
 */
async function submitOneTimepoint(
  api: FormsApiClient,
  adapter: OpenEhrAdapter,
  timepoint: Timepoint,
  scenario: Scenario,
  target: GenerationTarget,
  attempt = 0,
): Promise<TimepointResult> {
  try {
    const compositionSession = await api.post<{ id: string }>('/api/composition-sessions', {
      compositionFormId: adapter.compositionFormId,
      patientId: target.patientId,
      ehrId: target.ehrId,
      mode: 'create',
      forceNew: true,
    });
    const formSession = await api.post<{ id: string }>('/api/form-sessions', {
      formId: adapter.formSectionId,
      patientId: target.patientId,
      compositionContext: { compositionSessionId: compositionSession.id, blockId: adapter.blockId },
    });
    await api.put(`/api/composition-sessions/${compositionSession.id}/blocks/${adapter.blockId}`, {
      childSessionId: formSession.id,
    });
    const values = adapter.toFormSessionValues(timepoint, scenario);
    await api.patch(`/api/form-sessions/${formSession.id}`, { values });
    await api.post(`/api/form-sessions/${formSession.id}/provider/submit`, { providerId: 'ehrbase' });

    return { timestamp: timepoint.timestamp, status: 'ok', compositionSessionId: compositionSession.id, formSessionId: formSession.id };
  } catch (error) {
    if (attempt < 1) {
      await sleep(RETRY_DELAY_MS);
      return submitOneTimepoint(api, adapter, timepoint, scenario, target, attempt + 1);
    }
    return { timestamp: timepoint.timestamp, status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

/** Runs the full scenario against a real Forms API, one Composition per
 * timepoint (Snapshot mode - see README.md). A failed timepoint (after one
 * retry) is recorded and the loop continues rather than aborting the
 * whole run - a demo dataset with 95/100 points landed is still useful. */
export async function runGeneration(
  api: FormsApiClient,
  adapter: OpenEhrAdapter,
  scenario: Scenario,
  target: GenerationTarget,
  onProgress?: (progress: GenerationProgress) => void,
): Promise<TimepointResult[]> {
  const timepoints = buildTimepoints(scenario);
  const results: TimepointResult[] = [];
  for (const timepoint of timepoints) {
    const result = await submitOneTimepoint(api, adapter, timepoint, scenario, target);
    results.push(result);
    onProgress?.({ completed: results.length, total: timepoints.length, results: [...results] });
    if (INTER_TIMEPOINT_DELAY_MS > 0) await sleep(INTER_TIMEPOINT_DELAY_MS);
  }
  return results;
}
