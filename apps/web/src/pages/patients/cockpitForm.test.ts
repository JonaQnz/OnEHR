import { describe, expect, it } from 'vitest';
import { LEGACY_COCKPIT_FORM_NAME, resolveCockpitForm } from './cockpitForm';

interface Candidate {
  id: string;
  parent_id?: string | null;
  name: string;
}

const cockpitOnLine = (lineId: string, id = 'form-1'): Candidate => ({ id, parent_id: lineId, name: 'Cockpit Variante' });

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
