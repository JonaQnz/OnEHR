import axios from 'axios';
import { getEhrbaseRequestConfig } from './ehrbaseConnectionPlugins';
import { logIntegrationCall } from './integrationCallLogService';

/**
 * Thin client for the separate FHIR CDR connector that sits alongside
 * EHRbase (Patient/Encounter live here as native FHIR resources - openEHR
 * has no Composition-level concept of "Encounter" administrative data like
 * arrival/exit time, triage acuity, arrival mode, or discharge disposition,
 * so those are created directly as FHIR here rather than modeled as a new
 * openEHR archetype). Reuses the *same* bearer token as the active EHRbase
 * connection (confirmed: same HIP/Keycloak realm issues valid tokens for
 * both endpoints) - only the base URL differs, so this deliberately calls
 * getEhrbaseRequestConfig() rather than standing up a parallel auth plugin.
 *
 * Clinical data that DOES have a real openEHR template (Diagnosis, Vitals-
 * once-modeled, labs, ...) still goes through the normal Forms/EHRbase
 * pipeline - this service is only for the FHIR-native Patient/Encounter
 * layer plus ad-hoc verification reads against the CDR.
 */

const DEFAULT_FHIR_CDR_URL = 'https://hip-cdr-connector-fhir-plug-n-heal.plug-n-heal.sandbox1.vghip.cloud';
const FHIR_VERSION = 'R4';

// The connector serves resources under /fhir/{version}/{resource}, not bare
// /{resource} - confirmed via its own /v3/api-docs OpenAPI spec and via the
// working createFhirPatient path (ehrbaseConnectionPlugins.ts). This base
// URL includes that prefix so every call site below just appends the plain
// resource path.
function getFhirCdrBaseUrl(): string {
  const root = (process.env.FHIR_CDR_URL || DEFAULT_FHIR_CDR_URL).trim().replace(/\/$/, '');
  return `${root}/fhir/${FHIR_VERSION}`;
}

async function fhirRequestConfig() {
  const { headers, auth } = await getEhrbaseRequestConfig();
  return {
    baseUrl: getFhirCdrBaseUrl(),
    headers: { ...headers, 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' },
    auth,
  };
}

function describeError(error: any): string {
  const issues = error?.response?.data?.issue;
  if (Array.isArray(issues) && issues.length) {
    return issues.map((issue: any) => issue.diagnostics || issue.details?.text || issue.code).filter(Boolean).join('; ');
  }
  return error?.response?.data?.message || error?.message || 'Unknown FHIR CDR error';
}

/** Creates a FHIR resource (POST /{resourceType}). Returns the server's
 * representation, including the assigned `id` and any extensions (e.g. a
 * linked openEHR EHR id) the connector adds on create. */
export async function createFhirResource(resourceType: string, resource: Record<string, unknown>): Promise<any> {
  const { baseUrl, headers, auth } = await fhirRequestConfig();
  const url = `${baseUrl}/${encodeURIComponent(resourceType)}`;
  try {
    const response = await axios.post(url, resource, { headers, auth, timeout: 20_000 });
    logIntegrationCall({
      protocol: 'fhir', resourceType, operation: 'create', method: 'POST', url,
      requestBody: resource, responseBody: response.data, statusCode: response.status, success: true,
    });
    return response.data;
  } catch (error: any) {
    logIntegrationCall({
      protocol: 'fhir', resourceType, operation: 'create', method: 'POST', url,
      requestBody: resource, responseBody: error?.response?.data, statusCode: error?.response?.status,
      success: false, errorMessage: describeError(error),
    });
    console.error(`[fhirCdrService] Failed to create ${resourceType}:`, describeError(error));
    throw new Error(`Failed to create ${resourceType} on FHIR CDR: ${describeError(error)}`);
  }
}

export async function getFhirResource(resourceType: string, id: string): Promise<any> {
  const { baseUrl, headers, auth } = await fhirRequestConfig();
  try {
    const response = await axios.get(`${baseUrl}/${encodeURIComponent(resourceType)}/${encodeURIComponent(id)}`, { headers, auth, timeout: 20_000 });
    return response.data;
  } catch (error: any) {
    console.error(`[fhirCdrService] Failed to get ${resourceType}/${id}:`, describeError(error));
    throw new Error(`Failed to fetch ${resourceType}/${id} from FHIR CDR: ${describeError(error)}`);
  }
}

/** Searches a resource type (GET /{resourceType}?...). `query` values are
 * passed through as-is as search parameters (e.g. { patient: 'Patient/123',
 * code: '...' }). Returns the raw FHIR Bundle. */
export async function searchFhirResource(resourceType: string, query: Record<string, string> = {}): Promise<any> {
  const { baseUrl, headers, auth } = await fhirRequestConfig();
  try {
    const response = await axios.get(`${baseUrl}/${encodeURIComponent(resourceType)}`, { headers, auth, params: query, timeout: 20_000 });
    return response.data;
  } catch (error: any) {
    console.error(`[fhirCdrService] Failed to search ${resourceType}:`, describeError(error));
    throw new Error(`Failed to search ${resourceType} on FHIR CDR: ${describeError(error)}`);
  }
}

export async function getFhirCdrMetadata(): Promise<any> {
  const { baseUrl, headers, auth } = await fhirRequestConfig();
  try {
    const response = await axios.get(`${baseUrl}/metadata`, { headers, auth, timeout: 20_000 });
    return response.data;
  } catch (error: any) {
    console.error('[fhirCdrService] Failed to fetch CapabilityStatement:', describeError(error));
    throw new Error(`Failed to fetch FHIR CDR metadata: ${describeError(error)}`);
  }
}
