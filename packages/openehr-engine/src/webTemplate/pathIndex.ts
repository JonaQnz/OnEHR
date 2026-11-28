/** The openEHR path index for a raw WebTemplate tree - kept separate from the
 * flat codec (which consumes it) so a consumer that only needs the path map
 * does not pull in the whole FLAT composition codec. */

import { wtCodedValues, wtRmType, wtUnitInput, wtUnitOptions } from './normalize';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export interface OpenEhrPathMapping {
  flatPath: string;
  rmType?: string;
  /** The current, valid coded values at this node - only present for a
   * DV_CODED_TEXT/CODE_PHRASE node whose WebTemplate carries an
   * `inputs[].list` (the same source webTemplateParser reads for a
   * generated Form Section's own `options`). Used by auditFormBindings to
   * flag a Form Section option EHRbase would now reject - the template's
   * value set can change between imports independently of any Form Section
   * built against an earlier version of it. */
  codes?: string[];
  /** The current, valid per-unit magnitude range/precision at this node -
   * only present for a DV_QUANTITY node whose WebTemplate carries range/
   * precision validation on at least one unit. Used by auditFormBindings to
   * flag a Form Section field whose stored unitOptions don't reflect these
   * limits. */
  unitOptions?: Array<{ unit: string; min?: number; max?: number; minexclusive?: boolean; maxexclusive?: boolean; precision?: number }>;
}

export function buildOpenEhrPathMap(tree: unknown): Map<string, OpenEhrPathMapping> {
  const map = new Map<string, OpenEhrPathMapping>();
  function walk(node: unknown, prefix: string): void {
    if (!isRecord(node)) return;
    const id = text(node.id) || text(node.name);
    const current = id ? (prefix ? `${prefix}/${id}` : id) : prefix;
    const aqlPath = text(node.aqlPath);
    const rmType = text(node.rmType);
    const codes = wtCodedValues(node);
    const unitOptionsList = wtRmType(node) === 'DV_QUANTITY' ? wtUnitOptions(wtUnitInput(node)?.list) : undefined;
    const unitOptions = unitOptionsList && unitOptionsList.length > 0 ? unitOptionsList : undefined;
    if (aqlPath && current) map.set(aqlPath, { flatPath: current, ...(rmType ? { rmType } : {}), ...(codes ? { codes } : {}), ...(unitOptions ? { unitOptions } : {}) });
    if (Array.isArray(node.children)) node.children.forEach((child) => walk(child, current));
  }
  walk(tree, '');
  return map;
}
