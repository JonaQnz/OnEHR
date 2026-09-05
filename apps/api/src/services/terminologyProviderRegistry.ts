import type { TerminologyProvider } from 'core';
import { pluginRegistry } from '../plugins/pluginRegistry';

export interface TerminologyProviderSummary {
  id: string;
  displayName: string;
  capabilities: readonly string[];
}

/**
 * Mirrors `dataProviderRegistry.ts` exactly, for terminology. Unlike that
 * registry (which hardcodes EHRbase as the one provider every deployment
 * needs), **no terminology provider is built in here** - every terminology
 * backend (HAPI or otherwise) is entirely optional and only exists when its
 * plugin is installed and activated. A deployment with zero terminology
 * plugins is fully valid: `list()` returns `[]`, `get(id)` returns
 * `undefined` for anything, and every codeMappings field without an
 * explicit `providerId` keeps behaving exactly as it always has (see
 * canonical/index.ts's CodeMappingTerminologyOption.providerId doc comment).
 */
class TerminologyProviderRegistry {
  public get(id: string): TerminologyProvider | undefined {
    return pluginRegistry.getTerminologyProvider(id);
  }

  public list(): TerminologyProviderSummary[] {
    return pluginRegistry.listTerminologyProviders().map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      capabilities: [...provider.capabilities],
    }));
  }
}

export const terminologyProviderRegistry = new TerminologyProviderRegistry();
