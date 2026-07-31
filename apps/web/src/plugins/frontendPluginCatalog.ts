import type { FrontendPluginModule, FrontendPluginRegistration } from 'plugin-api';

type FrontendPluginLoader = () => Promise<FrontendPluginModule>;

// This is the web host's explicit integration boundary. Plugins expose only
// their documented package entry points; application components never import
// plugin implementation files.
const frontendPluginLoaders: readonly FrontendPluginLoader[] = [
  () => import('formbuilder-plugin-aql-prefill'),
  () => import('formbuilder-plugin-iframe/frontend'),
];

export async function loadFrontendPluginRegistrations(): Promise<FrontendPluginRegistration[]> {
  const modules = await Promise.all(frontendPluginLoaders.map((load) => load()));
  return modules.flatMap((module) => module.registerFrontendPlugin ? [module.registerFrontendPlugin] : []);
}
