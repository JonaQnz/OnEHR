import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EhrbaseError } from './ehrbaseClient.js';

/** Same shape as packages/mcp-server/src/toolResult.ts - a failed EHRbase
 * call becomes a normal (non-throwing) tool error result the agent can read
 * and react to, not an opaque transport-level failure. */
export function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

export function toolError(error: unknown): CallToolResult {
  if (error instanceof EhrbaseError) {
    return {
      isError: true,
      content: [{ type: 'text', text: `EHRbase error (HTTP ${error.status}): ${error.message}${error.body ? `\n${typeof error.body === 'string' ? error.body : JSON.stringify(error.body, null, 2)}` : ''}` }],
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
