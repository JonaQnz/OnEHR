import type { JsonValue } from '../canonical';
import type { FormLaunchLoadPolicy } from '../form-launch';
import type { FormRuntimeMode } from '../form-session';

/** Key used in FormDefinition.extensions for the composite form document. */
export const COMPOSITION_EXTENSION_KEY = 'watehr.composition' as const;
export const COMPOSITION_SCHEMA_VERSION = '1.0' as const;

export type CompositionBlock = CompositionFormBlock | CompositionDataBlock | CompositionTextBlock;

export interface CompositionFormBlock {
  id: string;
  type: 'form';
  formId: string;
  title?: string;
  mode?: FormRuntimeMode;
  load?: FormLaunchLoadPolicy;
  /** Only optional fields may be hidden; required fields remain visible. */
  hiddenFieldIds?: string[];
  /** Per-instance display-label override, keyed by field id. Cosmetic only -
   * never changes the referenced Form Section's own canonical label, so the
   * same Form Section keeps its original labels everywhere else it's used. */
  fieldLabelOverrides?: Record<string, string>;
  column?: 1 | 2 | 3;
  displayMode?: 'auto' | 'fixed';
  /** When true, this block is never auto-started when its page loads.
   * Instead the runtime offers a "+ <title> hinzufügen" control that a
   * clinician clicks explicitly, as many times as needed - each click
   * creates one more independent instance of this Form Section (e.g.
   * several Diagnose or Befund entries on one Composition). Off by default,
   * so every existing Composition's blocks keep auto-starting exactly as
   * before - a designer opts a specific block into this deliberately. */
  manualAdd?: boolean;
  /** Only meaningful when manualAdd is true: whether at least one instance
   * of this block must exist before the composition session can be
   * considered complete/valid. Off by default - a manualAdd block is
   * ordinarily fully optional, the clinician may leave it untouched. */
  requireAtLeastOne?: boolean;
}

export interface CompositionDataBlock {
  id: string;
  type: 'data';
  title: string;
  /** Preferred reference to a centrally configured clinical widget. */
  widgetId?: string;
  /** Origin package for a plugin-defined widget; retained for auditability. */
  widgetPackageId?: string;
  /** @deprecated Legacy direct-AQL blocks remain readable during migration. */
  aqlFunctionId?: string;
  display: 'list' | 'text' | 'trend' | 'metric' | 'matrix' | 'timeline';
  /** Rendering choice for a trend widget. Table, metric and text use display. */
  chartType?: 'line' | 'area' | 'bar';
  /** For 'matrix'/'timeline': the value shown in each cell/entry. */
  valueColumn?: string;
  /** For 'matrix': distinguishes the series - one row per distinct value
   * (e.g. one row per lab analyte), not a single fixed column. For
   * 'timeline': each entry's heading. */
  labelColumn?: string;
  /** For 'matrix': the column axis, bucketed to a calendar day (several
   * same-day rows collapse into one cell, the latest by timestamp wins).
   * For 'timeline': each entry's chronological position. */
  timeColumn?: string;
  limit?: number;
  referenceRange?: { min?: number; max?: number; criticalLow?: number; criticalHigh?: number };
  column?: 1 | 2 | 3;
}

export interface CompositionTextBlock {
  id: string;
  type: 'text';
  title?: string;
  content: string;
  column?: 1 | 2 | 3;
}

/** Persisted, UI-neutral layout entry shared by the form and Composition designers. */
export interface CompositionLayoutElement {
  id: string;
  element: 'FieldSet' | 'TwoColumnRow' | 'ThreeColumnRow' | 'Header' | 'Label' | 'Paragraph' | 'LineBreak' | 'HyperLink' | 'block';
  label?: string;
  content?: string;
  parentId?: string;
  column?: 1 | 2 | 3;
  /** A slot for one clinical block; all blocks appear exactly once in a page layout. */
  blockId?: string;
}

export interface CompositionPage {
  id: string;
  title: string;
  description?: string;
  columns?: 1 | 2 | 3;
  blocks: CompositionBlock[];
  layout: CompositionLayoutElement[];
}

