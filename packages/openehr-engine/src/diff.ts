/**
 * Semantic Diff Engine (Epic 3). Operates on two `RuntimeValues` objects -
 * the level Forms already works at after `fromOpenEhrFlatComposition` - not
 * raw openEHR JSON, and never `JSON.stringify(a) !== JSON.stringify(b)` for
 * the actual comparison. Field enumeration reuses `collectRuntimeFields`/
 * `collectRuntimeGroups` (packages/core/form-runtime, already used for
 * validation) - the single Path Engine from Epic 1, never a second one.
 *
 * Repeating-instance strategy (documented per the spec's own §16
 * requirement): no stable per-instance runtime ID exists anywhere in this
 * codebase today, so this implements the spec's own tiers 2+3 only -
 * (2) exact-content match first, order-independent, so a pure reorder is
 * never reported as a change; (3) any left-over entries (counts differ, or
 * content changed) are paired by their remaining relative order and diffed
 * field-by-field, with any further leftovers reported as added/removed.
 */
import {
  collectRuntimeFields,
  collectRuntimeGroups,
  type CanonicalForm,
  type RuntimeFieldDescriptor,
  type RuntimeValue,
  type RuntimeValues,
  type SemanticDiff,
  type SemanticDiffEntry,
} from 'core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmptyValue(value: RuntimeValue): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function rmTypeOf(field: RuntimeFieldDescriptor): string | undefined {
  const binding = field.binding as { rmType?: string } | undefined;
  return binding?.rmType;
}

/** Resolves a coded/select value to its display text via the field's own
 * options (§14) - RuntimeValues stores only the code, never the full
 * DV_CODED_TEXT shape, so the label lookup happens here, not on read. */
function displayValue(field: RuntimeFieldDescriptor, value: RuntimeValue): unknown {
  if (isEmptyValue(value)) return undefined;
  if (field.type === 'input-quantity' && isRecord(value)) {
    return { magnitude: value.magnitude, unit: value.unit };
  }
  if (field.options.length > 0) {
    const toText = (item: unknown) => field.options.find((option) => option.value === String(item))?.text ?? item;
    return Array.isArray(value) ? value.map(toText) : toText(value);
  }
  return value;
}

