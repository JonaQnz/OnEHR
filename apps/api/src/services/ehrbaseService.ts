import axios from 'axios';
import { getEhrbaseRequestConfig } from './ehrbaseConnectionPlugins';

export interface EhrbaseTemplateSummary {
  template_id: string;
  version: string;
  concept: string;
  archetype_id: string;
  created_timestamp: string;
}

export async function listRemoteTemplates(): Promise<EhrbaseTemplateSummary[]> {
  const { ehrbaseUrl, headers, auth } = await getEhrbaseRequestConfig();
  const url = `${ehrbaseUrl}/definition/template/adl1.4`;

  try {
    const response = await axios.get(url, { headers, auth });
    return response.data || [];
  } catch (error: any) {
    console.error('[ehrbaseService] Failed to list templates:', error.message);
    throw new Error('Failed to fetch templates from EHRbase: ' + (error.response?.data?.message || error.message));
  }
}

export async function getRemoteWebTemplate(templateId: string): Promise<any> {
  const { ehrbaseUrl, headers, auth } = await getEhrbaseRequestConfig();
  // Ensure we get the WebTemplate JSON
  headers['Accept'] = 'application/openehr.wt+json';
  const url = `${ehrbaseUrl}/definition/template/adl1.4/${encodeURIComponent(templateId)}`;

  try {
    const response = await axios.get(url, { headers, auth });
    return response.data;
  } catch (error: any) {
    console.error(`[ehrbaseService] Failed to get WebTemplate for ${templateId}:`, error.message);
    throw new Error(`Failed to fetch WebTemplate ${templateId} from EHRbase: ` + (error.response?.data?.message || error.message));
  }
}

export interface EhrbaseStoredQueryDefinition {
  /** The fully qualified name EHRbase stores it under, e.g. "custom::aktive-diagnosen-anzahl". */
  name: string;
  q: string;
  type: string;
  version: string;
  saved: string;
}

/** Turns an executed-query's {columns, rows} result set into the row-object
 * shape the rest of Forms works with. Shared by both the stored-query path
 * (executeStoredQuery) and the ad-hoc/debug path (aqlFunctionService's
 * executeAqlQuery) so the two don't drift. */
export function rowsFromResultSet(data: any): Record<string, unknown>[] {
  if (!data || !Array.isArray(data.rows) || !Array.isArray(data.columns)) return Array.isArray(data?.rows) ? data.rows : [];
  const columns = data.columns.map((column: any) => column.name);
  return data.rows.map((row: any[]) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((column: string, index: number) => { obj[column] = row[index]; });
    return obj;
  });
}

/** Lists every query defined on EHRbase's own openEHR Query Service - the
 * real source of truth for what queries exist, independent of anything
 * Forms has ever registered locally. */
export async function listStoredQueries(): Promise<EhrbaseStoredQueryDefinition[]> {
  const { ehrbaseUrl, headers, auth } = await getEhrbaseRequestConfig();
  try {
    const response = await axios.get(`${ehrbaseUrl}/definition/query`, { headers, auth });
    return Array.isArray(response.data) ? response.data : [];
  } catch (error: any) {
    console.error('[ehrbaseService] Failed to list stored queries:', error.message);
    throw new Error('Failed to fetch stored queries from EHRbase: ' + (error.response?.data?.message || error.message));
  }
}

/**
 * Defines (or re-defines) a named AQL query directly on EHRbase's stored-
 * query registry. EHRbase auto-bumps the version on every PUT to an
 * existing name and keeps every prior version retrievable - there is no
 * delete in the openEHR Query Service spec, so once a name is defined here
 * it is permanent. Forms only ever reads back the latest version.
 */
export async function putStoredQuery(qualifiedName: string, aql: string): Promise<EhrbaseStoredQueryDefinition> {
  const { ehrbaseUrl, headers, auth } = await getEhrbaseRequestConfig();
  try {
    const response = await axios.put(`${ehrbaseUrl}/definition/query/${encodeURIComponent(qualifiedName)}`, { q: aql, type: 'AQL' }, { headers, auth });
    return response.data;
  } catch (error: any) {
    console.error(`[ehrbaseService] Failed to define stored query ${qualifiedName}:`, error.message);
    throw new Error('Failed to define stored query on EHRbase: ' + (error.response?.data?.message || error.message));
  }
}

/** Executes a query already defined on EHRbase (latest version) with
 * server-side parameter binding - the query text uses `$paramName`
 * placeholders, bound via `query_parameters`, not string-substituted
 * client-side the way the ad-hoc path has to. */
export async function executeStoredQuery(qualifiedName: string, parameters: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const { ehrbaseUrl, headers, auth } = await getEhrbaseRequestConfig();
  try {
    const response = await axios.post(`${ehrbaseUrl}/query/${encodeURIComponent(qualifiedName)}`, { query_parameters: parameters }, { headers, auth });
    return rowsFromResultSet(response.data);
  } catch (error: any) {
    console.error(`[ehrbaseService] Failed to execute stored query ${qualifiedName}:`, error.message);
    throw new Error(error.response?.data?.message || error.message || 'Stored query execution failed');
  }
}
