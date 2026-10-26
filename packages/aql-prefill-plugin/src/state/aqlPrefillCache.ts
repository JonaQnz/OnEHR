import { AqlPrefillCacheEntry } from '../types/aqlPrefill';

class AqlPrefillCacheStore {
  private cache = new Map<string, AqlPrefillCacheEntry>();

  public get(contextKey: string): AqlPrefillCacheEntry | undefined {
    return this.cache.get(contextKey);
  }

  public set(entry: AqlPrefillCacheEntry): void {
    this.cache.set(entry.contextKey, entry);
  }

  public invalidate(contextKey: string): void {
    this.cache.delete(contextKey);
  }

  public invalidateForConfiguration(configurationId: string): void {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.configurationId === configurationId) {
        this.cache.delete(key);
      }
    }
  }

  public clear(): void {
    this.cache.clear();
  }
}

export const aqlPrefillCache = new AqlPrefillCacheStore();
