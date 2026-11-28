/** Normalisation helpers for raw WebTemplate JSON. Pure: no imports.
 *
 * These mirror the selection/constraint logic the API's webTemplateParser
 * and the openEHR path map/audit code in index.ts already used inline, so
 * every consumer reads a coded-value list, a unit list and a range/
 * precision constraint the same way. */

export interface WtUnitOption {
  unit: string;
  min?: number;
  max?: number;
  minexclusive?: boolean;
  maxexclusive?: boolean;
  precision?: number;
}

export interface WtNumericConstraint {
  min?: number;
  max?: number;
  minexclusive?: boolean;
  maxexclusive?: boolean;
  precision?: number;
}

export interface WtCardinality {
  min: number;
  max: number;
  repeatable: boolean;
}

export interface WtRawInput {
  suffix?: string;
  type?: string;
  terminology?: string;
  listOpen?: boolean;
  list?: unknown[];
  validation?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRawInput(value: unknown): value is WtRawInput {
  return isRecord(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function wtRmType(node: unknown): string | undefined {
  return isRecord(node) ? text(node.rmType) : undefined;
}

export function wtCardinality(node: unknown): WtCardinality {
  const record = isRecord(node) ? node : {};
  const min = typeof record.min === 'number' ? record.min : 0;
  const max = typeof record.max === 'number' ? record.max : 1;
  return { min, max, repeatable: max === -1 || max > 1 };
}

export function wtInputs(node: unknown): WtRawInput[] {
  if (!isRecord(node) || !Array.isArray(node.inputs)) return [];
  return node.inputs.filter(isRawInput);
}

/** The input actually carrying a coded value set - a coded field's real
 * options can live on a specific `suffix: 'code'`/`type: 'CODED_TEXT'`
 * entry rather than the first one. */
export function wtCodeListInput(node: unknown): WtRawInput | undefined {
  const inputs = wtInputs(node);
  const codeInput = inputs.find((input) => text(input.suffix) === 'code' || text(input.type) === 'CODED_TEXT');
  return codeInput || inputs[0];
}

export function wtOtherTextInput(node: unknown): WtRawInput | undefined {
  return wtInputs(node).find((input) => text(input.suffix) === 'other' || text(input.type) === 'TEXT');
}

export function wtUnitInput(node: unknown): WtRawInput | undefined {
  return wtInputs(node).find((input) => {
    const suffix = text(input.suffix);
    return suffix === 'units' || suffix === 'unit' || suffix === 'unit_code';
  });
}

export function wtNumericConstraint(validation: unknown): WtNumericConstraint {
  const constraint: WtNumericConstraint = {};
  if (!isRecord(validation)) return constraint;
  const range = isRecord(validation.range) ? validation.range : undefined;
  if (range) {
    if (typeof range.min === 'number') constraint.min = range.min;
    if (typeof range.max === 'number') constraint.max = range.max;
    if (range.minOp === '>') constraint.minexclusive = true;
    if (range.maxOp === '<') constraint.maxexclusive = true;
  }
  const precision = isRecord(validation.precision) ? validation.precision : undefined;
  if (precision) {
    if (typeof precision.max === 'number') constraint.precision = precision.max;
    else if (typeof precision.min === 'number') constraint.precision = precision.min;
  }
  return constraint;
}

export function wtUnitOptions(list: unknown): WtUnitOption[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter(isRecord)
    .map((entry) => {
      const unit = text(entry.value);
      return unit ? { unit, ...wtNumericConstraint(entry.validation) } : undefined;
    })
    .filter((option): option is WtUnitOption => option !== undefined);
}

export function wtCodedValues(node: unknown): string[] | undefined {
  const rmType = wtRmType(node);
  if (rmType !== 'DV_CODED_TEXT' && rmType !== 'CODE_PHRASE') return undefined;
  const listInput = wtCodeListInput(node);
  if (!listInput || !Array.isArray(listInput.list)) return undefined;
  const codes = listInput.list
    .filter(isRecord)
    .map((entry) => text(entry.value))
    .filter((value): value is string => Boolean(value));
  return codes.length > 0 ? codes : undefined;
}
