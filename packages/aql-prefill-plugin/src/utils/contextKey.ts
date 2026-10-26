import { PrefillRuntimeContext } from '../types/aqlPrefill';

/**
 * Builds a deterministic context key for caching AQL query results.
 * Context key format: ehrId + patientId + encounterId + stringified query parameters
 */
export function buildContextKey(
  configurationId: string,
  context: PrefillRuntimeContext,
  parameters: Record<string, unknown> = {}
): string {
  const ehrId = context.ehrId || '';
  const patientId = context.patientId || '';
  const encounterId = context.encounterId || '';

  // Sort parameter keys for consistent stringification
  const sortedParamEntries = Object.keys(parameters)
    .sort()
    .map((key) => `${key}:${JSON.stringify(parameters[key])}`)
    .join('|');

  return `config:${configurationId}::ehr:${ehrId}::patient:${patientId}::encounter:${encounterId}::params:${sortedParamEntries}`;
}
