import type { FormDataProvider } from 'core';
import { ehrbaseDataProvider } from './ehrbaseDataProvider';
import { n8nDataProvider } from './n8nDataProvider';

export interface DataProviderSummary {
  id: string;
  displayName: string;
  capabilities: readonly string[];
}

class DataProviderRegistry {
  private readonly providers = new Map<string, FormDataProvider>();

  public register(provider: FormDataProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`Data provider ${provider.id} is already registered`);
    this.providers.set(provider.id, provider);
  }

  public get(id: string): FormDataProvider | undefined {
    return this.providers.get(id);
  }

  public list(): DataProviderSummary[] {
    return Array.from(this.providers.values(), (provider) => ({ id: provider.id, displayName: provider.displayName, capabilities: [...provider.capabilities] }));
  }
}

export const dataProviderRegistry = new DataProviderRegistry();
dataProviderRegistry.register(ehrbaseDataProvider);
dataProviderRegistry.register(n8nDataProvider);

export function getDataProvider(id = 'ehrbase'): FormDataProvider {
  const provider = dataProviderRegistry.get(id);
  if (!provider) throw new Error(`Unknown data provider: ${id}`);
  return provider;
}
