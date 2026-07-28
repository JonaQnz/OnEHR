import { AqlRequest, AqlResponse } from '../types/aqlPrefill';

export interface AqlClientOptions {
  baseUrl?: string;
  pluginActionUrl?: string;
}

export class AqlClient {
  private readonly baseUrl: string;

  constructor(options: AqlClientOptions = {}) {
    this.baseUrl = (options.baseUrl || options.pluginActionUrl || '/api/plugins/actions/org.openehr.aql-prefill/execute-aql').replace(/\/$/, '');
  }

  public async executeQuery(request: AqlRequest, customHeaders: Record<string, string> = {}): Promise<AqlResponse> {
    const isDirectBackendProxy = this.baseUrl.includes('/api/plugins/actions/');
    const url = isDirectBackendProxy ? this.baseUrl : `${this.baseUrl}/query/aql`;

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...customHeaders,
    };

    const hasParams = request.parameters && Object.keys(request.parameters).length > 0;
    const bodyPayload = isDirectBackendProxy
      ? { data: { query: request.query, parameters: request.parameters || {} } }
      : (hasParams ? { q: request.query, query_parameters: request.parameters } : { q: request.query });

    console.log(`[AqlClient] Sending POST request to: ${url}`);
    console.log(`[AqlClient] Headers:`, JSON.stringify({ ...headers, Authorization: headers.Authorization ? `${headers.Authorization.slice(0, 15)}...` : 'NONE' }));
    console.log(`[AqlClient] Body payload:`, JSON.stringify(bodyPayload, null, 2));

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyPayload),
      credentials: 'include',
    });

    const responseText = await response.text();
    let responseData: any = {};
    try {
      responseData = JSON.parse(responseText);
    } catch (_e) {
      responseData = { rawText: responseText };
    }

    console.log(`[AqlClient] Response status: ${response.status} ${response.statusText}`);
    console.log(`[AqlClient] Response body:`, JSON.stringify(responseData, null, 2).slice(0, 1000));

    if (!response.ok) {
      const errorMessage = responseData.error || responseData.message || responseText || `AQL Query Execution Failed (HTTP ${response.status})`;
      console.error(`[AqlClient] Query Error (${response.status}):`, errorMessage);
      throw new Error(errorMessage);
    }

    if (isDirectBackendProxy && responseData.data?.rawResult) {
      return responseData.data.rawResult as AqlResponse;
    }

    return responseData as AqlResponse;
  }
}