export interface CompositionDefinition {
  schemaVersion: typeof COMPOSITION_SCHEMA_VERSION;
  /** Widget packages explicitly enabled for this Composition's designer toolbox. */
  widgetPackageIds?: string[];
  /** How the runtime shows pages: one at a time behind tabs (default), or
   * every page stacked vertically on one scroll. Author default - the
   * runtime still lets a user toggle this per visit. */
  viewMode?: 'tabs' | 'stacked';
  /**
   * Whether the composition's grouped save (§ClinicalTransaction) must land
   * as one real openEHR CONTRIBUTION, or may fall back to a best-effort
   * sequential per-form save when the active provider doesn't support
   * Contribution. `true` (or unset, deferring to the connection's global
   * `requireAtomicCommitByDefault`) blocks the grouped save outright rather
   * than ever silently downgrading; `false` allows the explicit,
   * never-claimed-atomic fallback instead.
   */
  requireAtomicCommit?: boolean;
  pages: CompositionPage[];
}

export type CompositionSessionStatus = 'draft' | 'in_progress' | 'ready' | 'submitted' | 'failed' | 'cancelled';
export interface CompositionProgress { total: number; started: number; ready: number; submitted: number; }

/** One source of truth for the parent session state derived from child forms. */
export function summarizeCompositionSession(children: ReadonlyArray<{ status: string }>): { progress: CompositionProgress; status: CompositionSessionStatus } {
  const progress = {
    total: children.length,
    started: children.filter((child) => child.status !== 'not_started').length,
    ready: children.filter((child) => child.status === 'ready' || child.status === 'submitted').length,
    submitted: children.filter((child) => child.status === 'submitted').length,
  };
  const status: CompositionSessionStatus = progress.total === 0 ? 'draft'
    : progress.submitted === progress.total ? 'submitted'
      : children.some((child) => child.status === 'failed') ? 'failed'
        : progress.ready === progress.total ? 'ready'
          : progress.started > 0 ? 'in_progress' : 'draft';
  return { progress, status };
}

export interface CompositionBlockMove {
  sourcePageId: string;
  blockId: string;
  targetPageId: string;
  /** Zero-based insertion point before the block at this index. */
  targetIndex: number;
}

function insertionIndex(index: number, size: number): number {
  if (!Number.isInteger(index)) throw new Error('Composition target index must be an integer');
  return Math.max(0, Math.min(index, size));
}

function pageIndex(definition: CompositionDefinition, pageId: string): number {
  const index = definition.pages.findIndex((page) => page.id === pageId);
  if (index < 0) throw new Error(`Composition page '${pageId}' does not exist`);
  return index;
}

/**
 * Returns a new composition definition with a block inserted into a page.
 * This is intentionally UI-independent so drag/drop and keyboard insertion
 * have exactly the same ordering semantics.
 */
export function insertCompositionBlock(
  definition: CompositionDefinition,
  targetPageId: string,
  block: CompositionBlock,
  targetIndex: number,
): CompositionDefinition {
  const index = pageIndex(definition, targetPageId);
  return {
    ...definition,
    pages: definition.pages.map((page, pagePosition) => {
      if (pagePosition !== index) return page;
      const blocks = [...page.blocks];
      blocks.splice(insertionIndex(targetIndex, blocks.length), 0, block);
      const layout = [...(page.layout || defaultPageLayout(page.id, page.blocks))];
      // Was `Math.min(targetIndex, layout.length)` with no lower clamp,
      // unlike `blocks`' own insertionIndex() above - a negative
      // targetIndex (e.g. -1) left this negative, and Array#splice treats
      // a negative index as "from the end" (splice(-1, ...) inserts before
      // the last element), while blocks.splice above correctly clamped to
      // 0. The block landed at blocks[0] but its layout entry landed near
      // the end of layout[] - a real desync between the two arrays that
      // are supposed to describe the same page's block order.
      const layoutIndex = insertionIndex(targetIndex, layout.length);
      layout.splice(layoutIndex, 0, { id: `layout/${page.id}/${block.id}`, element: 'block', blockId: block.id, ...(block.column ? { column: block.column } : {}) });
      return { ...page, blocks, layout };
    }),
  };
}

