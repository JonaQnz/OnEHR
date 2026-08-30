import type { APIRequestContext } from '@playwright/test';

const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:3001';

export interface TestPatient {
  id: string;
  patientId: string;
  firstName: string;
  lastName: string;
}

/** Creates a real patient (and, via createPatient's own EHRbase call, a
 * real EHR) through the same API the app's own "Patient anlegen" flow
 * uses - not a mock/fixture. Tagged with an "E2E-" patientId prefix and a
 * distinctive surname so it's trivially identifiable (and safely
 * deletable) among the rest of this dev instance's data; there's no
 * DELETE /api/patients endpoint yet, so cleanup here would have nothing to
 * call - see apps/api/src/routes/patientRoutes.ts. */
export async function createTestPatient(request: APIRequestContext): Promise<TestPatient> {
  const patientId = `E2E-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const response = await request.post(`${API_BASE_URL}/api/patients`, {
    data: { patientId, firstName: 'E2E', lastName: `Testpatient ${patientId}`, birthDate: '1990-01-01', gender: 'other' },
  });
  if (!response.ok()) throw new Error(`Failed to create E2E test patient (${response.status()}): ${await response.text()}`);
  const body = await response.json();
  return body.patient as TestPatient;
}
