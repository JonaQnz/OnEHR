/**
 * "Runtime-State typisieren" / "Serialisierung" (OPT constraint engine
 * architecture, sections 22-24) - builds a typed `RuntimeOpenEhrValue`
 * (packages/core/src/openehr-constraint) from one already-selected
 * `ValueConstraint` and a raw UI input, and maps it to/from RM JSON.
 *
 * Deliberately additive and NOT wired into the live submit path yet
 * (toOpenEhrFlatComposition/buildCanonicalComposition in this same package
 * are untouched) - this is new, independently tested code demonstrating the
 * "typed runtime value, dumb deterministic serializer" architecture the
 * task calls for. Swapping the live write path over to it is a separate,
 * deliberately-not-yet-taken step (see docs/features/opt-constraint-engine-analysis.md) -
 * that write path has already been the source of several real, silent bugs
 * this session (the DV_QUANTITY unit/units mixup, the DV_CODED_TEXT
 * defining_code+mappings gap), so replacing it warrants its own dedicated,
 * carefully regression-tested pass rather than a rushed swap here.
 *
 * `buildRuntimeValue` takes exactly ONE constraint (the caller/UI has
 * already resolved which alternative of a DV_CODED_TEXT|DV_TEXT union - or
 * DV_BOOLEAN|DV_CODED_TEXT union - the user actually picked, e.g. by which
 * control they interacted with) - this function never guesses between
 * alternatives itself.
 */
import type { CodedTextOption, DvCodedTextConstraint, RuntimeOpenEhrValue, ValueConstraint } from 'core';

export class RuntimeValueError extends Error {}

function findOption(options: CodedTextOption[] | undefined, code: string): CodedTextOption | undefined {
  return options?.find((option) => option.codeString === code);
}

/** Builds a typed runtime value for one constraint from a raw UI input.
 * `raw` shape depends on the constraint's rmType:
 *  - DV_TEXT: a string
 *  - DV_CODED_TEXT: a code string (looked up in constraint.options for its
 *    display text), or `{ code, text }` to supply the text explicitly for a
 *    code not in the enumerated list (open-ended/free-entry terminology)
 *  - DV_BOOLEAN: a boolean
 *  - DV_DATE / DV_TIME / DV_DATE_TIME: an ISO string
 *  - DV_COUNT: a number
 *  - DV_QUANTITY: `{ magnitude, units }`
 * Throws RuntimeValueError (never silently returns something structurally
 * invalid) when the raw input's shape doesn't fit the constraint, or a
 * DV_CODED_TEXT code isn't in a *closed* (non-open-ended) option list -
 * this is the "Validierung... akzeptiert Schweregrad at0047/48/49, aber
 * nicht at0064" rule from the architecture doc, enforced right where the
 * runtime value is built, not left to the serializer to discover later. */
export function buildRuntimeValue(constraint: ValueConstraint, raw: unknown): RuntimeOpenEhrValue {
  switch (constraint.rmType) {
    case 'DV_TEXT': {
      if (typeof raw !== 'string') throw new RuntimeValueError('DV_TEXT requires a string value');
      return { _type: 'DV_TEXT', value: raw };
    }
    case 'DV_CODED_TEXT': {
      if ('unsupported' in constraint) throw new RuntimeValueError("No runtime-value builder for constraint type 'DV_CODED_TEXT' (unsupported variant)");
      return buildCodedTextValue(constraint, raw);
    }
    case 'DV_BOOLEAN': {
      if (typeof raw !== 'boolean') throw new RuntimeValueError('DV_BOOLEAN requires a boolean value');
      return { _type: 'DV_BOOLEAN', value: raw };
    }
    case 'DV_DATE_TIME': {
      if (typeof raw !== 'string') throw new RuntimeValueError('DV_DATE_TIME requires an ISO string value');
      return { _type: 'DV_DATE_TIME', value: raw };
    }
    case 'DV_DATE': {
      if (typeof raw !== 'string') throw new RuntimeValueError('DV_DATE requires an ISO string value');
      return { _type: 'DV_DATE', value: raw };
    }
    case 'DV_TIME': {
      if (typeof raw !== 'string') throw new RuntimeValueError('DV_TIME requires an ISO string value');
      return { _type: 'DV_TIME', value: raw };
    }
    case 'DV_COUNT': {
      if (typeof raw !== 'number') throw new RuntimeValueError('DV_COUNT requires a numeric value');
      return { _type: 'DV_COUNT', value: raw };
    }
    case 'DV_QUANTITY': {
      if (!raw || typeof raw !== 'object' || typeof (raw as { magnitude?: unknown }).magnitude !== 'number' || typeof (raw as { units?: unknown }).units !== 'string') {
        throw new RuntimeValueError('DV_QUANTITY requires { magnitude: number, units: string }');
      }
      const { magnitude, units } = raw as { magnitude: number; units: string };
      return { _type: 'DV_QUANTITY', magnitude, units };
    }
    default:
      throw new RuntimeValueError(`No runtime-value builder for constraint type '${constraint.rmType}' - either unsupported, or the caller picked the wrong constraint from a union`);
  }
}

