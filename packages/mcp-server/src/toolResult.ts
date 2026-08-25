import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { FormbuilderApiError } from './apiClient.js';

/** Every tool in this server does the same thing: call the Forms API and
 * hand back JSON. These two helpers keep that uniform, including turning a
 * failed API call into a normal (non-throwing) tool error result the agent
 * can read and react to, instead of an opaque transport-level failure. */
export function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function toolError(error: unknown): CallToolResult {
  if (error instanceof FormbuilderApiError) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Forms API error (HTTP ${error.status}): ${error.message}${error.body ? `\n${JSON.stringify(error.body, null, 2)}` : ''}` }],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: `Unexpected error: ${message}` }] };
}

export async function toResult(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await work());
  } catch (error) {
    return toolError(error);
  }
}
