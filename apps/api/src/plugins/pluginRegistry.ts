import path from 'path';
import { FormBuilderPlugin, PluginLogger, PluginManifest, PluginRegistry } from 'plugin-api';
import { getConfig } from '../services/configService';

const logger: PluginLogger = {
  debug: (message, details) => console.debug(`[PLUGIN] ${message}`, details || ''),
  info: (message, details) => console.info(`[PLUGIN] ${message}`, details || ''),
  warn: (message, details) => console.warn(`[PLUGIN] ${message}`, details || ''),
  error: (message, details) => console.error(`[PLUGIN] ${message}`, details || ''),
};

export interface PluginPackageStatus {
  packageName: string;
  enabled: boolean;
  manifest?: PluginManifest;
  error?: string;
}

export const pluginRegistry = new PluginRegistry(logger);
const loadedPackages = new Map<string, string>();
const failedPackages = new Map<string, string>();
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function normalizePackageName(value: string): string {
  const packageName = value.trim();
  if (!packageNamePattern.test(packageName)) {
    throw new Error('Plugin package names must be npm package names, not file paths');
  }
  return packageName;
}

function parsePackageNames(configured?: string): string[] {
  return Array.from(new Set((configured || '').split(',').map((name) => name.trim()).filter(Boolean).map(normalizePackageName)));
}

export function getConfiguredPluginPackages(): string[] {
  const persisted = (getConfig().pluginPackages || []).map(normalizePackageName);
  const fromEnvironment = parsePackageNames(process.env.FORM_BUILDER_PLUGINS);
  return Array.from(new Set([...persisted, ...fromEnvironment]));
}

function resolvePlugin(moduleValue: unknown, packageName: string): FormBuilderPlugin {
  const moduleRecord = moduleValue as { default?: unknown; plugin?: unknown };
  const candidate = moduleRecord?.default || moduleRecord?.plugin || moduleValue;
  if (!candidate || typeof candidate !== 'object') {
    throw new Error(`Package ${packageName} does not export a Form Builder plugin`);
  }
  return candidate as FormBuilderPlugin;
}

export async function loadPluginPackage(packageName: string): Promise<PluginManifest> {
  const normalizedName = normalizePackageName(packageName);
  const alreadyLoadedId = loadedPackages.get(normalizedName);
  if (alreadyLoadedId) {
    const existing = pluginRegistry.getManifests().find((manifest) => manifest.id === alreadyLoadedId);
    if (existing) return existing;
    loadedPackages.delete(normalizedName);
    failedPackages.delete(normalizedName);
  }

  let loaded: unknown;
  try {
    loaded = require(normalizedName);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown module error';
    const failure = `Unable to load plugin ${normalizedName}: ${message}`;
    failedPackages.set(normalizedName, failure);
    throw new Error(failure);
  }

  try {
    const plugin = resolvePlugin(loaded, normalizedName);
    await pluginRegistry.register(plugin);
    loadedPackages.set(normalizedName, plugin.manifest.id);
    failedPackages.delete(normalizedName);
    return plugin.manifest;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown activation error';
    const failure = `Unable to activate plugin ${normalizedName}: ${message}`;
    failedPackages.set(normalizedName, failure);
    throw new Error(failure);
  }
}

/** Node caches every file a `require()`d package pulls in (not just its
 * entry point), keyed by resolved absolute path - so without this, unloading
 * a plugin and loading it again would silently keep running the exact same
 * cached code, not whatever changed on disk since. Only the plugin's own
 * package directory is cleared, not its private node_modules if it has one,
 * to avoid disturbing dependencies that may be shared elsewhere. */
function clearPluginRequireCache(packageName: string): void {
  let packageRoot: string;
  try {
    packageRoot = path.dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    try { packageRoot = path.dirname(require.resolve(packageName)); }
    catch { return; }
  }
  for (const cachedPath of Object.keys(require.cache)) {
    if (cachedPath === packageRoot || cachedPath.startsWith(packageRoot + path.sep)) {
      delete require.cache[cachedPath];
    }
  }
}

export function unloadPluginPackage(packageName: string): boolean {
  const normalizedName = normalizePackageName(packageName);
  const pluginId = loadedPackages.get(normalizedName);
  if (!pluginId) return false;
  loadedPackages.delete(normalizedName);
  failedPackages.delete(normalizedName);
  clearPluginRequireCache(normalizedName);
  return pluginRegistry.unregister(pluginId);
}

export function getPluginPackageStatuses(): PluginPackageStatus[] {
  const manifests = pluginRegistry.getManifests();
  return getConfiguredPluginPackages().map((packageName) => {
    const pluginId = loadedPackages.get(packageName);
    const manifest = manifests.find((entry) => entry.id === pluginId);
    return { packageName, enabled: Boolean(manifest), manifest, error: manifest ? undefined : failedPackages.get(packageName) };
  });
}

export async function loadConfiguredPlugins(configured?: string): Promise<void> {
  const packageNames = configured === undefined ? getConfiguredPluginPackages() : parsePackageNames(configured);
  for (const packageName of packageNames) {
    try {
      await loadPluginPackage(packageName);
    } catch (error) {
      logger.error('Configured plugin could not be loaded', { packageName, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
