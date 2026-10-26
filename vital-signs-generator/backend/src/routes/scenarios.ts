import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { dryRun } from '../engine/submission/dryRun';
import { runGeneration } from '../engine/submission/compositionRunner';
import { vitalSignsAdapter } from '../engine/openehrAdapter/vitalSignsAdapter';
import type { FormsApiClient } from '../formsApiClient';
import type { GenerationProgress, GenerationTarget, TimepointResult } from '../engine/submission/compositionRunner';
import type { Scenario } from '../../../shared/types';

interface GenerationJob {
  status: 'running' | 'done';
  progress: GenerationProgress;
}

const jobs = new Map<string, GenerationJob>();

export function createScenarioRoutes(api: FormsApiClient) {
  const router = Router();

  /** No HTTP calls to the Forms API at all - same `buildTimepoints` the
   * real run uses, just for the preview chart. */
  router.post('/preview', (req, res) => {
    const scenario = req.body as Scenario;
    try {
      const timepoints = dryRun(scenario);
      res.json({ timepoints });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  /** Starts a real generation run in the background, returns a jobId to
   * poll via GET /:jobId for progress - a full run against a real Forms
   * API/EHRbase instance can take a while (one composition-session/
   * form-session/patch/submit round trip per timepoint). */
  router.post('/generate', (req, res) => {
    const { scenario, target } = req.body as { scenario: Scenario; target: GenerationTarget };
    let timepoints;
    try {
      timepoints = dryRun(scenario);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const jobId = randomUUID();
    const job: GenerationJob = { status: 'running', progress: { completed: 0, total: timepoints.length, results: [] } };
    jobs.set(jobId, job);

    runGeneration(api, vitalSignsAdapter, scenario, target, (progress) => {
      job.progress = progress;
    })
      .then((results: TimepointResult[]) => {
        job.status = 'done';
        job.progress = { completed: results.length, total: results.length, results };
      })
      .catch((error) => {
        job.status = 'done';
        job.progress = {
          ...job.progress,
          results: [...job.progress.results, { timestamp: '', status: 'error', error: error instanceof Error ? error.message : String(error) }],
        };
      });

    res.json({ jobId, total: timepoints.length });
  });

  router.get('/generate/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Unknown jobId' });
      return;
    }
    res.json(job);
  });

  return router;
}
