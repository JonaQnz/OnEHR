import { describe, expect, it } from 'vitest';
import { LEGACY_COCKPIT_FORM_NAME, resolveCockpitForm } from './cockpitForm';
import * as cockpitFormModule from './cockpitForm';

interface Candidate {
  id: string;
  parent_id?: string | null;
  name: string;
}

const cockpitOnLine = (lineId: string, id = 'form-1'): Candidate => ({ id, parent_id: lineId, name: 'Cockpit Variante' });

type SelectCockpitForm = <T extends Candidate>(forms: T[], setting: string | null | undefined) => T | undefined;

/**
 * selectCockpitForm is the new public seam: unresolved while the
 * runtime-defaults setting has not loaded, unresolved after it failed, legacy
 * name match only for an empty configured setting, configured line id wins
 * exclusively. Reading it through the module namespace (instead of a named
 * import that would break the whole file at link time before the fix) keeps
 * the existing resolveCockpitForm tests running and makes each selectCockpitForm
 * test fail with this explicit message until the export exists.
 */
function selectCockpitForm<T extends Candidate>(forms: T[], setting: string | null | undefined): T | undefined {
  const select = (cockpitFormModule as unknown as { selectCockpitForm?: SelectCockpitForm }).selectCockpitForm;
  if (!select) throw new Error('cockpitForm.ts does not export selectCockpitForm');
  return select(forms, setting);
}

describe('resolveCockpitForm', () => {
  it('matches a configured line id against parent_id', () => {
    const forms = [cockpitOnLine('line-a'), cockpitOnLine('line-b', 'form-2')];
    expect(resolveCockpitForm(forms, 'line-b')?.id).toBe('form-2');
  });

  it('matches the configured line id against the form id when parent_id is null', () => {
    const forms: Candidate[] = [{ id: 'line-a', parent_id: null, name: 'Cockpit Variante' }];
    expect(resolveCockpitForm(forms, 'line-a')?.id).toBe('line-a');
  });

  it('ignores a same-named form from another line when a line id is configured', () => {
    const forms: Candidate[] = [{ id: 'form-x', parent_id: 'other-line', name: LEGACY_COCKPIT_FORM_NAME }];
    expect(resolveCockpitForm(forms, 'configured-line')).toBeUndefined();
  });

  it('falls back to the legacy name when the configured id is empty or whitespace', () => {
    const forms: Candidate[] = [{ id: 'form-1', parent_id: 'line-a', name: LEGACY_COCKPIT_FORM_NAME }];
    expect(resolveCockpitForm(forms, '')?.id).toBe('form-1');
    expect(resolveCockpitForm(forms, '   ')?.id).toBe('form-1');
    expect(resolveCockpitForm(forms, undefined)?.id).toBe('form-1');
    expect(resolveCockpitForm(forms, null)?.id).toBe('form-1');
  });

  it('returns undefined when nothing matches', () => {
    const forms: Candidate[] = [{ id: 'form-1', parent_id: 'line-a', name: 'Andere Form' }];
    expect(resolveCockpitForm(forms, 'line-b')).toBeUndefined();
    expect(resolveCockpitForm(forms)).toBeUndefined();
  });
});

describe('selectCockpitForm', () => {
  const legacyOnLineA: Candidate = { id: 'legacy-1', parent_id: 'line-a', name: LEGACY_COCKPIT_FORM_NAME };
  const cockpitOnLineB: Candidate = { id: 'cockpit-b-1', parent_id: 'line-b', name: 'Cockpit B' };
  const forms = [legacyOnLineA, cockpitOnLineB];

  it('resolves nothing while the setting has not loaded', () => {
    expect(selectCockpitForm(forms, undefined)).toBeUndefined();
  });

  it('resolves nothing after the setting failed to load', () => {
    expect(selectCockpitForm(forms, null)).toBeUndefined();
  });

  it('falls back to the legacy name only when the setting loaded empty', () => {
    expect(selectCockpitForm(forms, '')?.id).toBe('legacy-1');
  });

  it('prefers the configured line id over the legacy-named form on another line', () => {
    expect(selectCockpitForm(forms, 'line-b')?.id).toBe('cockpit-b-1');
  });
});
