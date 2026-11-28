import prisma from '../db/prisma';
import { HttpError } from '../middleware/errorHandler';
import {
  COMPOSITION_SCRIPTING_EXTENSION_KEY,
  FORM_DEFINITION_SCHEMA_VERSION,
  getCompositionDefinition,
  migrateCanonicalFormToV1,
  normalizeCompositionScript,
} from 'core';
import { FormScriptCompileResult, compileFormDefinitionScript } from '../scripting/formScriptCompiler';
import { compileCompositionScript } from '../scripting/compositionScriptCompiler';
import { hydrateFormScriptConnectors, ScriptConnectorError } from './scriptConnectorRegistry';
import { generateCanonicalForm } from './formGenerator';

export function assertScriptCompiles(result: Pick<FormScriptCompileResult, 'valid' | 'document'>): void {
  if (result.valid) return;
  throw new HttpError(422, 'Das Form Script enthält TypeScript- oder Sicherheitsfehler.', {
    code: 'FORM_SCRIPT_INVALID',
    messages: result.document.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity,
      code: String(diagnostic.code),
      path: diagnostic.line
        ? `form-script.ts:${diagnostic.line}:${diagnostic.column || 1}`
        : 'form-script.ts',
      message: diagnostic.message,
    })),
  });
}

export function compileDefinitionScripts(definition: ReturnType<typeof migrateCanonicalFormToV1>) {
  const formCompilation = compileFormDefinitionScript(definition);
  assertScriptCompiles(formCompilation);
  const withFormScript = { ...definition, formScript: formCompilation.document };
  const composition = getCompositionDefinition(withFormScript.extensions);
  if (!composition) return withFormScript;
  const script = normalizeCompositionScript(
    withFormScript.extensions?.[COMPOSITION_SCRIPTING_EXTENSION_KEY],
    composition,
  );
  const compositionCompilation = compileCompositionScript(composition, script.source);
  assertScriptCompiles(compositionCompilation);
  return {
    ...withFormScript,
    extensions: {
      ...withFormScript.extensions,
      [COMPOSITION_SCRIPTING_EXTENSION_KEY]: compositionCompilation.document,
    },
  };
}

export function prepareConnectors(definition: ReturnType<typeof migrateCanonicalFormToV1>, allowedOverride?: string[]) {
  try {
    return hydrateFormScriptConnectors(definition, allowedOverride);
  } catch (error) {
    if (error instanceof ScriptConnectorError) {
      throw new HttpError(error.status, error.message, {
        code: error.code,
        messages: [{ severity: 'error', code: error.code, path: 'formScript.connectors', message: error.message }],
      });
    }
    throw error;
  }
}

export function prepareNewDefinition(input: Record<string, unknown>, formId: string) {
  const definition = prepareConnectors(migrateCanonicalFormToV1(input, formId));
  return compileDefinitionScripts(definition);
}

/**
 * Whether a stored layout actually places any field, as opposed to the empty
 * `{ type: 'form', children: [{ type: 'container', children: [] }] }`
 * placeholder every imported template starts with. Only a layout with real
 * content should ever override `generateCanonicalForm`'s own
 * fields-to-layout generation below - otherwise that placeholder (still
 * truthy) silently wins over the generated layout and the form comes out
 * with correct bindings/locales but nothing on the canvas.
 */
export function layoutHasFields(node: any): boolean {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node.children) && node.children.length > 0) {
    return node.children.some((child: any) => layoutHasFields(child));
  }
  return !['form', 'container', 'row', 'column'].includes(node.type);
}

export function generateDefinitionFromTemplate(template: any, formId: string, formName?: string) {
  const registryData = template.parsed_registry_json as any;
  const isNewSchema = registryData && !Array.isArray(registryData);
  const fields = isNewSchema ? (registryData.fields || []) : (registryData || []);
  const storedLayout = isNewSchema ? registryData.layout : undefined;
  const layout = storedLayout && layoutHasFields(storedLayout) ? storedLayout : undefined;

  return prepareNewDefinition({
    ...generateCanonicalForm({
      id: formId,
      name: formName || template.template_id,
      templateId: template.template_id,
      alias: template.alias,
      templateVersion: template.version || '1.0.0',
      fields,
      layout,
    }),
    version: '0.1.0-draft',
    schemaVersion: FORM_DEFINITION_SCHEMA_VERSION,
    revision: 0,
    extensions: {},
  }, formId);
}

/** A published Composition is immutable in intent: all referenced building blocks must be executable now. */
export async function assertCompositionDependencies(definition: ReturnType<typeof migrateCanonicalFormToV1>, compositionId: string): Promise<void> {
  const composition = getCompositionDefinition(definition.extensions);
  if (!composition) return;
  const formIds = composition.pages.flatMap((page) => page.blocks)
    .filter((block): block is Extract<typeof block, { type: 'form' }> => block.type === 'form')
    .map((block) => block.formId);
  if (formIds.includes(compositionId)) throw new HttpError(422, 'A Composition cannot include itself');
  if (formIds.length > 0) {
    const forms = await prisma.form.findMany({ where: { id: { in: [...new Set(formIds)] } }, select: { id: true, status: true } });
    const unavailable = formIds.filter((id) => !forms.some((form) => form.id === id && form.status === 'published'));
    if (unavailable.length > 0) throw new HttpError(422, 'A Composition can only include published forms', { code: 'COMPOSITION_FORM_UNAVAILABLE', messages: unavailable.map((id) => ({ severity: 'error', path: 'extensions.watehr.composition', message: `Embedded form ${id} is not published` })) });
  }
  const widgetIds = composition.pages.flatMap((page) => page.blocks)
    .filter((block): block is Extract<typeof block, { type: 'data' }> => block.type === 'data')
    .map((block) => block.widgetId)
    .filter((id): id is string => Boolean(id));
  if (widgetIds.length > 0) {
    const widgets = await prisma.dataWidget.findMany({ where: { id: { in: [...new Set(widgetIds)] }, enabled: true }, select: { id: true } });
    const unavailable = widgetIds.filter((id) => !widgets.some((widget) => widget.id === id));
    if (unavailable.length > 0) throw new HttpError(422, 'A Composition can only use enabled widgets', { code: 'COMPOSITION_WIDGET_UNAVAILABLE', messages: unavailable.map((id) => ({ severity: 'error', path: 'extensions.watehr.composition', message: `Widget ${id} is unavailable` })) });
  }
  // Kept while old definitions are migrated. New data blocks always use widgetId.
  const functionIds = composition.pages.flatMap((page) => page.blocks)
    .filter((block): block is Extract<typeof block, { type: 'data' }> => block.type === 'data')
    .filter((block) => !block.widgetId)
    .map((block) => block.aqlFunctionId)
    .filter((id): id is string => Boolean(id));
  if (functionIds.length > 0) {
    const functions = await prisma.aqlFunction.findMany({ where: { id: { in: [...new Set(functionIds)] }, enabled: true }, select: { id: true } });
    const unavailable = functionIds.filter((id) => !functions.some((fn) => fn.id === id));
    if (unavailable.length > 0) throw new HttpError(422, 'A Composition can only use enabled AQL functions', { code: 'COMPOSITION_AQL_UNAVAILABLE', messages: unavailable.map((id) => ({ severity: 'error', path: 'extensions.watehr.composition', message: `AQL function ${id} is unavailable` })) });
  }
}
