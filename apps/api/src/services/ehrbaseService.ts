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
