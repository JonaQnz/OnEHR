import type { CanonicalForm, JsonValue } from 'core';

// Named (not `export *`) so this re-export is statically analyzable by
// Rollup/cjs-module-lexer when consumed from apps/web's Vite build - a
// wildcard re-export of a locally-compiled `__exportStar` helper isn't
// reliably detected there.
export {
  parseOpenEhrAqlPath,
  toArchetypePath,
  getElementMetadata,
  getArchetypePath,
  getTemplatePath,
  getAqlPath,
  resolveElementByPath,
  resolveElementsByNodeId,
  type ParsedOpenEhrPath,
} from './metadata';

export { compareRuntimeValues } from './diff';

export { buildCanonicalComposition, type CanonicalCompositionContext, type WebTemplateTreeNode } from './canonicalComposition';

export { buildConstraintModelFromWebTemplate, mergeSemanticBindings, type WebTemplateJson, type WtNode, type WtInput, type WtOption } from './opt/buildConstraintModel';

export { parseTermBindingsFromOpt, type SemanticBindingIndex } from './opt/parseOptXml';

export {
  wtRmType,
  wtCardinality,
  wtInputs,
  wtCodeListInput,
  wtOtherTextInput,
  wtUnitInput,
  wtNumericConstraint,
  wtUnitOptions,
  wtCodedValues,
  type WtUnitOption,
  type WtNumericConstraint,
  type WtCardinality,
  type WtRawInput,
} from './webTemplate/normalize';

export { toOpenEhrFlatComposition, fromOpenEhrFlatComposition, type OpenEhrCompositionContext } from './flat/flatCodec';

export { buildOpenEhrPathMap, type OpenEhrPathMapping } from './webTemplate/pathIndex';

export { auditFormBindings, type BindingAuditIssue, type BindingAuditFinding } from './audit/bindingAudit';

export { buildRuntimeValue, serializeRuntimeValue, deserializeRuntimeValue, RuntimeValueError } from './opt/runtimeValue';

export const OPEN_EHR_FORM_EXTENSION = 'org.openehr.form' as const;

export interface OpenEhrFormOptions {
  storageStrategy?: 'always_new' | 'update_latest';
}

type JsonObject = Record<string, JsonValue>;
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getOpenEhrFormOptions(definition: Pick<CanonicalForm, 'settings'> & { extensions?: Record<string, JsonValue> }): OpenEhrFormOptions {
  const extension = definition.extensions && isRecord(definition.extensions[OPEN_EHR_FORM_EXTENSION])
    ? definition.extensions[OPEN_EHR_FORM_EXTENSION]
    : undefined;
  return extension && (extension.storageStrategy === 'always_new' || extension.storageStrategy === 'update_latest')
    ? { storageStrategy: extension.storageStrategy }
    : {};
}

export function withOpenEhrFormOptions<T extends CanonicalForm & { extensions?: Record<string, JsonValue> }>(definition: T, options: OpenEhrFormOptions): T {
  return {
    ...definition,
    extensions: {
      ...(definition.extensions || {}),
      [OPEN_EHR_FORM_EXTENSION]: options as JsonObject,
    },
  };
}
