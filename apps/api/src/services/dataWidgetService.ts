import prisma from '../db/prisma';
import { HttpError } from '../middleware/errorHandler';
import { executeStoredAqlFunctionRecord } from './aqlFunctionService';

const displays = ['metric', 'table', 'line', 'bar', 'area', 'text', 'matrix', 'timeline'] as const;
type Display = (typeof displays)[number];
type Config = { display: Display; valueColumn?: string; labelColumn?: string; timeColumn?: string; limit?: number; referenceRange?: Record<string, number>; packageName?: string };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const columnName = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requiredColumns(definition: Config): string[] {
  const required = [definition.valueColumn];
  if (definition.display === 'line' || definition.display === 'area') required.push(definition.timeColumn);
  if (definition.display === 'bar') required.push(definition.labelColumn);
  // matrix pivots on both axes - labelColumn distinguishes the series (one
  // row per distinct value), timeColumn is the column axis - so unlike
  // every other display, it needs both, not just one.
  if (definition.display === 'matrix') required.push(definition.labelColumn, definition.timeColumn);
  // timeline is chronological entries, each needing both a heading
  // (labelColumn) and a position on the timeline (timeColumn).
  if (definition.display === 'timeline') required.push(definition.labelColumn, definition.timeColumn);
  return required.filter((column): column is string => Boolean(column));
}

/**
 * Widgets deliberately bind to AQL aliases instead of positional result cells. It
 * makes the stored chart mapping stable and lets the editor show meaningful names.
 */
function assertNamedAqlColumns(query: string, definition: Config): void {
  const required = requiredColumns(definition);
  if (required.length === 0) throw new HttpError(422, 'Widget configuration requires a named value column');
  const aliases = new Set(Array.from(query.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\b/gi), (match) => match[1]));
  const missing = required.filter((column) => !aliases.has(column));
  if (missing.length > 0) {
    throw new HttpError(422, `Widget mappings must reference named AQL columns (AS alias): ${missing.join(', ')}`);
  }
}
function config(value: unknown): Config {
  if (!isRecord(value) || !displays.includes(value.display as Display)) throw new HttpError(400, 'Widget configuration requires a supported display type');
  const limit = value.limit === undefined ? 100 : Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new HttpError(400, 'Widget limit must be between 1 and 1000');
  const text = (key: 'valueColumn' | 'labelColumn' | 'timeColumn' | 'packageName') => typeof (value as any)[key] === 'string' && (value as any)[key].trim() ? (value as any)[key].trim() : undefined;
  const parsed = { display: (value as any).display as Display, ...(text('valueColumn') ? { valueColumn: text('valueColumn') } : {}), ...(text('labelColumn') ? { labelColumn: text('labelColumn') } : {}), ...(text('timeColumn') ? { timeColumn: text('timeColumn') } : {}), ...(text('packageName') ? { packageName: text('packageName') } : {}), limit, ...(isRecord((value as any).referenceRange) ? { referenceRange: (value as any).referenceRange as Record<string, number> } : {}) };
  for (const column of [parsed.valueColumn, parsed.labelColumn, parsed.timeColumn].filter((column): column is string => Boolean(column))) {
    if (!columnName.test(column)) throw new HttpError(400, `Widget column "${column}" must be a valid AQL result alias`);
  }
  if (requiredColumns(parsed).length === 0) throw new HttpError(400, 'Widget configuration requires valueColumn');
  if ((parsed.display === 'line' || parsed.display === 'area') && !parsed.timeColumn) throw new HttpError(400, `${parsed.display} widgets require timeColumn`);
  if (parsed.display === 'bar' && !parsed.labelColumn) throw new HttpError(400, 'bar widgets require labelColumn');
  if (parsed.display === 'matrix' && (!parsed.labelColumn || !parsed.timeColumn)) throw new HttpError(400, 'matrix widgets require both labelColumn and timeColumn');
  if (parsed.display === 'timeline' && (!parsed.labelColumn || !parsed.timeColumn)) throw new HttpError(400, 'timeline widgets require both labelColumn and timeColumn');
  return parsed;
}
function payload(value: unknown) {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim() || typeof value.aqlFunctionId !== 'string' || !value.aqlFunctionId.trim()) throw new HttpError(400, 'Widget name and AQL function are required');
  return { name: value.name.trim(), description: typeof value.description === 'string' ? value.description.trim() : '', aqlFunctionId: value.aqlFunctionId.trim(), configuration: config(value.configuration), enabled: value.enabled !== false };
}
function publicWidget(record: any) { return { ...record, configuration: config(record.configuration), createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString() }; }
export async function listDataWidgets() { return (await prisma.dataWidget.findMany({ orderBy: { name: 'asc' } })).map(publicWidget); }
export async function createDataWidget(input: unknown) { const data = payload(input); const aql = await prisma.aqlFunction.findFirst({ where: { id: data.aqlFunctionId, enabled: true } }); if (!aql) throw new HttpError(422, 'Selected AQL function is unavailable'); assertNamedAqlColumns(aql.query, data.configuration); return publicWidget(await prisma.dataWidget.create({ data: { ...data, configuration: data.configuration as any } })); }
export async function updateDataWidget(id: string, input: unknown) { const data = payload(input); const aql = await prisma.aqlFunction.findFirst({ where: { id: data.aqlFunctionId, enabled: true } }); if (!aql) throw new HttpError(422, 'Selected AQL function is unavailable'); assertNamedAqlColumns(aql.query, data.configuration); try { return publicWidget(await prisma.dataWidget.update({ where: { id }, data: { ...data, configuration: data.configuration as any } })); } catch (error: any) { if (error?.code === 'P2025') throw new HttpError(404, 'Widget not found'); throw error; } }
export async function deleteDataWidget(id: string) { try { await prisma.dataWidget.delete({ where: { id } }); } catch (error: any) { if (error?.code === 'P2025') throw new HttpError(404, 'Widget not found'); throw error; } }
export async function executeDataWidget(id: string, patient: { patientId: string; patientNamespace?: string; ehrId?: string }) {
  if (!patient.patientId?.trim()) throw new HttpError(400, 'Widget execution requires a patient context');
  if (!patient.ehrId?.trim()) throw new HttpError(422, 'Widget execution requires an EHR ID');
  const widget = await prisma.dataWidget.findFirst({ where: { id, enabled: true } }); if (!widget) throw new HttpError(404, 'Widget not found');
  const aql = await prisma.aqlFunction.findFirst({ where: { id: widget.aqlFunctionId, enabled: true } }); if (!aql) throw new HttpError(422, 'Widget AQL function is unavailable');
  const definition = config(widget.configuration);
  const rows = await executeStoredAqlFunctionRecord(aql, { patientId: patient.patientId, ...(patient.patientNamespace ? { patientNamespace: patient.patientNamespace } : {}), ehrId: patient.ehrId });
  const result = Array.isArray(rows) ? rows.slice(0, definition.limit) : [];
  return { widget: publicWidget(widget), rows: result };
}
