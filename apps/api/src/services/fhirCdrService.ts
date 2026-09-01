import axios from 'axios';
import prisma from '../db/prisma';
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

// Pulls the FHIR patient id a resource is "about" out of its own body, so
// generic writes (Encounter, Appointment, Procedure, ...) can be attributed
// to a patient the same way patient-specific code paths already are -
// without every call site of createFhirResource having to pass one in.
// Patient itself has no such reference (the id only exists after create,
// picked up separately below); Appointment carries it in `participant`
// instead of `subject`/`patient`. Covers every reference shape actually
// used by create_fhir_resource callers so far - extend as new resource
// types show up, rather than trying to be exhaustively FHIR-spec-complete.
function extractFhirPatientId(resourceType: string, resource: Record<string, unknown>): string | undefined {
  const refToId = (ref: unknown): string | undefined => {
    if (typeof ref !== 'string') return undefined;
    const match = ref.match(/^Patient\/(.+)$/);
    return match?.[1];
  };
  if (resourceType === 'Appointment') {
    const participants = Array.isArray((resource as any).participant) ? (resource as any).participant : [];
    for (const participant of participants) {
      const id = refToId(participant?.actor?.reference);
      if (id) return id;
    }
    return undefined;
  }
  const subjectRef = (resource as any).subject?.reference;
  const patientRef = (resource as any).patient?.reference;
  return refToId(subjectRef) ?? refToId(patientRef);
}

// Resolves a FHIR patient id back to Forms' own ehrId/patientId, so a
// generic FHIR write's log row is filterable by the same ehrId/patientId
// query params the Patient Detail debug tab and Bruno export already use -
// no export route/query changes needed. Forms' own Patient table has no
// fhirPatientId column (ehrId is the one thing everything else keys off,
// see patientService.createPatient's own comment on this) so this can't be
// a local lookup - instead it reads the FHIR Patient resource's own
// `identifier` entry for the EHRbase-linked EHR id (system
// "ehrbase://love.is.in.the.ehr", the same linkage createFhirPatient
// itself relies on) and resolves *that* against the local Patient table.
// Best-effort and fire-and-forget-safe: never awaited before the actual
// resource POST, and a resource written against a patient Forms doesn't
// know about (or a lookup failure) just logs without that linkage, same as
// before this fix - it must never delay or break the real write.
const EHR_LINK_IDENTIFIER_SYSTEM = 'ehrbase://love.is.in.the.ehr';
async function resolveLocalPatientIds(fhirPatientId: string | undefined): Promise<{ ehrId?: string; patientId?: string }> {
  if (!fhirPatientId) return {};
  try {
    const fhirPatient = await getFhirResource('Patient', fhirPatientId);
    const ehrId: string | undefined = (fhirPatient?.identifier ?? [])
      .find((identifier: any) => identifier?.system === EHR_LINK_IDENTIFIER_SYSTEM)?.value;
    if (!ehrId) return {};
    const patient = await prisma.patient.findUnique({ where: { ehrId }, select: { patientId: true } });
    return { ehrId, patientId: patient?.patientId };
  } catch {
    return {};
  }
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
  // Patient has no self-reference to extract before creation; every other
  // resource type points at the patient it's about via subject/patient
  // (or participant, for Appointment) - see extractFhirPatientId.
  const fhirPatientId = resourceType === 'Patient' ? undefined : extractFhirPatientId(resourceType, resource);
  try {
    const response = await axios.post(url, resource, { headers, auth, timeout: 20_000 });
    // Fire-and-forget: resolveLocalPatientIds does its own extra FHIR GET,
    // which must never sit in front of (or delay the response for) the
    // write it's only describing.
    const loggedFhirPatientId = fhirPatientId ?? (resourceType === 'Patient' ? response.data?.id : undefined);
    resolveLocalPatientIds(loggedFhirPatientId).then(({ ehrId, patientId }) => {
      logIntegrationCall({
        protocol: 'fhir', resourceType, operation: 'create', method: 'POST', url,
        requestBody: resource, responseBody: response.data, statusCode: response.status, success: true,
        fhirPatientId: loggedFhirPatientId, ehrId, patientId,
      });
    });
    return response.data;
  } catch (error: any) {
    resolveLocalPatientIds(fhirPatientId).then(({ ehrId, patientId }) => {
      logIntegrationCall({
        protocol: 'fhir', resourceType, operation: 'create', method: 'POST', url,
        requestBody: resource, responseBody: error?.response?.data, statusCode: error?.response?.status,
        success: false, errorMessage: describeError(error),
        fhirPatientId, ehrId, patientId,
      });
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
