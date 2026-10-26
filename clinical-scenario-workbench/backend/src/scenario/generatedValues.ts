import { readJsonFile, writeJsonFile } from '../world/jsonStore';

/**
 * The "be the AI instead of an API key" mechanism: agent/generate.ts's own
 * narrow LLM-fill step needs ANTHROPIC_API_KEY, which isn't configured in
 * this deployment. Rather than block on that, this store lets whoever IS
 * acting as the agent for a given event (a human, or an assistant like
 * Claude driving this workbench through its own MCP tools/HTTP API) supply
 * the same GENERATED-policy field values an LLM call would have produced,
 * BEFORE that event actually runs (scenario/engine.ts consults this first
 * and only falls back to its own small deterministic default when nothing
 * was supplied) - one implementation, no separate "was it an LLM or a
 * person" code path, matching spec section 10's own "no separate agent
 * path" principle. Field names are event-type-specific and ergonomic
 * (`healthcareServiceName`, not a raw FHIR field path) - see
 * scenario/engine.ts's own read sites for exactly which ones each event
 * type honors.
 */
export type GeneratedValueOverrides = Record<string, unknown>;

export class GeneratedValuesStore {
  private overridesByEvent: Record<string, GeneratedValueOverrides>;

  constructor(private readonly dataDir: string, private readonly scenarioRunId: string) {
    this.overridesByEvent = readJsonFile(dataDir, scenarioRunId, 'generated-values', {});
  }

  get(eventId: string): GeneratedValueOverrides {
    return this.overridesByEvent[eventId] ?? {};
  }

  set(eventId: string, values: GeneratedValueOverrides): GeneratedValueOverrides {
    this.overridesByEvent[eventId] = { ...this.overridesByEvent[eventId], ...values };
    writeJsonFile(this.dataDir, this.scenarioRunId, 'generated-values', this.overridesByEvent);
    return this.overridesByEvent[eventId];
  }
}
