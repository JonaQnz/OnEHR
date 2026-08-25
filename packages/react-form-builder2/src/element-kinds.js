/**
 * Single source of truth for "what kind of thing is this builder element",
 * used to decide which Field Config sections actually make sense for it.
 *
 * Before this existed, each inspector section carried its own ad-hoc list
 * of excluded/included `element` strings (e.g. Behavior only excluded
 * Header/Paragraph/LineBreak, so it still showed "Required"/"Hidden by
 * default" for layout Rows and Buttons; Choices was gated purely on
 * `element.options` being truthy, which a freshly-dragged non-option
 * element can still have as a stray empty array). Those lists drift
 * independently and are easy to forget to update - two real bugs (the
 * dead "Hidden by default" toggle, unusable Header/Paragraph text) came
 * from exactly this pattern. Centralizing the classification here means
 * every section asks the same question the same way.
 */

/** Carries a real openEHR-bound value the user fills in. */
export const VALUE_FIELD_ELEMENTS = [
  'TextInput', 'TextArea', 'NumberInput', 'Dropdown', 'Checkboxes', 'RadioButtons',
  'DatePicker', 'Range', 'Rating', 'Tags', 'Signature', 'Camera', 'FileUpload', 'CustomElement',
];

/** Static content - renders fixed text/markup, never carries a value. */
export const STATIC_CONTENT_ELEMENTS = ['Header', 'Paragraph', 'LineBreak'];

/** Structural containers - group/arrange other elements, no value of their own. */
export const STRUCTURAL_ELEMENTS = ['FieldSet', 'TwoColumnRow', 'ThreeColumnRow', 'MultiColumnRow'];

/** Triggers an action - nothing to store, require, or prefill. */
export const ACTION_ELEMENTS = ['Button', 'HyperLink'];

/** Elements whose `options` array (the Choices section) is meaningful. */
export const OPTION_ELEMENTS = ['Dropdown', 'Checkboxes', 'RadioButtons', 'Tags'];

export function isValueFieldElement(element) { return VALUE_FIELD_ELEMENTS.includes(element); }
export function isStaticContentElement(element) { return STATIC_CONTENT_ELEMENTS.includes(element); }
export function isStructuralElement(element) { return STRUCTURAL_ELEMENTS.includes(element); }
export function isActionElement(element) { return ACTION_ELEMENTS.includes(element); }
export function elementHasOptions(element) { return OPTION_ELEMENTS.includes(element); }
