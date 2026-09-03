import axios from 'axios';
import { getEhrbaseRequestConfig } from './ehrbaseConnectionPlugins';
import { logIntegrationCall } from './integrationCallLogService';

/**
 * Read/write access to the RM `EHR_STATUS` resource's two admin-facing
 * flags - `is_queryable` (whether this EHR is included in AQL result sets
 * at all) and `is_modifiable` (whether EHRbase accepts any new Composition
 * version against this EHR). Both are enforced by EHRbase itself server-side
 * - this service never duplicates that enforcement, it only exposes the two
 * flags as an admin toggle (see PatientDetail.tsx's "Verwaltung" card).
 *
 * Deliberately EHR-wide, not per Form-Session/draft - openEHR has no
 * per-Composition equivalent of `is_modifiable`. A single form's own
 * draft/submit distinction is handled by the unrelated, much finer-grained
 * `commitWithLifecycle()` (submit/draft change-type headers).
 *
 * Not cached in Forms' own DB (unlike e.g. Patient.fhirPatientId) - always
 * read live from EHRbase, so there is no drift between the two systems.
 */
export interface EhrStatusFlags {
  isQueryable: boolean;
  isModifiable: boolean;
}

function statusUrl(ehrbaseUrl: string, ehrId: string): string {
  return `${ehrbaseUrl}/ehr/${encodeURIComponent(ehrId)}/ehr_status`;
}

export async function getEhrStatusFlags(ehrId: string): Promise<EhrStatusFlags> {
  const { ehrbaseUrl, headers, auth } = await getEhrbaseRequestConfig();
  const url = statusUrl(ehrbaseUrl, ehrId);
  try {
    const response = await axios.get(url, { headers, ...(auth ? { auth } : {}) });
    logIntegrationCall({
      protocol: 'openehr', resourceType: 'EHR_STATUS', operation: 'read', method: 'GET', url,
      responseBody: response.data, statusCode: response.status, success: true, ehrId,
    });
    return {
      isQueryable: response.data?.is_queryable !== false,
      isModifiable: response.data?.is_modifiable !== false,
    };
  } catch (error: any) {
    logIntegrationCall({
      protocol: 'openehr', resourceType: 'EHR_STATUS', operation: 'read', method: 'GET', url,
      responseBody: error?.response?.data, statusCode: error?.response?.status,
      success: false, errorMessage: error instanceof Error ? error.message : String(error), ehrId,
    });
    throw error;
  }
}

/**
 * Read-modify-write, per the openEHR ITS-REST contract (PUT requires the
 * current version as `If-Match` and the full EHR_STATUS body, not a patch).
 * No retry-on-conflict here, unlike ehrDirectoryService's directory PUT -
 * this is a rare, deliberate admin action, not something submitted
 * automatically on every form save, so a lost race just means "try again",
 * surfaced as a normal error instead of silently retried.
 */
export async function updateEhrStatusFlags(ehrId: string, patch: Partial<EhrStatusFlags>): Promise<EhrStatusFlags> {
  const { ehrbaseUrl, headers, auth } = await getEhrbaseRequestConfig();
  const url = statusUrl(ehrbaseUrl, ehrId);
  const current = await axios.get(url, { headers, ...(auth ? { auth } : {}) });
  // Confirmed live against the active EHRbase connection (2026-09-03): the
  // `If-Match` value this CDR actually wants is the bare, unquoted
  // `uid.value` (a full OBJECT_VERSION_ID string, e.g. "xxx::system::1") -
  // NOT the quoted `ETag` response header value, which this CDR rejects
  // with a misleading "UUID string too large" 400 (it also rejects that
  // same value with the `uid` field stripped from the body, so the error
  // is about the header, not the body). PUT also returns an empty body on
  // success here, not the updated EHR_STATUS - the returned flags below are
  // simply what was just requested, not read back from the response.
  const etag: string | undefined = current.data?.uid?.value;
  const body = {
    ...current.data,
    is_queryable: patch.isQueryable ?? current.data?.is_queryable !== false,
    is_modifiable: patch.isModifiable ?? current.data?.is_modifiable !== false,
  };
  const putHeaders = { ...headers, ...(etag ? { 'If-Match': etag } : {}) };
  try {
    const response = await axios.put(url, body, { headers: putHeaders, ...(auth ? { auth } : {}) });
    logIntegrationCall({
      protocol: 'openehr', resourceType: 'EHR_STATUS', operation: 'update', method: 'PUT', url,
      requestBody: body, responseBody: response.data, statusCode: response.status, success: true, ehrId,
    });
    return { isQueryable: body.is_queryable, isModifiable: body.is_modifiable };
  } catch (error: any) {
    logIntegrationCall({
      protocol: 'openehr', resourceType: 'EHR_STATUS', operation: 'update', method: 'PUT', url,
      requestBody: body, responseBody: error?.response?.data, statusCode: error?.response?.status,
      success: false, errorMessage: error instanceof Error ? error.message : String(error), ehrId,
    });
    throw error;
  }
}
