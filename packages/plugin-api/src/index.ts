// The package entry is the only public contract: consumers import from
// 'plugin-api', never from dist/manifest, dist/contracts or dist/registry.
export * from './manifest';
export * from './contracts';
export { PluginRegistry, withTimeout } from './registry';
