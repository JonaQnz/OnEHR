/**
 * "Form Designer: automatischer Renderer" (OPT constraint engine
 * architecture, section 19) - derives a DEFAULT widget suggestion purely
 * from a field's own `valueConstraints`/`occurrences`, never from any
 * template-specific knowledge. This is presentation-layer logic that
 * operates entirely on the neutral constraint model - it never looks at an
 * OPT/WebTemplate node directly, and the semantic openEHR type it derived
 * from is unaffected by whatever a designer later overrides this default
 * to (see `sourceConstraint` vs `presentationConfig` in the architecture
 * doc's "Source of Truth und Designer Overrides" section - this function
 * only ever produces the initial presentationConfig.widget default, never
 * the sourceConstraint).
 *
 * The concrete size/openness thresholds (2-4 -> radio, 5-50 -> select,
 * beyond/external -> autocomplete) are exactly the ones the architecture
 * doc's own rule table specifies.
 */
import type { OpenEhrFieldDefinition, ValueConstraint } from './index';

export type WidgetKind =
  | 'text'
  | 'textarea'
  | 'date'
  | 'time'
  | 'date-time'
  | 'duration'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'autocomplete'
  | 'coded-choice-with-other'
  | 'number'
  | 'quantity';

export interface WidgetSuggestion {
  widget: WidgetKind;
  /** True when occurrences allow more than one value (max === null or > 1)
   * - the field needs a repeatable/"+ hinzufügen" wrapper around whichever
   * `widget` is chosen, independent of what that widget is. */
  repeatable: boolean;
}

function findConstraint<T extends ValueConstraint['rmType']>(constraints: ValueConstraint[], rmType: T): (ValueConstraint & { rmType: T }) | undefined {
  return constraints.find((c) => c.rmType === rmType) as (ValueConstraint & { rmType: T }) | undefined;
}

function codedTextWidget(constraint: Extract<ValueConstraint, { rmType: 'DV_CODED_TEXT' }>): WidgetKind {
  const options = constraint.options || [];
  // A field with no enumerable local list at all, or a non-local
  // terminology (e.g. bound to an external code system with far too many
  // values to list), is exactly the "large/external terminology" case the
  // architecture doc calls out for search/autocomplete - a local value set
  // with 2-50 concrete options is the only case a closed radio/select makes
  // sense for.
  if (options.length === 0 || (constraint.terminologyId && constraint.terminologyId !== 'local')) return 'autocomplete';
  if (options.length <= 4) return 'radio';
  if (options.length <= 50) return 'select';
  return 'autocomplete';
}

/** Suggests a default widget for one field, from its constraint model alone. */
export function deriveDefaultWidget(field: Pick<OpenEhrFieldDefinition, 'valueConstraints' | 'occurrences'>): WidgetSuggestion {
  const { valueConstraints, occurrences } = field;
  const repeatable = occurrences.max === null || occurrences.max > 1;
  const codedText = findConstraint(valueConstraints, 'DV_CODED_TEXT');
  const hasFreeTextAlternative = valueConstraints.some((c) => c.rmType === 'DV_TEXT') && codedText;
  const boolean = findConstraint(valueConstraints, 'DV_BOOLEAN');

  if (hasFreeTextAlternative) return { widget: 'coded-choice-with-other', repeatable };
  if (codedText) return { widget: codedTextWidget(codedText), repeatable };
  if (boolean) return { widget: 'checkbox', repeatable };
  if (findConstraint(valueConstraints, 'DV_DATE_TIME')) return { widget: 'date-time', repeatable };
  if (findConstraint(valueConstraints, 'DV_DATE')) return { widget: 'date', repeatable };
  if (findConstraint(valueConstraints, 'DV_TIME')) return { widget: 'time', repeatable };
  if (findConstraint(valueConstraints, 'DV_DURATION')) return { widget: 'duration', repeatable };
  if (findConstraint(valueConstraints, 'DV_COUNT')) return { widget: 'number', repeatable };
  if (findConstraint(valueConstraints, 'DV_QUANTITY')) return { widget: 'quantity', repeatable };
  if (findConstraint(valueConstraints, 'DV_TEXT')) return { widget: 'text', repeatable };
  // An ordinal/identifier/uri/unsupported/empty constraint list still needs
  // *some* default rather than throwing - text is the safest fallback (an
  // editable string a clinician can see and correct), never silently
  // dropped. A field this generic should also have ended up with
  // parsingStatus 'partial' upstream (see buildConstraintModelFromWebTemplate),
  // so this fallback is a last resort, not the normal path.
  return { widget: 'text', repeatable };
}
