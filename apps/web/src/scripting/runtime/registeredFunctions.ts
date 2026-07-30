import type { FunctionPackageDefinition, FunctionDefinition } from '../../../../../packages/plugin-api/src/index';

// Static import of known function packages for the worker sandbox
import clinicalScoresPackage from '../../../../../packages/formbuilder-plugin-clinical-scores/src/index';

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
