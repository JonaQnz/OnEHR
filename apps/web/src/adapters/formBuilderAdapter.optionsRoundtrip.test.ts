import { describe, expect, it } from 'vitest';
import { canonicalToFormBuilder, formBuilderToCanonical } from './formBuilderAdapter';

// Live bug (2026-09-09): "Diagnose (Basis)" v1.13.0 - simply opening the
// form in the Designer and saving a new draft (no field edits at all)
// caused EHRbase to reject the next submission with "DV_CODED_TEXT/value
// does not match. expected: Working; found: In Bearbeitung". Root cause:
// canonicalToFormBuilder's load path spreads `...opt` (preserving
// FormElementLayout.options[]'s archetype-sourced sidecar fields -
// rmValue, terminology, ordinalValue - see their doc comments in
// packages/core/src/canonical/index.ts), but formBuilderToCanonical's save
// path only picked {value, text, key} back out, silently discarding
// rmValue/terminology/ordinalValue on every single save
// (react-form-builder2's onPost fires with saveAlways={true}, so this hit
// even a pure open->save with zero user edits). EHRbase's FLAT validator
// checks DV_CODED_TEXT.value against rmValue (the archetype's
// original-language term) regardless of the canvas/runtime UI's preferred
// (German) display language - once rmValue is gone, openehr-engine's
// buildLeafDvValue falls back to the German `text`, which EHRbase rejects.

function formWith(options: any[]) {
  return {
    id: 'diag-form', name: 'Diagnose', version: '1.0.0',
    sourceTemplates: [{ alias: 'diag', id: 'diag.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    locales: { en: {} },
    bindings: {},
    layout: {
      type: 'form',
      children: [{
        id: 'diagnosestatus', type: 'input-select', name: 'diagnosestatus', label: 'Diagnosestatus', uiElement: 'Dropdown',
        binding: { templateAlias: 'diag', path: '/content/data/items[at0004]', rmType: 'DV_CODED_TEXT' },
        options,
      }],
    },
  } as any;
}

describe('formBuilderAdapter: option sidecar fields (rmValue/terminology/ordinalValue) survive a canvas round-trip', () => {
  it('a pure open->save with zero edits keeps rmValue - openEHR write path needs it, not the German canvas label', () => {
    const original = formWith([
      { value: 'at0016', text: 'Vorläufig', rmValue: 'Preliminary' },
      { value: 'at0017', text: 'In Bearbeitung', rmValue: 'Working' },
      { value: 'at0018', text: 'Gesichert', rmValue: 'Established' },
      { value: 'at0088', text: 'Verworfen', rmValue: 'Refuted' },
    ]);
    const items = canonicalToFormBuilder(original);
    // Nothing about the items is touched here - this is exactly what
    // handleSave does on a no-op autosave triggered by simply opening the
    // Designer canvas.
    const roundtripped = formBuilderToCanonical(items, original);
    const field = (roundtripped.layout as any).children[0].children[0];
    expect(field.options.map((o: any) => o.rmValue)).toEqual(['Preliminary', 'Working', 'Established', 'Refuted']);
    // The German label itself must still survive too, obviously.
    expect(field.options.map((o: any) => o.text)).toEqual(['Vorläufig', 'In Bearbeitung', 'Gesichert', 'Verworfen']);
  });

  it('also preserves terminology (external terminology_id) and ordinalValue (DV_ORDINAL) the same way', () => {
    const original = formWith([
      { value: 'at0026', text: 'Aktiv', rmValue: 'Active', terminology: 'https://hip.vitagroup.ag/sid/some-valueset', ordinalValue: 1 },
      { value: 'at0027', text: 'Inaktiv', rmValue: 'Inactive', terminology: 'https://hip.vitagroup.ag/sid/some-valueset', ordinalValue: 2 },
    ]);
    const items = canonicalToFormBuilder(original);
    const roundtripped = formBuilderToCanonical(items, original);
    const field = (roundtripped.layout as any).children[0].children[0];
    expect(field.options[0]).toMatchObject({ terminology: 'https://hip.vitagroup.ag/sid/some-valueset', ordinalValue: 1 });
    expect(field.options[1]).toMatchObject({ terminology: 'https://hip.vitagroup.ag/sid/some-valueset', ordinalValue: 2 });
  });

  it('an option missing rmValue entirely (e.g. an English-default template where rmValue === text) still round-trips cleanly with no rmValue fabricated', () => {
    const original = formWith([{ value: 'at0001', text: 'Active' }]);
    const items = canonicalToFormBuilder(original);
    const roundtripped = formBuilderToCanonical(items, original);
    const field = (roundtripped.layout as any).children[0].children[0];
    expect(field.options[0].rmValue).toBeUndefined();
    expect(field.options[0].text).toBe('Active');
  });
});
