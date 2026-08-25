import {
  FORM_SCRIPT_LANGUAGE,
  type FormScriptDiagnostic,
  type FormScriptDocument,
} from '../form-scripting';
import type { CompositionDefinition } from '../composition';

/** Stored separately from a form's field script. */
export const COMPOSITION_SCRIPTING_EXTENSION_KEY = 'watehr.composition-scripting' as const;
export const COMPOSITION_SCRIPT_RUNTIME_MODULE = '@formbuilder/composition-runtime' as const;

export type CompositionScriptDocument = FormScriptDocument;

export interface CompositionScriptSchemaIds {
  pages: string[];
  blocks: string[];
  dataBlocks: string[];
}

export const DEFAULT_COMPOSITION_SCRIPT_SOURCE = `import { defineCompositionScript } from "@formbuilder/composition-runtime";

export default defineCompositionScript(({ pages, blocks, data, navigation, status, logger }) => {
  // Die Composition steuern, niemals Felder eines eingebetteten Formulars.
});
`;

const quote = (value: string): string => JSON.stringify(value);
const union = (values: readonly string[]): string => values.length ? [...new Set(values)].map(quote).join(' | ') : 'never';

export function collectCompositionScriptSchemaIds(definition: CompositionDefinition): CompositionScriptSchemaIds {
  return {
    pages: definition.pages.map((page) => page.id).sort(),
    blocks: definition.pages.flatMap((page) => page.blocks.map((block) => block.id)).sort(),
    dataBlocks: definition.pages.flatMap((page) => page.blocks.filter((block) => block.type === 'data').map((block) => block.id)).sort(),
  };
}

/**
 * Generate the only API available to a Composition script.  There is no field
 * API by design: embedded forms own their values, validation and lifecycle.
 */
export function generateCompositionScriptTypes(definition: CompositionDefinition): string {
  const ids = collectCompositionScriptSchemaIds(definition);
  return `declare module "${COMPOSITION_SCRIPT_RUNTIME_MODULE}" {
  export type MaybePromise<T> = T | Promise<T>;
  export type PageId = ${union(ids.pages)};
  export type BlockId = ${union(ids.blocks)};
  export type DataBlockId = ${union(ids.dataBlocks)};

  export interface PagesApi {
    show(id: PageId): void;
    hide(id: PageId): void;
    isVisible(id: PageId): boolean;
  }
  export interface BlocksApi {
    show(id: BlockId): void;
    hide(id: BlockId): void;
    isVisible(id: BlockId): boolean;
  }
  export interface DataCardsApi {
    refresh(id?: DataBlockId): Promise<void>;
    setLoading(id: DataBlockId, loading: boolean): void;
  }
  export interface NavigationApi {
    goTo(id: PageId): void;
    next(): void;
    previous(): void;
  }
  export interface CompositionStatusApi {
    readonly currentPage: PageId;
    readonly completedBlocks: readonly BlockId[];
    readonly pendingBlocks: readonly BlockId[];
    readonly state: "draft" | "in_progress" | "completed" | "submitted";
  }
  export interface LoggerApi {
    debug(message: string, details?: unknown): void;
    info(message: string, details?: unknown): void;
    warn(message: string, details?: unknown): void;
    error(message: string | unknown, error?: unknown): void;
  }
  export interface CompositionScriptSdk {
    pages: PagesApi;
    blocks: BlocksApi;
    data: DataCardsApi;
    navigation: NavigationApi;
    status: CompositionStatusApi;
    logger: LoggerApi;
  }
  export function defineCompositionScript(
    setup: (sdk: CompositionScriptSdk) => MaybePromise<void>,
  ): (sdk: CompositionScriptSdk) => MaybePromise<void>;
}
`;
}

export function createEmptyCompositionScript(definition: CompositionDefinition): CompositionScriptDocument {
  return {
    language: FORM_SCRIPT_LANGUAGE,
    source: DEFAULT_COMPOSITION_SCRIPT_SOURCE,
    compiled: '',
    generatedTypes: generateCompositionScriptTypes(definition),
    diagnostics: [],
  };
}

export function normalizeCompositionScript(value: unknown, definition: CompositionDefinition): CompositionScriptDocument {
  const fallback = createEmptyCompositionScript(definition);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const input = value as Record<string, unknown>;
  return {
    language: FORM_SCRIPT_LANGUAGE,
    source: typeof input.source === 'string' ? input.source : fallback.source,
    compiled: typeof input.compiled === 'string' ? input.compiled : '',
    generatedTypes: generateCompositionScriptTypes(definition),
    diagnostics: Array.isArray(input.diagnostics)
      ? input.diagnostics.filter((item): item is FormScriptDiagnostic => Boolean(item && typeof item === 'object' && !Array.isArray(item) && typeof (item as FormScriptDiagnostic).message === 'string'))
      : [],
    ...(typeof input.compiledAt === 'string' ? { compiledAt: input.compiledAt } : {}),
  };
}