/**
 * Moves one existing block without mutating the input.  When moving within
 * a page, the target index is interpreted in the pre-move order, which makes
 * a drop zone after a block stable while its source is removed.
 */
export function moveCompositionBlock(
  definition: CompositionDefinition,
  move: CompositionBlockMove,
): CompositionDefinition {
  const sourcePagePosition = pageIndex(definition, move.sourcePageId);
  const targetPagePosition = pageIndex(definition, move.targetPageId);
  const sourcePage = definition.pages[sourcePagePosition];
  if (!sourcePage) throw new Error(`Composition page '${move.sourcePageId}' does not exist`);
  const sourceIndex = sourcePage.blocks.findIndex((block) => block.id === move.blockId);
  if (sourceIndex < 0) throw new Error(`Composition block '${move.blockId}' does not exist on page '${move.sourcePageId}'`);

  const pages = definition.pages.map((page) => ({ ...page, blocks: [...page.blocks], layout: [...(page.layout || defaultPageLayout(page.id, page.blocks))] }));
  const mutableSourcePage = pages[sourcePagePosition];
  const targetPage = pages[targetPagePosition];
  if (!mutableSourcePage || !targetPage) throw new Error('Composition pages could not be resolved for move');
  const [block] = mutableSourcePage.blocks.splice(sourceIndex, 1);
  if (!block) throw new Error(`Composition block '${move.blockId}' could not be moved`);
  const adjustedTarget = sourcePagePosition === targetPagePosition && sourceIndex < move.targetIndex
    ? move.targetIndex - 1
    : move.targetIndex;
  targetPage.blocks.splice(insertionIndex(adjustedTarget, targetPage.blocks.length), 0, block);
  const sourceSlotIndex = mutableSourcePage.layout.findIndex((entry) => entry.blockId === block.id);
  const [sourceSlot] = sourceSlotIndex >= 0 ? mutableSourcePage.layout.splice(sourceSlotIndex, 1) : [];
  const targetSlotIndex = Math.min(adjustedTarget, targetPage.layout.length);
  targetPage.layout.splice(targetSlotIndex, 0, sourceSlot
    ? (sourcePagePosition === targetPagePosition ? sourceSlot : (() => { const { parentId: _parentId, ...detachedSlot } = sourceSlot; return detachedSlot; })())
    : { id: `layout/${targetPage.id}/${block.id}`, element: 'block', blockId: block.id, ...(block.column ? { column: block.column } : {}) });
  return { ...definition, pages };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function requiredId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Composition ${name} must be a non-empty string`);
  return value.trim();
}
function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`Composition ${name} must be a string array`);
  return [...new Set(value.map((item) => item.trim()))];
}
function stringRecord(value: unknown, name: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`Composition ${name} must be an object`);
  const entries = Object.entries(value).filter(([key, item]) => {
    if (typeof key !== 'string' || !key.trim()) throw new Error(`Composition ${name} keys must be non-empty strings`);
    if (typeof item !== 'string') throw new Error(`Composition ${name} values must be strings`);
    return item.trim().length > 0;
  }) as [string, string][];
  return entries.length > 0 ? Object.fromEntries(entries.map(([key, item]) => [key.trim(), item.trim()])) : undefined;
}

const COMPOSITION_LAYOUT_ELEMENTS = new Set<CompositionLayoutElement['element']>([
  'FieldSet', 'TwoColumnRow', 'ThreeColumnRow', 'Header', 'Label', 'Paragraph', 'LineBreak', 'HyperLink', 'block',
]);

function defaultPageLayout(pageId: string, blocks: CompositionBlock[]): CompositionLayoutElement[] {
  return blocks.map((block) => ({ id: `layout/${pageId}/${block.id}`, element: 'block', blockId: block.id, ...(block.column ? { column: block.column } : {}) }));
}

function normalizePageLayout(value: unknown, pageId: string, blocks: CompositionBlock[], reserveId: (id: string) => void): CompositionLayoutElement[] {
  if (value === undefined) {
    const layout = defaultPageLayout(pageId, blocks);
    layout.forEach((entry) => reserveId(entry.id));
    return layout;
  }
  if (!Array.isArray(value)) throw new Error(`Composition page '${pageId}' layout must be an array`);
  const blockIds = new Set(blocks.map((block) => block.id));
  const referencedBlocks = new Set<string>();
  const layout = value.map((rawEntry, index): CompositionLayoutElement => {
    if (!isRecord(rawEntry)) throw new Error(`Composition page '${pageId}' layout entry ${index + 1} must be an object`);
    const id = requiredId(rawEntry.id, `page '${pageId}' layout entry ${index + 1} id`); reserveId(id);
    if (!COMPOSITION_LAYOUT_ELEMENTS.has(rawEntry.element as CompositionLayoutElement['element'])) throw new Error(`Composition page '${pageId}' layout entry '${id}' has an unsupported element`);
    const element = rawEntry.element as CompositionLayoutElement['element'];
    const parentId = rawEntry.parentId === undefined ? undefined : requiredId(rawEntry.parentId, `layout entry '${id}' parentId`);
    const rawColumn = rawEntry.column;
    if (rawColumn !== undefined && (rawColumn !== 1 && rawColumn !== 2 && rawColumn !== 3)) throw new Error(`Composition layout entry '${id}' has an invalid column`);
    const blockId = rawEntry.blockId === undefined ? undefined : requiredId(rawEntry.blockId, `layout entry '${id}' blockId`);
    if (element === 'block' && !blockId) throw new Error(`Composition layout entry '${id}' must reference a block`);
    if (blockId) {
      if (!blockIds.has(blockId)) throw new Error(`Composition layout entry '${id}' references an unknown block`);
      if (referencedBlocks.has(blockId)) throw new Error(`Composition block '${blockId}' appears more than once in the page layout`);
      referencedBlocks.add(blockId);
    }
    return { id, element, ...(typeof rawEntry.label === 'string' && rawEntry.label.trim() ? { label: rawEntry.label.trim() } : {}), ...(typeof rawEntry.content === 'string' ? { content: rawEntry.content } : {}), ...(parentId ? { parentId } : {}), ...(rawColumn ? { column: rawColumn as 1 | 2 | 3 } : {}), ...(blockId ? { blockId } : {}) };
  });
  const layoutIds = new Set(layout.map((entry) => entry.id));
  layout.forEach((entry) => {
    if (entry.parentId && !layoutIds.has(entry.parentId)) throw new Error(`Composition layout entry '${entry.id}' references an unknown parent`);
    if (entry.parentId === entry.id) throw new Error(`Composition layout entry '${entry.id}' cannot be its own parent`);
  });
  blocks.forEach((block) => { if (!referencedBlocks.has(block.id)) throw new Error(`Composition block '${block.id}' is missing from page '${pageId}' layout`); });
  return layout;
}

/** Strict, side-effect-free validation for the composition extension. */
export function normalizeCompositionDefinition(value: unknown): CompositionDefinition {
  if (!isRecord(value)) throw new Error('Composition extension must be an object');
  if (value.schemaVersion !== COMPOSITION_SCHEMA_VERSION) throw new Error(`Composition schemaVersion must be "${COMPOSITION_SCHEMA_VERSION}"`);
  if (!Array.isArray(value.pages) || value.pages.length === 0) throw new Error('Composition requires at least one page');
  const ids = new Set<string>();
  const reserveId = (id: string) => { if (ids.has(id)) throw new Error(`Composition block/page id '${id}' is duplicated`); ids.add(id); };
  const widgetPackageIds = stringList(value.widgetPackageIds, 'widgetPackageIds');
  if (value.viewMode !== undefined && value.viewMode !== 'tabs' && value.viewMode !== 'stacked') throw new Error('Composition viewMode must be "tabs" or "stacked"');
  if (value.requireAtomicCommit !== undefined && typeof value.requireAtomicCommit !== 'boolean') throw new Error('Composition requireAtomicCommit must be a boolean');
  return {
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    ...(widgetPackageIds ? { widgetPackageIds } : {}),
    ...(value.viewMode === 'stacked' ? { viewMode: 'stacked' as const } : {}),
    ...(value.requireAtomicCommit !== undefined ? { requireAtomicCommit: value.requireAtomicCommit } : {}),
    pages: value.pages.map((rawPage, pageIndex) => {
      if (!isRecord(rawPage)) throw new Error(`Composition page ${pageIndex + 1} must be an object`);
      const id = requiredId(rawPage.id, `page ${pageIndex + 1} id`); reserveId(id);
      const title = requiredId(rawPage.title, `page ${pageIndex + 1} title`);
      const columns = rawPage.columns === undefined ? 1 : rawPage.columns;
      if (columns !== 1 && columns !== 2 && columns !== 3) throw new Error(`Composition page '${id}' columns must be 1, 2, or 3`);
      if (!Array.isArray(rawPage.blocks)) throw new Error(`Composition page '${id}' blocks must be an array`);
      return {
        id, title,
        ...(typeof rawPage.description === 'string' && rawPage.description.trim() ? { description: rawPage.description.trim() } : {}),
        ...(columns !== 1 ? { columns } : {}),
        blocks: rawPage.blocks.map((rawBlock, blockIndex): CompositionBlock => {
          if (!isRecord(rawBlock)) throw new Error(`Composition block ${blockIndex + 1} must be an object`);
          const blockId = requiredId(rawBlock.id, `block ${blockIndex + 1} id`); reserveId(blockId);
          const rawColumn = rawBlock.column;
          if (rawColumn !== undefined && (typeof rawColumn !== 'number' || !Number.isInteger(rawColumn) || rawColumn < 1 || rawColumn > columns)) throw new Error(`Composition block '${blockId}' has an invalid column`);
          const column = rawColumn as 1 | 2 | 3 | undefined;
          if (rawBlock.type === 'form') {
            const mode = rawBlock.mode;
            if (mode !== undefined && !['create', 'edit', 'view', 'prefill'].includes(String(mode))) throw new Error(`Composition form block '${blockId}' has an invalid mode`);
            const load = rawBlock.load;
            if (load !== undefined && load !== 'never' && load !== 'provider') throw new Error(`Composition form block '${blockId}' has an invalid load policy`);
            const hiddenFieldIds = stringList(rawBlock.hiddenFieldIds, `form block '${blockId}' hiddenFieldIds`);
            const fieldLabelOverrides = stringRecord(rawBlock.fieldLabelOverrides, `form block '${blockId}' fieldLabelOverrides`);
            if (rawBlock.manualAdd !== undefined && typeof rawBlock.manualAdd !== 'boolean') throw new Error(`Composition form block '${blockId}' manualAdd must be a boolean`);
            if (rawBlock.requireAtLeastOne !== undefined && typeof rawBlock.requireAtLeastOne !== 'boolean') throw new Error(`Composition form block '${blockId}' requireAtLeastOne must be a boolean`);
            if (rawBlock.requireAtLeastOne === true && rawBlock.manualAdd !== true) throw new Error(`Composition form block '${blockId}' requireAtLeastOne requires manualAdd`);
            const manualAdd = rawBlock.manualAdd === true;
            return { id: blockId, type: 'form', formId: requiredId(rawBlock.formId, `form block '${blockId}' formId`), ...(typeof rawBlock.title === 'string' && rawBlock.title.trim() ? { title: rawBlock.title.trim() } : {}), ...(mode ? { mode: mode as FormRuntimeMode } : {}), ...(load ? { load } : {}), ...(hiddenFieldIds ? { hiddenFieldIds } : {}), ...(fieldLabelOverrides ? { fieldLabelOverrides } : {}), ...(column ? { column } : {}), ...(manualAdd ? { manualAdd: true as const, ...(rawBlock.requireAtLeastOne === true ? { requireAtLeastOne: true as const } : {}) } : {}) };
          }
          if (rawBlock.type === 'data') {
            const display = rawBlock.display;
            if (!['list', 'text', 'trend', 'metric', 'matrix', 'timeline'].includes(String(display))) throw new Error(`Composition data block '${blockId}' has an invalid display`);
            const limit = rawBlock.limit;
            if (limit !== undefined && (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100)) throw new Error(`Composition data block '${blockId}' limit must be between 1 and 100`);
            const reference = isRecord(rawBlock.referenceRange) ? Object.fromEntries(Object.entries(rawBlock.referenceRange).filter(([key, item]) => ['min', 'max', 'criticalLow', 'criticalHigh'].includes(key) && typeof item === 'number' && Number.isFinite(item))) : {};
            const widgetId = typeof rawBlock.widgetId === 'string' && rawBlock.widgetId.trim() ? rawBlock.widgetId.trim() : undefined;
            const aqlFunctionId = typeof rawBlock.aqlFunctionId === 'string' && rawBlock.aqlFunctionId.trim() ? rawBlock.aqlFunctionId.trim() : undefined;
            const chartType = rawBlock.chartType === undefined ? undefined : rawBlock.chartType;
            if (chartType !== undefined && chartType !== 'line' && chartType !== 'area' && chartType !== 'bar') throw new Error(`Composition data block '${blockId}' has an invalid chart type`);
            if (!widgetId && !aqlFunctionId) throw new Error(`Composition data block '${blockId}' requires a widgetId`);
            const widgetPackageId = typeof rawBlock.widgetPackageId === 'string' && rawBlock.widgetPackageId.trim() ? rawBlock.widgetPackageId.trim() : undefined;
            return { id: blockId, type: 'data', title: requiredId(rawBlock.title, `data block '${blockId}' title`), ...(widgetId ? { widgetId } : {}), ...(widgetPackageId ? { widgetPackageId } : {}), ...(aqlFunctionId ? { aqlFunctionId } : {}), display: display as CompositionDataBlock['display'], ...(chartType ? { chartType } : {}), ...(typeof rawBlock.valueColumn === 'string' && rawBlock.valueColumn.trim() ? { valueColumn: rawBlock.valueColumn.trim() } : {}), ...(typeof rawBlock.labelColumn === 'string' && rawBlock.labelColumn.trim() ? { labelColumn: rawBlock.labelColumn.trim() } : {}), ...(typeof rawBlock.timeColumn === 'string' && rawBlock.timeColumn.trim() ? { timeColumn: rawBlock.timeColumn.trim() } : {}), ...(limit !== undefined ? { limit: Number(limit) } : {}), ...(Object.keys(reference).length > 0 ? { referenceRange: reference } : {}), ...(column ? { column } : {}) };
          }
          if (rawBlock.type === 'text') return { id: blockId, type: 'text', ...(typeof rawBlock.title === 'string' && rawBlock.title.trim() ? { title: rawBlock.title.trim() } : {}), content: typeof rawBlock.content === 'string' ? rawBlock.content : '', ...(column ? { column } : {}) };
          throw new Error(`Composition block '${blockId}' has an unsupported type`);
        }),
        layout: normalizePageLayout(rawPage.layout, id, rawPage.blocks.map((rawBlock, blockIndex) => {
          if (!isRecord(rawBlock)) throw new Error(`Composition block ${blockIndex + 1} must be an object`);
          return { id: requiredId(rawBlock.id, `block ${blockIndex + 1} id`) } as CompositionBlock;
        }), reserveId),
      };
    }),
  };
}

export function getCompositionDefinition(extensions: Record<string, JsonValue> | undefined): CompositionDefinition | undefined {
  const value = extensions?.[COMPOSITION_EXTENSION_KEY];
  return value === undefined ? undefined : normalizeCompositionDefinition(value);
}