function valuesEqual(field: RuntimeFieldDescriptor, a: RuntimeValue, b: RuntimeValue): boolean {
  const emptyA = isEmptyValue(a);
  const emptyB = isEmptyValue(b);
  if (emptyA && emptyB) return true;
  if (emptyA !== emptyB) return false;
  if (field.type === 'input-quantity') {
    const magnitudeA = isRecord(a) ? a.magnitude : a;
    const magnitudeB = isRecord(b) ? b.magnitude : b;
    const unitA = isRecord(a) ? a.unit : undefined;
    const unitB = isRecord(b) ? b.unit : undefined;
    return String(magnitudeA) === String(magnitudeB) && unitA === unitB;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

interface EntryBase {
  path: string;
  label?: string;
  archetypeNodeId?: string;
  rmType?: string;
}

function fieldBase(field: RuntimeFieldDescriptor, path: string): EntryBase {
  const archetypeNodeId = field.archetypeNodeId;
  const rmType = rmTypeOf(field);
  return {
    path,
    label: field.label,
    ...(archetypeNodeId !== undefined ? { archetypeNodeId } : {}),
    ...(rmType !== undefined ? { rmType } : {}),
  };
}

function addedEntry(base: EntryBase, newValue: unknown): SemanticDiffEntry {
  return { ...base, newValue, change: 'added' };
}

function removedEntry(base: EntryBase, oldValue: unknown): SemanticDiffEntry {
  return { ...base, oldValue, change: 'removed' };
}

function changedEntry(base: EntryBase, oldValue: unknown, newValue: unknown): SemanticDiffEntry {
  return { ...base, oldValue, newValue, change: 'changed' };
}

function diffSingle(field: RuntimeFieldDescriptor, a: RuntimeValue, b: RuntimeValue, path: string, diff: SemanticDiff): void {
  const emptyA = isEmptyValue(a);
  const emptyB = isEmptyValue(b);
  if (emptyA && emptyB) return;
  const base = fieldBase(field, path);
  if (emptyA && !emptyB) { diff.added.push(addedEntry(base, displayValue(field, b))); return; }
  if (!emptyA && emptyB) { diff.removed.push(removedEntry(base, displayValue(field, a))); return; }
  if (!valuesEqual(field, a, b)) diff.changed.push(changedEntry(base, displayValue(field, a), displayValue(field, b)));
}

/** Matches two arrays by exact content first (order-independent), then
 * returns the leftover indices on each side for index-paired follow-up. */
function matchByContent<T>(itemsA: T[], itemsB: T[], sameContent: (a: T, b: T) => boolean): { leftoverA: number[]; leftoverB: number[] } {
  const usedB = new Array(itemsB.length).fill(false);
  const leftoverA: number[] = [];
  itemsA.forEach((itemA, i) => {
    const matchIndex = itemsB.findIndex((candidate, j) => !usedB[j] && sameContent(itemA, candidate));
    if (matchIndex >= 0) usedB[matchIndex] = true;
    else leftoverA.push(i);
  });
  const leftoverB: number[] = [];
  usedB.forEach((used, j) => { if (!used) leftoverB.push(j); });
  return { leftoverA, leftoverB };
}

function diffRepeatingValues(field: RuntimeFieldDescriptor, arrA: RuntimeValue[], arrB: RuntimeValue[], diff: SemanticDiff): void {
  const { leftoverA, leftoverB } = matchByContent(arrA, arrB, (a, b) => valuesEqual(field, a, b));
  const pairCount = Math.min(leftoverA.length, leftoverB.length);
  for (let k = 0; k < pairCount; k += 1) {
    const indexA = leftoverA[k] as number;
    const indexB = leftoverB[k] as number;
    diffSingle(field, arrA[indexA], arrB[indexB], `${field.id}[${indexA}]`, diff);
  }
  for (let k = pairCount; k < leftoverA.length; k += 1) {
    const indexA = leftoverA[k] as number;
    diff.removed.push(removedEntry(fieldBase(field, `${field.id}[${indexA}]`), displayValue(field, arrA[indexA])));
  }
  for (let k = pairCount; k < leftoverB.length; k += 1) {
    const indexB = leftoverB[k] as number;
    diff.added.push(addedEntry(fieldBase(field, `${field.id}[${indexB}]`), displayValue(field, arrB[indexB])));
  }
}

function diffRepeatingRows(groupId: string, groupLabel: string, rowsA: Record<string, RuntimeValue>[], rowsB: Record<string, RuntimeValue>[], groupFields: RuntimeFieldDescriptor[], diff: SemanticDiff): void {
  const { leftoverA, leftoverB } = matchByContent(rowsA, rowsB, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  const pairCount = Math.min(leftoverA.length, leftoverB.length);
  for (let k = 0; k < pairCount; k += 1) {
    const indexA = leftoverA[k] as number;
    const indexB = leftoverB[k] as number;
    const rowA = rowsA[indexA];
    const rowB = rowsB[indexB];
    for (const field of groupFields) {
      diffSingle(field, rowA?.[field.id], rowB?.[field.id], `${groupId}[${indexA}].${field.id}`, diff);
    }
  }
  for (let k = pairCount; k < leftoverA.length; k += 1) {
    const indexA = leftoverA[k] as number;
    diff.removed.push(removedEntry({ path: `${groupId}[${indexA}]`, label: groupLabel }, rowsA[indexA]));
  }
  for (let k = pairCount; k < leftoverB.length; k += 1) {
    const indexB = leftoverB[k] as number;
    diff.added.push(addedEntry({ path: `${groupId}[${indexB}]`, label: groupLabel }, rowsB[indexB]));
  }
}

export function compareRuntimeValues(definition: Pick<CanonicalForm, 'layout' | 'locales'>, valuesA: RuntimeValues, valuesB: RuntimeValues): SemanticDiff {
  const diff: SemanticDiff = { added: [], removed: [], changed: [] };
  const groups = collectRuntimeGroups(definition);
  const fields = collectRuntimeFields(definition);

  const groupFieldsByGroup = new Map<string, RuntimeFieldDescriptor[]>();
  const topLevelFields: RuntimeFieldDescriptor[] = [];
  for (const field of fields) {
    if (field.repeatableGroupId) {
      const list = groupFieldsByGroup.get(field.repeatableGroupId) || [];
      list.push(field);
      groupFieldsByGroup.set(field.repeatableGroupId, list);
    } else {
      topLevelFields.push(field);
    }
  }

  for (const group of groups) {
    const rowsA = Array.isArray(valuesA[group.id]) ? (valuesA[group.id] as Record<string, RuntimeValue>[]) : [];
    const rowsB = Array.isArray(valuesB[group.id]) ? (valuesB[group.id] as Record<string, RuntimeValue>[]) : [];
    if (rowsA.length === 0 && rowsB.length === 0) continue;
    diffRepeatingRows(group.id, group.label, rowsA, rowsB, groupFieldsByGroup.get(group.id) || [], diff);
  }

  for (const field of topLevelFields) {
    if (field.repeatable) {
      const arrA = Array.isArray(valuesA[field.id]) ? (valuesA[field.id] as RuntimeValue[]) : [];
      const arrB = Array.isArray(valuesB[field.id]) ? (valuesB[field.id] as RuntimeValue[]) : [];
      if (arrA.length === 0 && arrB.length === 0) continue;
      diffRepeatingValues(field, arrA, arrB, diff);
    } else {
      diffSingle(field, valuesA[field.id], valuesB[field.id], field.id, diff);
    }
  }

  return diff;
}
