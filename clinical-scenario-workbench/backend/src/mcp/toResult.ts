import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { FormbuilderApiError } from '../apiClient';
import { PlannerValidationError } from '../agent/planner';

/** Mirrors packages/mcp-server/src/toolResult.ts's own convention (copied,
 * not imported - this project stays decoupled from the main repo's
 * workspace graph, see README.md): every tool calls the same work, hands
 * back JSON, and turns a failure into a normal (non-throwing) tool error
 * result the agent can read and react to - including surfacing a
 * PlannerValidationError's actual issue list, not just its message string,
 * so an agent driving this via MCP can see exactly which Form/Blueprint/
 * Reference check failed. */
export function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function toolError(error: unknown): CallToolResult {
  if (error instanceof PlannerValidationError) {
    return { isError: true, content: [{ type: 'text', text: `Validation failed: ${error.issues.join('; ')}` }] };
  }
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
