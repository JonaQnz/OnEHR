import type { FunctionPackageDefinition, FunctionDefinition } from 'plugin-api';

// A worker needs executable functions synchronously. It consumes the package's
// declared public entry point rather than an implementation file.
import clinicalScoresPackage from 'formbuilder-plugin-clinical-scores';

const packages: FunctionPackageDefinition[] = [
  clinicalScoresPackage
];

export const registeredFunctions: Record<string, FunctionDefinition> = {};

packages.forEach((pkg) => {
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
