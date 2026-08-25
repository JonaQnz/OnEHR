import {
  COMPOSITION_SCRIPT_RUNTIME_MODULE,
  type CompositionDefinition,
  type CompositionScriptDocument,
  generateCompositionScriptTypes,
} from 'core';
import { compileIsolatedScript } from './formScriptCompiler';

export interface CompositionScriptCompileResult {
  document: CompositionScriptDocument;
  valid: boolean;
}

export function compileCompositionScript(
  definition: CompositionDefinition,
  source: string,
): CompositionScriptCompileResult {
  return compileIsolatedScript(source, {
    allowedModule: COMPOSITION_SCRIPT_RUNTIME_MODULE,
    generatedTypes: generateCompositionScriptTypes(definition),
    subject: 'Composition Script',
  });
}
