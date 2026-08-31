import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FormRuntime from './FormRuntime';

// Covers the DV_TEXT.mappings runtime UX (see docs/features/dv-text-code-mappings.md):
// a codeMappings.enabled field renders its plain text input unchanged, plus
// an extensible "+ Code hinzufügen" area for attaching one or more
// terminology codes (openEHR RM: TERM_MAPPING) without ever showing a
// visible terminology catalog - the clinician only ever sees the
// designer-configured terminology label(s) and a manual code input.

const DEFINITION_SINGLE_TERMINOLOGY = {
  id: 'diag-form', name: 'Diagnose', version: '1.0.0',
  sourceTemplates: [{ alias: 'diag', id: 'diag.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
  locales: { en: {} },
  bindings: {},
  layout: {
    type: 'form',
    children: [{
      id: 'diagnosis_name', type: 'input-text', label: 'Diagnosename', required: false,
      binding: { templateAlias: 'diag', path: '/content/data/items[at0002]', rmType: 'DV_TEXT' },
      codeMappings: { enabled: true, terminologies: [{ id: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', label: 'ICD-10-GM' }] },
    }],
  },
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FormRuntime codeMappings', () => {
  it('renders the plain text input with no mapping rows and no visible terminology catalog until "+ Code hinzufügen" is clicked', async () => {
    render(<FormRuntime definition={DEFINITION_SINGLE_TERMINOLOGY as any} showSubmit={false} showHeader={false} />);
    expect(screen.getByText('Diagnosename')).toBeInTheDocument();
    expect(document.querySelectorAll('input[type="text"]')).toHaveLength(1);
    expect(screen.queryByPlaceholderText('Code')).not.toBeInTheDocument();
    expect(screen.getByText(/\+ Code hinzufügen/i)).toBeInTheDocument();
    // The terminology's own id (a raw, not-meant-for-clinicians string) is
    // never shown anywhere before a mapping is added - "Katalog hidden".
    expect(screen.queryByText('http://fhir.de/CodeSystem/dimdi/icd-10-gm')).not.toBeInTheDocument();
  });

  it('adding a code mapping keeps the text value intact and reports {value, mappings} via onValuesChange', async () => {
    const onValuesChange = vi.fn();
    render(<FormRuntime definition={DEFINITION_SINGLE_TERMINOLOGY as any} showSubmit={false} showHeader={false} onValuesChange={onValuesChange} />);

    const textInputs = document.querySelectorAll('input[type="text"]');
    fireEvent.change(textInputs[0], { target: { value: 'Diagnose Text' } });
    await waitFor(() => expect(onValuesChange).toHaveBeenCalledWith(expect.objectContaining({ diagnosis_name: { value: 'Diagnose Text' } })));

    fireEvent.click(screen.getByText(/\+ Code hinzufügen/i));
    const codeInput = await screen.findByPlaceholderText('Code');
    fireEvent.change(codeInput, { target: { value: 'F16.0' } });

    await waitFor(() => {
      const lastCall = onValuesChange.mock.calls.at(-1)?.[0];
      expect(lastCall.diagnosis_name).toEqual({
        value: 'Diagnose Text',
        mappings: [{ terminologyId: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', code: 'F16.0' }],
      });
    });
    // The designer-configured terminology label shows once a mapping exists.
    expect(screen.getByText('ICD-10-GM')).toBeInTheDocument();
  });

  it('removing a mapping row drops it from the value entirely, back to a bare {value}', async () => {
    const onValuesChange = vi.fn();
    render(<FormRuntime definition={DEFINITION_SINGLE_TERMINOLOGY as any} initialValues={{ diagnosis_name: { value: 'Diagnose', mappings: [{ terminologyId: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', code: 'F16.0' }] } }} showSubmit={false} showHeader={false} onValuesChange={onValuesChange} />);
    expect(screen.getByDisplayValue('F16.0')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Zuordnung entfernen'));
    await waitFor(() => {
      const lastCall = onValuesChange.mock.calls.at(-1)?.[0];
      expect(lastCall.diagnosis_name).toEqual({ value: 'Diagnose' });
    });
  });

  it('allowMultiple: false caps the field at exactly one mapping - the add control disappears once one exists', async () => {
    const definition = {
      ...DEFINITION_SINGLE_TERMINOLOGY,
      layout: {
        type: 'form',
        children: [{
          ...DEFINITION_SINGLE_TERMINOLOGY.layout.children[0],
          codeMappings: { ...DEFINITION_SINGLE_TERMINOLOGY.layout.children[0].codeMappings, allowMultiple: false },
        }],
      },
    };
    render(<FormRuntime definition={definition as any} initialValues={{ diagnosis_name: { value: 'Diagnose', mappings: [{ terminologyId: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', code: 'F16.0' }] } }} showSubmit={false} showHeader={false} />);
    expect(screen.queryByText(/\+ Code hinzufügen/i)).not.toBeInTheDocument();
  });

  it('multiple configured terminologies offer a picker per mapping row, and a new mapping defaults to the first terminology', async () => {
    const definition = {
      ...DEFINITION_SINGLE_TERMINOLOGY,
      layout: {
        type: 'form',
        children: [{
          ...DEFINITION_SINGLE_TERMINOLOGY.layout.children[0],
          codeMappings: {
            enabled: true, allowMultiple: true,
            terminologies: [
              { id: 'icd10gm', label: 'ICD-10-GM' },
              { id: 'snomed', label: 'SNOMED CT', match: '?' },
            ],
          },
        }],
      },
    };
    render(<FormRuntime definition={definition as any} initialValues={{ diagnosis_name: 'Diagnose' }} showSubmit={false} showHeader={false} />);
    fireEvent.click(screen.getByText(/\+ Code hinzufügen/i));
    const select = await screen.findByRole('combobox');
    expect(select).toHaveValue('icd10gm');
    expect(screen.getByRole('option', { name: 'SNOMED CT' })).toBeInTheDocument();
  });

  it('a codeMappings-disabled DV_TEXT field renders the plain original input, no mapping UI at all', () => {
    const definition = {
      ...DEFINITION_SINGLE_TERMINOLOGY,
      layout: { type: 'form', children: [{ id: 'notes', type: 'input-text', label: 'Notizen', binding: { templateAlias: 'diag', path: '/content/data/items[at0009]', rmType: 'DV_TEXT' } }] },
    };
    render(<FormRuntime definition={definition as any} showSubmit={false} showHeader={false} />);
    expect(screen.queryByText(/Code hinzufügen/i)).not.toBeInTheDocument();
  });
});
