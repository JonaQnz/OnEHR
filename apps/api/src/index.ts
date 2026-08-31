import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';
import { initConfig } from './services/configService';
import { loadConfiguredPlugins } from './plugins/pluginRegistry';
import { ensureDefaultFunctionLibrary } from './services/functionLibraryBootstrap';
import { ensureBootstrapAdmin } from './services/userAuthService';
import { createApp } from './app';

// Backend plugins run in-process via require() with no sandbox (see
// pluginRegistry.ts) - a real isolation boundary would run each plugin in its
// own process/worker so a crash there can be killed without touching the
// host. Until that exists, these are the process-wide safety net: without
// them, one unguarded `.then()` anywhere in a plugin (or in our own code)
// takes the entire API down for every user, since Node terminates the
// process on an unhandled rejection by default.
//
// - unhandledRejection: overwhelmingly these are recoverable bugs (a promise
//   nobody awaited/caught), not corrupted process state. Log and keep running
//   rather than let one loose promise take everyone down.
// - uncaughtException: a synchronous throw escaped everything, which Node's
//   own docs say can leave process state inconsistent - continuing is not
//   safe. Log and exit so a supervisor (Docker's `restart: unless-stopped`,
//   see docker-compose.yml) brings the process back in seconds instead of
//   limping on in an unknown state.
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL][unhandledRejection] Unhandled promise rejection (likely a bug in a plugin or backend service); continuing.', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[FATAL][uncaughtException] Uncaught exception; exiting for the container supervisor to restart the process.', error);
  process.exitCode = 1;
  process.exit(1);
});

// Resolve the API-local environment file, independent of the process working
// directory (for example when started as `node apps/api/dist/index.js`).
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
initConfig();

// Axios Logging Interceptors for Deep Debugging
axios.interceptors.request.use((config) => {
  console.debug(`[HTTP REQUEST] ${config.method?.toUpperCase() || 'GET'}`);
  return config;
}, (error) => {
  console.error(`[AXIOS REQUEST ERROR]`, error.message);
  return Promise.reject(error);
});

axios.interceptors.response.use((response) => {
  console.debug(`[HTTP RESPONSE] ${response.status} ${response.config.method?.toUpperCase() || 'GET'}`);
  return response;
}, (error) => {
  if (error.response) {
    console.error(`[HTTP ERROR RESPONSE] ${error.response.status} ${error.config?.method?.toUpperCase() || 'GET'}`);
  } else {
    console.error(`[HTTP NETWORK ERROR] ${error.config?.method?.toUpperCase() || 'GET'} - ${error.message}`);
  }
  return Promise.reject(error);
});

const app = createApp();
const port = process.env.PORT || 3001;

async function start() {
  await ensureBootstrapAdmin();
  await loadConfiguredPlugins();
  await ensureDefaultFunctionLibrary();
  app.listen(port, () => {
    console.log(`API Server running at http://localhost:${port}`);
  });
}

void start().catch((error) => {
  console.error('[PLUGIN STARTUP ERROR]', error);
  process.exitCode = 1;
});