// Whether a constraint's list is closed enough to validate against - true
// for any LOCAL terminology that actually enumerates options. `openEnded`
// (the WebTemplate `listOpen` flag) is NOT used for this: confirmed against
// real data that a strictly local, fully-enumerated, closed value set (e.g.
// severity's at0047/48/49) is still flagged listOpen:true in the WebTemplate
// export - what that flag actually signals is "a free-text alternative also
// exists on this element" (already captured by a sibling DV_TEXT
// ValueConstraint), not "any code is acceptable here". Scope validation
// (section 25 of the architecture doc: severity accepts at0047/48/49, NOT
// at0064 even though at0064 is a real code elsewhere in the same template)
// must hold regardless of listOpen for a local, enumerated list - only a
// genuinely external/non-local terminology, or a field with no enumerable
// options at all, is treated as open.
function isClosedLocalList(constraint: DvCodedTextConstraint): boolean {
  const terminologyId = constraint.terminologyId || 'local';
  return terminologyId === 'local' && Boolean(constraint.options && constraint.options.length > 0);
}

function buildCodedTextValue(constraint: DvCodedTextConstraint, raw: unknown): RuntimeOpenEhrValue {
  const terminologyId = constraint.terminologyId || 'local';
  const closed = isClosedLocalList(constraint);
  if (typeof raw === 'string') {
    const option = findOption(constraint.options, raw);
    if (!option && closed) {
      throw new RuntimeValueError(`Code '${raw}' is not in this field's closed value set (terminology '${terminologyId}') - scope is per-field, a code valid elsewhere in the template is not automatically valid here`);
    }
    return { _type: 'DV_CODED_TEXT', value: option?.text ?? raw, defining_code: { terminology_id: { value: terminologyId }, code_string: raw } };
  }
  if (raw && typeof raw === 'object' && typeof (raw as { code?: unknown }).code === 'string') {
    const { code, text } = raw as { code: string; text?: string };
    const option = findOption(constraint.options, code);
    if (!option && closed) {
      throw new RuntimeValueError(`Code '${code}' is not in this field's closed value set (terminology '${terminologyId}')`);
    }
    return { _type: 'DV_CODED_TEXT', value: text ?? option?.text ?? code, defining_code: { terminology_id: { value: terminologyId }, code_string: code } };
  }
  throw new RuntimeValueError('DV_CODED_TEXT requires a code string, or { code, text }');
}

/** Maps a typed runtime value to the RM JSON shape actually written to
 * EHRbase. Deliberately trivial (near-identity) - RuntimeOpenEhrValue is
 * already defined in the RM's own wire shape (see the architecture doc's
 * "damit ist der Serializer möglichst dumm und deterministisch"); the one
 * job left here is validating the shape is actually well-formed before it
 * goes anywhere near the wire, not re-deriving any of its content. */
export function serializeRuntimeValue(value: RuntimeOpenEhrValue): Record<string, unknown> {
  if (!value || typeof value !== 'object' || typeof (value as { _type?: unknown })._type !== 'string') {
    throw new RuntimeValueError('Not a valid RuntimeOpenEhrValue: missing _type');
  }
  return value as unknown as Record<string, unknown>;
}

/** The inverse of serializeRuntimeValue - reconstructs a typed
 * RuntimeOpenEhrValue from RM JSON (e.g. re-loaded from EHRbase). Used by
 * the roundtrip tests, and by anything that needs to re-hydrate a
 * previously-submitted value into the same typed shape the runtime layer
 * uses elsewhere. */
export function deserializeRuntimeValue(rm: unknown): RuntimeOpenEhrValue {
  if (!rm || typeof rm !== 'object' || typeof (rm as { _type?: unknown })._type !== 'string') {
    throw new RuntimeValueError('Not valid openEHR RM JSON: missing _type');
  }
  const type = (rm as { _type: string })._type;
  switch (type) {
    case 'DV_TEXT': {
      const value = (rm as { value?: unknown }).value;
      if (typeof value !== 'string') throw new RuntimeValueError('DV_TEXT.value must be a string');
      return { _type: 'DV_TEXT', value };
    }
    case 'DV_CODED_TEXT': {
      const value = (rm as { value?: unknown }).value;
      const definingCode = (rm as { defining_code?: { terminology_id?: { value?: unknown }; code_string?: unknown } }).defining_code;
      const terminologyId = definingCode?.terminology_id?.value;
      const codeString = definingCode?.code_string;
      if (typeof value !== 'string' || typeof terminologyId !== 'string' || typeof codeString !== 'string') {
        throw new RuntimeValueError('DV_CODED_TEXT requires value + defining_code.terminology_id.value + defining_code.code_string');
      }
      return { _type: 'DV_CODED_TEXT', value, defining_code: { terminology_id: { value: terminologyId }, code_string: codeString } };
    }
    case 'DV_BOOLEAN': {
      const value = (rm as { value?: unknown }).value;
      if (typeof value !== 'boolean') throw new RuntimeValueError('DV_BOOLEAN.value must be a boolean');
      return { _type: 'DV_BOOLEAN', value };
    }
    case 'DV_DATE_TIME':
    case 'DV_DATE':
    case 'DV_TIME': {
      const value = (rm as { value?: unknown }).value;
      if (typeof value !== 'string') throw new RuntimeValueError(`${type}.value must be a string`);
      return { _type: type, value } as RuntimeOpenEhrValue;
    }
    case 'DV_COUNT': {
      const value = (rm as { value?: unknown }).value;
      if (typeof value !== 'number') throw new RuntimeValueError('DV_COUNT.value must be a number');
      return { _type: 'DV_COUNT', value };
    }
    case 'DV_QUANTITY': {
      const magnitude = (rm as { magnitude?: unknown }).magnitude;
      const units = (rm as { units?: unknown }).units;
      if (typeof magnitude !== 'number' || typeof units !== 'string') throw new RuntimeValueError('DV_QUANTITY requires magnitude: number, units: string');
      return { _type: 'DV_QUANTITY', magnitude, units };
    }
    default:
      throw new RuntimeValueError(`Unsupported RM type for deserialization: '${type}'`);
  }
}
