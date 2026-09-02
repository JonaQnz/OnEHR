import type { FormDataProvider } from 'core';
import { ehrbaseDataProvider } from './ehrbaseDataProvider';
import { pluginRegistry } from '../plugins/pluginRegistry';

export interface DataProviderSummary {
  id: string;
  displayName: string;
  capabilities: readonly string[];
}

/**
 * Only genuinely built-in providers live here, hardcoded at import time -
 * currently just EHRbase, since it's the one provider every deployment of
 * this app needs regardless of which optional plugins are installed. A
 * provider that only makes sense alongside its own plugin (n8n workflow
 * submission alongside example-n8n-plugin, previously hardcoded here too -
 * see the `[[n8n-provider-moved-into-plugin]]` memory) is registered by
 * that plugin itself via `context.registerFormDataProvider()` and looked up
 * through `pluginRegistry` below, so it only exists when the plugin
 * providing it is actually loaded.
 */
class DataProviderRegistry {
  private readonly providers = new Map<string, FormDataProvider>();

  public register(provider: FormDataProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`Data provider ${provider.id} is already registered`);
    this.providers.set(provider.id, provider);
  }

  public get(id: string): FormDataProvider | undefined {
    return this.providers.get(id) || pluginRegistry.getDataProvider(id);
  }

  public list(): DataProviderSummary[] {
    const builtIn = Array.from(this.providers.values());
    const fromPlugins = pluginRegistry.listDataProviders();
    return [...builtIn, ...fromPlugins].map((provider) => ({ id: provider.id, displayName: provider.displayName, capabilities: [...provider.capabilities] }));
  }
}

export const dataProviderRegistry = new DataProviderRegistry();
dataProviderRegistry.register(ehrbaseDataProvider);

export function getDataProvider(id = 'ehrbase'): FormDataProvider {
  const provider = dataProviderRegistry.get(id);
  if (!provider) throw new Error(`Unknown data provider: ${id}`);
  return provider;
}
