import axios from 'axios';
import { getConfig } from './configService';
import { getValidToken } from './authService';

export interface EhrbaseTemplateSummary {
  template_id: string;
  version: string;
  concept: string;
  archetype_id: string;
  created_timestamp: string;
}

async function getEhrbaseRequestConfig() {
  const config = getConfig();
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
  let auth: any = undefined;

  if (config.authMode === 'keycloak') {
    const token = await getValidToken();
    headers['Authorization'] = `Bearer ${token}`;
  } else {
    auth = {
      username: config.ehrbaseUser!,
      password: config.ehrbasePass!
    };
  }

  const ehrbaseUrl = config.ehrbaseUrl!.replace(/\/$/, '');
  return { ehrbaseUrl, headers, auth };
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
