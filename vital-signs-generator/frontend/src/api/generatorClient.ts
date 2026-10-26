import type { Scenario, Timepoint } from '../../../shared/types';

const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL as string | undefined) || 'http://localhost:4300';

/** The frontend never calls the Forms API directly - only this local
 * backend does (see README.md: avoids the CORS/cookie issues a pure
 * browser client would hit against apps/api). */

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

async function json<T>(response: Response): Promise<T> {
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error((parsed && (parsed.error || parsed.message)) || `HTTP ${response.status}`);
  return parsed as T;
}

export async function previewScenario(scenario: Scenario): Promise<Timepoint[]> {
  const response = await fetch(`${BACKEND_URL}/api/scenarios/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scenario),
  });
  const body = await json<{ timepoints: Timepoint[] }>(response);
  return body.timepoints;
}

export async function startGeneration(scenario: Scenario, target: GenerationTarget): Promise<{ jobId: string; total: number }> {
  const response = await fetch(`${BACKEND_URL}/api/scenarios/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario, target }),
  });
  return json(response);
}

export async function getGenerationProgress(jobId: string): Promise<{ status: 'running' | 'done'; progress: GenerationProgress }> {
  const response = await fetch(`${BACKEND_URL}/api/scenarios/generate/${jobId}`);
  return json(response);
}

export async function listPatients(): Promise<Array<{ patientId: string; ehrId: string; firstName?: string; lastName?: string }>> {
  const response = await fetch(`${BACKEND_URL}/api/patients`);
  return json(response);
}

export async function createPatient(input: { patientId: string; firstName: string; lastName: string }): Promise<{ patient: { patientId: string; ehrId: string } }> {
  const response = await fetch(`${BACKEND_URL}/api/patients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return json(response);
}
