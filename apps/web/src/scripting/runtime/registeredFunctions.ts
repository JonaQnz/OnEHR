import type { FunctionPackageDefinition, FunctionDefinition } from 'plugin-api';

// A worker needs executable functions synchronously. It consumes the package's
// declared public entry point rather than an implementation file.
//
// The package's dist/index.js is plain CommonJS (`exports.default = pkg`).
// Vite's dev server pre-bundles that fine via esbuild, but this file is
// pulled into a separate worker chunk (see FormScriptClient.ts's
// `new Worker(new URL(...))`) that Rollup bundles for production - and
// Rollup's commonjs plugin's heuristic default-export detection doesn't
// always recognize that shape in a worker graph, failing the production
// build outright with "'default' is not exported by ...". A namespace
// import plus an explicit `.default` fallback works under both bundlers.
import * as clinicalScoresModule from 'formbuilder-plugin-clinical-scores';
const clinicalScoresPackage: FunctionPackageDefinition =
  (clinicalScoresModule as { default?: FunctionPackageDefinition }).default
  ?? (clinicalScoresModule as unknown as FunctionPackageDefinition);

export const registeredFunctionPackages: FunctionPackageDefinition[] = [
  clinicalScoresPackage
];

export const registeredFunctions: Record<string, FunctionDefinition> = {};

registeredFunctionPackages.forEach((pkg) => {
  pkg.functions.forEach((func) => {
    registeredFunctions[func.name] = func;
  });
});

export function buildGlobalFunctionsObject(): Record<string, any> {
  const globalObj: Record<string, any> = {};

  for (const [name, def] of Object.entries(registeredFunctions)) {
    const parts = name.split('.');
    let current = globalObj;
    
    // Create nested structure
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    
    // Assign function
    const fnName = parts[parts.length - 1];
    current[fnName] = def.execute;
  }
  
  return globalObj;
}
