export const PLUGIN_API_VERSION = '1.0' as const;

export const PLUGIN_EXTENSION_POINTS = [
  'settings',
  'field',
  'form',
  'renderer',
  'designer',
  'runtime',
  'scripting',
  'dataProvider',
  'terminology',
  'workflow',
  'lifecycle',
  'ui',
  'widget',
] as const;

export type PluginExtensionPoint = (typeof PLUGIN_EXTENSION_POINTS)[number];

export const PLUGIN_PERMISSIONS = [
  'form:read',
  'form:write',
  'patient:read',
  'ehrbase:read',
  'ehrbase:write',
  'network:request',
] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

export interface PluginManifest {
  id: string;
  version: string;
  apiVersion: typeof PLUGIN_API_VERSION;
  name: string;
  description?: string;
  extensionPoints: readonly PluginExtensionPoint[];
  permissions?: readonly PluginPermission[];
}

export interface PluginHostInfo {
  apiVersion: typeof PLUGIN_API_VERSION;
  extensionPoints: readonly PluginExtensionPoint[];
  permissions: readonly PluginPermission[];
}

export const PLUGIN_HOST_INFO: PluginHostInfo = Object.freeze({
  apiVersion: PLUGIN_API_VERSION,
  extensionPoints: Object.freeze([...PLUGIN_EXTENSION_POINTS]),
  permissions: Object.freeze([...PLUGIN_PERMISSIONS]),
});
