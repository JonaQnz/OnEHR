/** Drift audit of a Form Section's stored bindings against the current
 * WebTemplate tree it was originally built from. */

import type { CanonicalForm } from 'core';
import { layoutFieldBinding } from '../flat/flatCodec';
import { buildOpenEhrPathMap } from '../webTemplate/pathIndex';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export type BindingAuditIssue = 'unresolved-path' | 'rmtype-mismatch' | 'stale-option' | 'stale-unit' | 'missing-quantity-constraint';

export interface BindingAuditFinding {
  /** The Form Section field/container's own id (from its layout node). */
  fieldId: string;
  /** The stored binding's archetype path, exactly as saved on the form -
   * what actually got checked against the current template. */
  path: string;
  issue: BindingAuditIssue;
  detail: string;
}

/** Checks a Form Section's own stored bindings against the CURRENT state of
 * its source template (a freshly re-imported WebTemplate tree, e.g. via
 * import_remote_template) rather than whatever the template looked like
 * when the Form Section was originally built or last regenerated.
 *
 * A binding is a snapshot, not a live reference - a template can change
 * (an archetype gets re-versioned, a value set gains/loses codes, a node's
 * RM type changes) with nothing to tell an existing Form Section it's now
 * stale, until a doctor's submission fails at EHRbase with a 4xx or -
 * worse, per the FLAT-composition group-binding bug fixed alongside this -
 * silently drops data instead of failing loudly at all. This surfaces that
 * drift proactively, at design/publish time, from the same information a
 * regeneration would use.
 *
 * Deliberately narrow in scope for what it flags: whether each binding's
 * path still resolves, whether its rmType still matches, whether a coded
 * field's stored options are still valid codes, and - added 2026-09-02,
 * see quantity-range-precision.test.js's sibling fix to validateOne, which
 * this complements - whether a DV_QUANTITY field's stored unit is still
 * offered at all (stale-unit) and whether it's missing a magnitude range/
 * precision limit the current template specifies for that unit
 * (missing-quantity-constraint). It does NOT attempt to detect "this field
 * should now be part of a repeatable group" -
 * webTemplateParser's own generator (generate_form_from_template/
 * apply_template_to_form) is the authoritative source for repeat structure
 * and already reflects a re-imported template correctly; re-deriving that
 * judgement independently here risked false positives the generator itself
 * doesn't have. */
export function auditFormBindings(definition: Pick<CanonicalForm, 'layout'>, webTemplateTree: unknown): BindingAuditFinding[] {
  const pathMap = buildOpenEhrPathMap(webTemplateTree);
  const findings: BindingAuditFinding[] = [];
  function walk(node: CanonicalForm['layout']): void {
    const binding = layoutFieldBinding(node.binding);
    // Same id/name gap as collectFieldBindings above - a name-only field
    // (i.e. most real fields, see that comment) reported every finding
    // under the useless label "(unnamed)" instead of its real field name.
    const fieldId = node.id || node.name || '(unnamed)';
    if (binding?.path) {
      const mapping = pathMap.get(binding.path);
      if (!mapping) {
        findings.push({ fieldId, path: binding.path, issue: 'unresolved-path', detail: `No node in the current template resolves this path anymore - the archetype was likely re-versioned or restructured since this binding was set.` });
      } else {
        if (binding.rmType && mapping.rmType && binding.rmType !== mapping.rmType) {
          findings.push({ fieldId, path: binding.path, issue: 'rmtype-mismatch', detail: `Form Section expects ${binding.rmType}, current template has ${mapping.rmType} at this path.` });
        }
        const rawOptions = (node as unknown as UnknownRecord).options;
        if (mapping.codes && Array.isArray(rawOptions)) {
          const staleValues = rawOptions
            .filter(isRecord)
            .map((option) => text(option.value))
            .filter((value): value is string => Boolean(value) && !mapping.codes!.includes(value!));
          if (staleValues.length > 0) {
            findings.push({ fieldId, path: binding.path, issue: 'stale-option', detail: `Option(s) ${staleValues.join(', ')} are no longer valid codes in the current template - EHRbase would reject a submission that picks one of them.` });
          }
        }
        const rawUnitOptions = (node as unknown as UnknownRecord).unitOptions;
        if (mapping.unitOptions && Array.isArray(rawUnitOptions)) {
          const currentByUnit = new Map(mapping.unitOptions.map((option) => [option.unit, option]));
          for (const stored of rawUnitOptions.filter(isRecord)) {
            const unit = text(stored.unit);
            if (!unit) continue;
            const current = currentByUnit.get(unit);
            if (!current) {
              findings.push({ fieldId, path: binding.path, issue: 'stale-unit', detail: `Unit '${unit}' is no longer offered for this quantity in the current template.` });
              continue;
            }
            // Only flags the archetype specifying a limit this field's
            // stored option doesn't have at all - never a numeric
            // mismatch between two present values, which could just as
            // easily be an intentional narrower limit the form designer
            // chose on purpose. This deliberately stays a soft nudge
            // ("re-apply the template to pick this up"), matching
            // validateOne's own range/precision checks being warnings,
            // not hard failures, for the exact same reason: a lot of
            // already-built fields predate this extraction existing at
            // all (see formGenerator.ts/webTemplateParser.ts's sibling
            // fix) and were never wrong, just incomplete.
            const missing: string[] = [];
            if (current.min !== undefined && stored.min === undefined) missing.push(`min ${current.min}`);
            if (current.max !== undefined && stored.max === undefined) missing.push(`max ${current.max}`);
            if (current.precision !== undefined && stored.precision === undefined) missing.push(`precision ${current.precision}`);
            if (missing.length > 0) {
              findings.push({ fieldId, path: binding.path, issue: 'missing-quantity-constraint', detail: `Unit '${unit}' has ${missing.join(', ')} in the current template that this field's stored unitOptions doesn't carry yet - re-apply the template (apply_template_to_form) to pick it up.` });
            }
          }
        }
      }
    }
    node.children?.forEach(walk);
  }
  walk(definition.layout);
  return findings;
}
