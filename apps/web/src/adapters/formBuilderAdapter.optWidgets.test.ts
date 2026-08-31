import { describe, expect, it } from 'vitest';
import { canonicalToFormBuilder, formBuilderToCanonical } from './formBuilderAdapter';

// react-form-builder2 (the vendored canvas library) has no native palette
// entry for the OPT constraint engine's CodedWithOther/Autocomplete runtime
// widgets - canonicalToFormBuilder previews such a field as a plain
// 'Dropdown' in the design canvas, but must stash the real uiElement in
// custom_metadata so a round-trip through the designer (open -> save,
// without ever touching that field) doesn't silently downgrade it back to
// literally 'Dropdown'. See the matching comments in formBuilderAdapter.ts.

function formWith(uiElement: string, allowFreeText: boolean) {
  return {
    id: 'diag-form', name: 'Diagnose', version: '1.0.0',
    sourceTemplates: [{ alias: 'diag', id: 'diag.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} },
    bindings: {},
    layout: {
      type: 'form',
      children: [{
        id: 'severity', type: 'input-select', name: 'severity', label: 'Schweregrad', uiElement,
        binding: { templateAlias: 'diag', path: '/content/data/items[at0005]', rmType: 'DV_CODED_TEXT' },
        options: [{ value: 'at0047', text: 'Leicht' }, { value: 'at0048', text: 'Mäßig' }],
        ...(allowFreeText ? { allowFreeText: true } : {}),
      }],
    },
  } as any;
}

describe('formBuilderAdapter: CodedWithOther/Autocomplete survive a canvas round-trip', () => {
  it('CodedWithOther previews as a plain Dropdown item in the canvas (element), but keeps the real widget in custom_metadata.uiElement', () => {
    const items = canonicalToFormBuilder(formWith('CodedWithOther', true));
    const item = items.find((candidate) => candidate.field_name === 'severity');
    expect(item.element).toBe('Dropdown');
    expect(item.custom_metadata.uiElement).toBe('CodedWithOther');
    expect(item.custom_metadata.allowFreeText).toBe(true);
  });

  it('converting the canvas items straight back to canonical (no edits) restores the true uiElement, not the Dropdown stand-in', () => {
    const original = formWith('CodedWithOther', true);
    const items = canonicalToFormBuilder(original);
    const roundtripped = formBuilderToCanonical(items, original);
    // formBuilderToCanonical wraps the flat item list back into a
    // container - the leaf field itself is one level deeper than
    // layout.children[0].
    const field = (roundtripped.layout as any).children[0].children[0];
    expect(field.uiElement).toBe('CodedWithOther');
    expect(field.allowFreeText).toBe(true);
  });

  it('same round-trip for Autocomplete', () => {
    const original = formWith('Autocomplete', false);
    const items = canonicalToFormBuilder(original);
    const item = items.find((candidate) => candidate.field_name === 'severity');
    expect(item.element).toBe('Dropdown');
    expect(item.custom_metadata.uiElement).toBe('Autocomplete');

    const roundtripped = formBuilderToCanonical(items, original);
    expect((roundtripped.layout as any).children[0].children[0].uiElement).toBe('Autocomplete');
  });

  it('an ordinary RadioButtons/Dropdown field is unaffected - no custom_metadata.uiElement stashed, canvas element matches directly', () => {
    const original = formWith('RadioButtons', false);
    const items = canonicalToFormBuilder(original);
    const item = items.find((candidate) => candidate.field_name === 'severity');
    expect(item.element).toBe('RadioButtons');
    expect(item.custom_metadata.uiElement).toBeUndefined();

    const roundtripped = formBuilderToCanonical(items, original);
    expect((roundtripped.layout as any).children[0].children[0].uiElement).toBe('RadioButtons');
  });
});
